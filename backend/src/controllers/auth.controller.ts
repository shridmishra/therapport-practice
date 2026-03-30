import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { FileService } from '../services/file.service';
import { z, ZodError } from 'zod';
import type { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../config/database';
import { users, memberships } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.util';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '../config/r2';
import { processBase64Image } from '../utils/image.util';
import { recurringSlotSchema } from '../schemas/auth.schemas';

const registerSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  membershipType: z.enum(['permanent', 'ad_hoc']),
  marketingAddon: z.boolean(),
  recurringSlot: recurringSlotSchema.optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const changeEmailSchema = z.object({
  newEmail: z.string().email(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(50).optional(),
  nextOfKin: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    })
    .optional(),
});

const photoUploadUrlSchema = z.object({
  filename: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().positive(),
});

const photoConfirmSchema = z.object({
  filePath: z.string().min(1),
  oldPhotoPath: z.string().optional(),
});

// Schema for cropped photo upload
// Base64 encoding increases size by ~33%, so 10MB file ≈ 14MB base64 chars
const MAX_BASE64_LENGTH = 14_000_000;
const croppedPhotoSchema = z.object({
  imageData: z.string()
    .min(1, 'Image data is required')
    .max(MAX_BASE64_LENGTH, 'Image data must not exceed 10MB'),
});

/**
 * Helper function to build consistent user response object
 */
function buildUserResponse(
  updatedUser: any,
  membership: any,
  photoUrl?: string,
  photoUrlError?: boolean
) {
  return {
    id: updatedUser.id,
    email: updatedUser.email,
    firstName: updatedUser.firstName,
    lastName: updatedUser.lastName,
    phone: updatedUser.phone || undefined,
    photoUrl: photoUrl || undefined,
    ...(photoUrlError && { photoUrlError: true }),
    role: updatedUser.role,
    nextOfKin: updatedUser.nextOfKin,
    emailVerifiedAt: updatedUser.emailVerifiedAt || undefined,
    createdAt: updatedUser.createdAt,
    updatedAt: updatedUser.updatedAt,
    membership: membership
      ? {
        type: membership.type,
        marketingAddon: membership.marketingAddon,
      }
      : undefined,
  };
}


export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const data = registerSchema.parse(req.body);
      const result = await authService.register(data);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const data = loginSchema.parse(req.body);
      const result = await authService.login(data);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(401).json({ success: false, error: error.message });
    }
  }

  async forgotPassword(req: Request, res: Response) {
    try {
      const data = forgotPasswordSchema.parse(req.body);
      await authService.forgotPassword(data);
      res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async resetPassword(req: Request, res: Response) {
    try {
      const data = resetPasswordSchema.parse(req.body);
      await authService.resetPassword(data);
      res.status(200).json({ success: true, message: 'Password reset successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async changeEmail(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = changeEmailSchema.parse(req.body);
      await authService.changeEmail(req.user.id, data);
      res.status(200).json({
        success: true,
        message: 'Verification email sent to new address',
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async verifyEmailChange(req: Request, res: Response) {
    try {
      const { token } = req.query;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, error: 'Token is required' });
      }

      await authService.verifyEmailChange(token);
      res.status(200).json({ success: true, message: 'Email changed successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async getCurrentUser(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Fetch full user data
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
      });

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Fetch user's membership
      const membership = await db.query.memberships.findFirst({
        where: eq(memberships.userId, req.user.id),
      });

      // Generate presigned URL for photo if exists
      let photoUrl: string | undefined = undefined;
      let photoUrlError: boolean = false;
      if (user.photoUrl) {
        try {
          photoUrl = await FileService.generatePresignedGetUrl(user.photoUrl, 'photos');
        } catch (error) {
          // Log full error details with context for server logs
          logger.error(
            'Failed to generate presigned URL for user photo',
            error,
            {
              userId: req.user.id,
              photoPath: user.photoUrl,
              method: req.method,
              url: req.originalUrl,
            }
          );
          // Set error flag for client (don't expose sensitive error details)
          photoUrlError = true;
        }
      }

      res.status(200).json({
        success: true,
        data: buildUserResponse(user, membership, photoUrl, photoUrlError),
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async changePassword(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = changePasswordSchema.parse(req.body);
      await authService.changePassword(req.user.id, data);
      res.status(200).json({ success: true, message: 'Password changed successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async updateProfile(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = updateProfileSchema.parse(req.body);
      const updatedUser = await authService.updateProfile(req.user.id, data);
      res.status(200).json({ success: true, data: updatedUser });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  async refreshToken(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ success: false, error: 'Refresh token is required' });
      }

      const tokens = await authService.refreshToken(refreshToken);
      res.status(200).json({ success: true, data: tokens });
    } catch (error: any) {
      res.status(401).json({ success: false, error: error.message });
    }
  }

  async getPhotoUploadUrl(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = photoUploadUrlSchema.parse(req.body);

      // Validate file
      const validation = FileService.validatePhotoFile({
        filename: data.filename,
        fileType: data.fileType,
        fileSize: data.fileSize,
      });

      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.error });
      }

      // Get current user to check for existing photo
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
      });

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Generate file path
      const filePath = FileService.generateFilePath(req.user.id, 'photos', data.filename);

      // Generate presigned URL
      const { presignedUrl, filePath: generatedPath } = await FileService.generatePresignedUploadUrl(
        filePath,
        data.fileType
      );

      // Extract old photo path if exists
      const oldPhotoPath = user.photoUrl ? FileService.extractFilePath(user.photoUrl) : undefined;

      res.status(200).json({
        success: true,
        data: {
          presignedUrl,
          filePath: generatedPath,
          oldPhotoPath,
        },
      });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Invalid request data' });
      }

      // Check if R2 configuration is missing
      if (!R2_BUCKET_NAME) {
        logger.error(
          'R2_BUCKET_NAME is not configured',
          error,
          {
            userId: req.user?.id,
            method: req.method,
            url: req.originalUrl,
          }
        );
        return res.status(500).json({
          success: false,
          error: 'File storage service is not configured'
        });
      }

      logger.error(
        'Failed to generate photo upload URL',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async confirmPhotoUpload(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = photoConfirmSchema.parse(req.body);

      // Get current user
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
      });

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Verify the uploaded file actually exists in R2 before updating DB
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: data.filePath,
        });
        await r2Client.send(headCommand);
      } catch (error: any) {
        // If file doesn't exist or there's an R2 error
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
          logger.error(
            'Photo file not found in R2 before DB update',
            error,
            {
              userId: req.user.id,
              filePath: data.filePath,
              method: req.method,
              url: req.originalUrl,
            }
          );
          return res.status(400).json({
            success: false,
            error: 'Uploaded file not found. Please try uploading again.'
          });
        }

        // Other R2 errors
        logger.error(
          'R2 error while verifying photo file',
          error,
          {
            userId: req.user.id,
            filePath: data.filePath,
            method: req.method,
            url: req.originalUrl,
          }
        );
        return res.status(500).json({
          success: false,
          error: 'Failed to verify uploaded file'
        });
      }

      // Update user photo URL (store file path, not full URL)
      const [updatedUser] = await db
        .update(users)
        .set({
          photoUrl: data.filePath,
          updatedAt: new Date(),
        })
        .where(eq(users.id, req.user.id))
        .returning();

      // Delete old photo from R2 if it exists and is different
      if (data.oldPhotoPath && data.oldPhotoPath !== data.filePath) {
        try {
          await FileService.deleteFile(data.oldPhotoPath);
        } catch (error) {
          // Log error but don't fail the request
          logger.error(
            'Failed to delete old photo from R2',
            error,
            {
              userId: req.user.id,
              oldPhotoPath: data.oldPhotoPath,
              newPhotoPath: data.filePath,
              method: req.method,
              url: req.originalUrl,
            }
          );
        }
      }

      // Generate presigned URL for the new photo
      let photoUrl: string | undefined = undefined;
      let photoUrlError: boolean = false;
      try {
        photoUrl = await FileService.generatePresignedGetUrl(data.filePath, 'photos');
      } catch (error) {
        // Log full error details with context for server logs
        logger.error(
          'Failed to generate presigned URL for newly uploaded photo',
          error,
          {
            userId: req.user.id,
            photoPath: data.filePath,
            method: req.method,
            url: req.originalUrl,
          }
        );
        // Set error flag for client (don't expose sensitive error details)
        photoUrlError = true;
      }

      // Fetch membership info for complete response
      const membership = await db.query.memberships.findFirst({
        where: eq(memberships.userId, req.user.id),
      });

      res.status(200).json({
        success: true,
        data: buildUserResponse(updatedUser, membership, photoUrl, photoUrlError),
      });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Invalid request data' });
      }

      logger.error(
        'Failed to confirm photo upload',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async getPhotoUrl(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Get current user
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
      });

      if (!user || !user.photoUrl) {
        return res.status(404).json({ success: false, error: 'No photo found' });
      }

      // Generate presigned URL for viewing photo
      try {
        const photoUrl = await FileService.generatePresignedGetUrl(user.photoUrl, 'photos');
        res.status(200).json({
          success: true,
          data: {
            photoUrl,
          },
        });
      } catch (error) {
        // Log full error details with context for server logs
        logger.error(
          'Failed to generate presigned URL for photo viewing',
          error,
          {
            userId: req.user.id,
            photoPath: user.photoUrl,
            method: req.method,
            url: req.originalUrl,
          }
        );
        // Return error response (this endpoint is specifically for getting photo URL)
        res.status(500).json({
          success: false,
          error: 'Failed to generate photo URL',
          photoUrlError: true, // Include error indicator
        });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Upload a cropped profile photo
   * Accepts base64 image data, processes it to 512x512 JPEG under 500KB, and uploads to R2
   */
  async uploadCroppedPhoto(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = croppedPhotoSchema.parse(req.body);

      // Get current user to check for existing photo
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
      });

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Process the image (resize to 512x512, compress to under 500KB)
      let processedBuffer: Buffer;
      try {
        processedBuffer = await processBase64Image(data.imageData);
      } catch (error) {
        logger.error(
          'Failed to process cropped image',
          error,
          {
            userId: req.user.id,
            method: req.method,
            url: req.originalUrl,
          }
        );
        return res.status(400).json({
          success: false,
          error: 'Failed to process image. Please try a different image.'
        });
      }

      // Generate file path for the new photo using FileService
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const filePath = FileService.generateFilePath(req.user.id, 'photos', `${uniqueId}-profile.jpg`);

      // Upload directly to R2
      try {
        await FileService.uploadBufferToR2(filePath, processedBuffer, 'image/jpeg');
      } catch (error) {
        logger.error(
          'Failed to upload processed photo to R2',
          error,
          {
            userId: req.user.id,
            filePath,
            method: req.method,
            url: req.originalUrl,
          }
        );
        return res.status(500).json({
          success: false,
          error: 'Failed to upload photo. Please try again.'
        });
      }

      // Get old photo path for cleanup
      const oldPhotoPath = user.photoUrl ? FileService.extractFilePath(user.photoUrl) : undefined;

      // Update user photo URL in database
      const [updatedUser] = await db
        .update(users)
        .set({
          photoUrl: filePath,
          updatedAt: new Date(),
        })
        .where(eq(users.id, req.user.id))
        .returning();

      // Delete old photo from R2 if it exists and is different
      if (oldPhotoPath && oldPhotoPath !== filePath) {
        try {
          await FileService.deleteFile(oldPhotoPath);
        } catch (error) {
          // Log error but don't fail the request
          logger.error(
            'Failed to delete old photo during cropped upload',
            error,
            {
              userId: req.user.id,
              oldPhotoPath,
              newPhotoPath: filePath,
              method: req.method,
              url: req.originalUrl,
            }
          );
        }
      }

      // Generate presigned URL for the new photo
      let photoUrl: string | undefined = undefined;
      let photoUrlError: boolean = false;
      try {
        photoUrl = await FileService.generatePresignedGetUrl(filePath, 'photos');
      } catch (error) {
        logger.error(
          'Failed to generate presigned URL for newly uploaded cropped photo',
          error,
          {
            userId: req.user.id,
            photoPath: filePath,
            method: req.method,
            url: req.originalUrl,
          }
        );
        photoUrlError = true;
      }

      // Fetch membership info for complete response
      const membership = await db.query.memberships.findFirst({
        where: eq(memberships.userId, req.user.id),
      });

      res.status(200).json({
        success: true,
        data: buildUserResponse(updatedUser, membership, photoUrl, photoUrlError),
      });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Invalid request data' });
      }

      logger.error(
        'Failed to upload cropped photo',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }
}

export const authController = new AuthController();
