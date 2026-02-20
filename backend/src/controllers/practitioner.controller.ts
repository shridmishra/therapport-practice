import { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../config/database';
import { bookings, rooms, locations, documents, clinicalExecutors, users } from '../db/schema';
import { eq, and, gte, asc } from 'drizzle-orm';
import { VoucherService } from '../services/voucher.service';
import { CreditService } from '../services/credit.service';
import { FileService } from '../services/file.service';
import { ReminderService, type DocumentReminderMetadata } from '../services/reminder.service';
import { emailService } from '../services/email.service';
import { getTransactionHistory } from '../services/transaction-history.service';
import { logger } from '../utils/logger.util';
import { calculateExpiryStatus } from '../utils/date.util';
import { z, ZodError } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '../config/r2';

const futureDate = z.string().refine(
  (date) => {
    const expiry = new Date(date);
    expiry.setUTCHours(0, 0, 0, 0);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return expiry > today;
  },
  { message: 'Expiry date must be in the future' }
);

const insuranceUploadUrlSchema = z.object({
  filename: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().positive(),
  expiryDate: futureDate,
});

const insuranceConfirmSchema = z.object({
  filePath: z.string().min(1),
  fileName: z.string().min(1),
  expiryDate: futureDate,
  oldDocumentId: z.string().uuid().optional(),
});

const clinicalExecutorSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format'),
  phone: z.string().min(1, 'Phone is required'),
});

export class PractitionerController {
  /**
   * Helper method to get document upload URL
   * @param req - AuthRequest
   * @param res - Response
   * @param documentType - Document type ('insurance' or 'clinical_registration')
   * @param errorContext - Context for error logging (e.g., 'insurance document' or 'clinical document')
   */
  private async getDocumentUploadUrl(
    req: AuthRequest,
    res: Response,
    documentType: 'insurance' | 'clinical_registration',
    errorContext: string
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Validate R2 configuration upfront
      if (!R2_BUCKET_NAME) {
        logger.error(
          'R2_BUCKET_NAME is not configured',
          new Error('R2_BUCKET_NAME environment variable is missing'),
          {
            userId: req.user.id,
            method: req.method,
            url: req.originalUrl,
          }
        );
        res.status(500).json({
          success: false,
          error: 'File storage service is not configured'
        });
        return;
      }

      const data = insuranceUploadUrlSchema.parse(req.body);

      // Validate file
      const validation = FileService.validateDocumentFile({
        filename: data.filename,
        fileType: data.fileType,
        fileSize: data.fileSize,
      });

      if (!validation.valid) {
        res.status(400).json({ success: false, error: validation.error });
        return;
      }

      // Get current document if exists
      const currentDocument = await db.query.documents.findFirst({
        where: and(
          eq(documents.userId, req.user.id),
          eq(documents.documentType, documentType)
        ),
        orderBy: (documents, { desc }) => [desc(documents.createdAt)],
      });

      // Generate file path
      const filePath = FileService.generateFilePath(req.user.id, 'documents', data.filename);

      // Generate presigned URL
      const { presignedUrl, filePath: generatedPath } = await FileService.generatePresignedUploadUrl(
        filePath,
        data.fileType
      );

      res.status(200).json({
        success: true,
        data: {
          presignedUrl,
          filePath: generatedPath,
          oldDocumentId: currentDocument?.id,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: error.errors.map(e => e.message).join(', ')
        });
        return;
      }

      logger.error(
        `Failed to generate ${errorContext} upload URL`,
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Helper method to confirm document upload
   * @param req - AuthRequest
   * @param res - Response
   * @param documentType - Document type ('insurance' or 'clinical_registration')
   * @param errorContext - Context for error logging (e.g., 'insurance document' or 'clinical document')
   */
  private async confirmDocumentUpload(
    req: AuthRequest,
    res: Response,
    documentType: 'insurance' | 'clinical_registration',
    errorContext: string
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const data = insuranceConfirmSchema.parse(req.body);

      // Verify the uploaded file actually exists in R2 before updating DB
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: data.filePath,
        });
        await r2Client.send(headCommand);
      } catch (error: any) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
          logger.error(
            `${errorContext} file not found in R2 before DB update`,
            error,
            {
              userId: req.user.id,
              filePath: data.filePath,
              method: req.method,
              url: req.originalUrl,
            }
          );
          res.status(400).json({
            success: false,
            error: 'Uploaded file not found. Please try uploading again.'
          });
          return;
        }

        logger.error(
          `R2 error while verifying ${errorContext} file`,
          error,
          {
            userId: req.user.id,
            filePath: data.filePath,
            method: req.method,
            url: req.originalUrl,
          }
        );
        res.status(500).json({
          success: false,
          error: 'Failed to verify uploaded file'
        });
        return;
      }

      // Fetch old document if exists (for R2 deletion after transaction)
      let oldDocument: typeof documents.$inferSelect | null = null;
      if (data.oldDocumentId) {
        const found = await db.query.documents.findFirst({
          where: and(
            eq(documents.id, data.oldDocumentId),
            eq(documents.userId, req.user.id),
            eq(documents.documentType, documentType)
          ),
        });
        oldDocument = found || null;
      }

      // Atomic DB operations: insert new document and delete old DB record in a transaction
      const userId = req.user.id;
      const [newDocument] = await db.transaction(async (tx) => {
        // Insert new document
        const [newDoc] = await tx
          .insert(documents)
          .values({
            userId: userId,
            documentType: documentType,
            fileUrl: data.filePath,
            fileName: data.fileName,
            expiryDate: data.expiryDate,
          })
          .returning();

        // Delete old document DB record if exists
        if (data.oldDocumentId) {
          await tx
            .delete(documents)
            .where(
              and(
                eq(documents.id, data.oldDocumentId),
                eq(documents.userId, userId),
                eq(documents.documentType, documentType)
              )
            );
        }

        return [newDoc];
      });

      // Delete old R2 file after successful transaction
      if (oldDocument) {
        try {
          await FileService.deleteFile(FileService.extractFilePath(oldDocument.fileUrl));
          // Cancel old document reminders
          await ReminderService.cancelDocumentReminders(oldDocument.id);
        } catch (error) {
          logger.error(
            `Failed to delete old ${errorContext} from R2`,
            error,
            {
              userId: req.user.id,
              oldDocumentId: data.oldDocumentId,
              method: req.method,
              url: req.originalUrl,
            }
          );
        }
      }

      // Schedule reminders for the new document
      if (newDocument.expiryDate) {
        await ReminderService.scheduleDocumentReminders(
          userId,
          newDocument.id,
          documentType,
          data.fileName,
          newDocument.expiryDate
        );
      }

      // Fetch user details for email notification
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });

      // Send email notification to admin
      if (user) {
        try {
          await emailService.sendDocumentUploadNotification({
            practitionerName: `${user.firstName} ${user.lastName}`,
            practitionerEmail: user.email,
            documentType: documentType,
            documentName: data.fileName,
            expiryDate: newDocument.expiryDate,
          });
        } catch (error) {
          // Log error but don't fail the request - document upload was successful
          logger.error(
            `Failed to send admin notification for ${errorContext} upload`,
            error,
            {
              userId: req.user.id,
              documentId: newDocument.id,
              method: req.method,
              url: req.originalUrl,
            }
          );
        }
      }

      // Generate presigned URL for viewing
      const documentUrl = await FileService.generatePresignedGetUrl(data.filePath, 'documents');

      // Calculate expiry status
      const { isExpired, isExpiringSoon, daysUntilExpiry } = calculateExpiryStatus(newDocument.expiryDate);

      res.status(200).json({
        success: true,
        data: {
          id: newDocument.id,
          fileName: newDocument.fileName,
          expiryDate: newDocument.expiryDate,
          documentUrl,
          isExpired,
          isExpiringSoon,
          daysUntilExpiry,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: error.errors.map(e => e.message).join(', ')
        });
        return;
      }

      logger.error(
        `Failed to confirm ${errorContext} upload`,
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Helper method to get a document
   * @param req - AuthRequest
   * @param res - Response
   * @param documentType - Document type ('insurance' or 'clinical_registration')
   * @param notFoundMessage - Error message when document is not found
   * @param errorContext - Context for error logging (e.g., 'insurance document' or 'clinical document')
   */
  private async getDocument(
    req: AuthRequest,
    res: Response,
    documentType: 'insurance' | 'clinical_registration',
    notFoundMessage: string,
    errorContext: string
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Get current document
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.userId, req.user.id),
          eq(documents.documentType, documentType)
        ),
        orderBy: (documents, { desc }) => [desc(documents.createdAt)],
      });

      if (!document) {
        res.status(404).json({ success: false, error: notFoundMessage });
        return;
      }

      // Generate presigned URL for viewing
      const documentUrl = await FileService.generatePresignedGetUrl(document.fileUrl, 'documents');

      // Calculate expiry status
      const { isExpired, isExpiringSoon, daysUntilExpiry } = calculateExpiryStatus(document.expiryDate);

      res.status(200).json({
        success: true,
        data: {
          id: document.id,
          fileName: document.fileName,
          expiryDate: document.expiryDate,
          documentUrl,
          isExpired,
          isExpiringSoon,
          daysUntilExpiry,
        },
      });
    } catch (error: unknown) {
      logger.error(
        `Failed to get ${errorContext}`,
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getDashboard(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const userId = req.user.id;

      // Compute todayUtc first
      const todayUtc = new Date();
      todayUtc.setUTCHours(0, 0, 0, 0);

      // Start all three promises in parallel
      const [voucherSummary, creditSummary, upcomingBookingsData] = await Promise.all([
        VoucherService.getRemainingFreeHours(userId),
        CreditService.getCreditBalance(userId),
        db
          .select({
            booking: bookings,
            room: rooms,
            location: locations,
          })
          .from(bookings)
          .innerJoin(rooms, eq(bookings.roomId, rooms.id))
          .innerJoin(locations, eq(rooms.locationId, locations.id))
          .where(
            and(
              eq(bookings.userId, userId),
              eq(bookings.status, 'confirmed'),
              gte(bookings.bookingDate, todayUtc.toISOString().split('T')[0])
            )
          )
          .orderBy(asc(bookings.bookingDate), asc(bookings.startTime))
          .limit(10),
      ]);

      // Format bookings for response
      const formattedBookings = upcomingBookingsData.map(({ booking, room, location }) => ({
        id: booking.id,
        roomName: room.name,
        locationName: location.name,
        bookingDate: booking.bookingDate,
        startTime: booking.startTime,
        endTime: booking.endTime,
        totalPrice: parseFloat(booking.totalPrice.toString()),
        status: booking.status,
      }));

      res.status(200).json({
        success: true,
        data: {
          freeBookingHours: {
            remaining: voucherSummary.remainingHours,
            totalAllocated: voucherSummary.totalHoursAllocated,
            totalUsed: voucherSummary.totalHoursUsed,
            earliestExpiry: voucherSummary.latestExpiry, // Use latestExpiry for dashboard display
          },
          credit: creditSummary,
          upcomingBookings: formattedBookings,
        },
      });
    } catch (error: unknown) {
      // Normalize error for logging
      const isError = error instanceof Error;
      const errorMessage = isError ? error.message : String(error);
      const errorStack = isError ? error.stack : undefined;

      // Set errorDetails once: use errorMessage for Error instances, otherwise stringify
      const errorDetails: string = isError
        ? errorMessage
        : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();

      const errorForLogger = isError ? error : new Error(errorDetails);

      logger.error(
        'Failed to get dashboard data',
        errorForLogger,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
          errorDetails: errorDetails,
          errorStack: errorStack,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getInsuranceUploadUrl(req: AuthRequest, res: Response) {
    await this.getDocumentUploadUrl(req, res, 'insurance', 'insurance document');
  }

  async confirmInsuranceUpload(req: AuthRequest, res: Response) {
    await this.confirmDocumentUpload(req, res, 'insurance', 'insurance document');
  }

  async getInsuranceDocument(req: AuthRequest, res: Response) {
    await this.getDocument(req, res, 'insurance', 'No insurance document found', 'insurance document');
  }

  async getClinicalUploadUrl(req: AuthRequest, res: Response) {
    await this.getDocumentUploadUrl(req, res, 'clinical_registration', 'clinical document');
  }

  async confirmClinicalUpload(req: AuthRequest, res: Response) {
    await this.confirmDocumentUpload(req, res, 'clinical_registration', 'clinical document');
  }

  async getClinicalDocument(req: AuthRequest, res: Response) {
    await this.getDocument(req, res, 'clinical_registration', 'No clinical registration document found', 'clinical document');
  }

  async createOrUpdateClinicalExecutor(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const data = clinicalExecutorSchema.parse(req.body);

      // Use upsert to atomically create or update executor
      const [executor] = await db
        .insert(clinicalExecutors)
        .values({
          userId: req.user.id,
          name: data.name,
          email: data.email,
          phone: data.phone,
        })
        .onConflictDoUpdate({
          target: clinicalExecutors.userId,
          set: {
            name: data.name,
            email: data.email,
            phone: data.phone,
            updatedAt: new Date(),
          },
        })
        .returning();

      res.status(200).json({
        success: true,
        data: {
          id: executor.id,
          name: executor.name,
          email: executor.email,
          phone: executor.phone,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: error.errors.map(e => e.message).join(', ')
        });
      }

      logger.error(
        'Failed to create/update clinical executor',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getClinicalExecutor(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const executor = await db.query.clinicalExecutors.findFirst({
        where: eq(clinicalExecutors.userId, req.user.id),
      });

      if (!executor) {
        return res.status(404).json({ success: false, error: 'No clinical executor found' });
      }

      res.status(200).json({
        success: true,
        data: {
          id: executor.id,
          name: executor.name,
          email: executor.email,
          phone: executor.phone,
        },
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get clinical executor',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getReminders(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Get pending reminders for the user
      const userId = req.user.id;
      const userReminders = await ReminderService.getPendingReminders(userId);

      // Format reminders for response
      const formattedReminders = userReminders.map((r) => {
        const metadata = r.metadata as DocumentReminderMetadata | null;
        return {
          id: r.id,
          notificationType: r.notificationType,
          scheduledAt: r.scheduledAt,
          documentType: metadata?.documentType,
          documentName: metadata?.documentName,
          expiryDate: metadata?.expiryDate,
        };
      });

      res.status(200).json({
        success: true,
        data: formattedReminders,
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get reminders',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getTransactionHistory(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const userId = req.user.id;
      const monthParam = typeof req.query.month === 'string' ? req.query.month : undefined;

      // Normalize month: validate format or default to current month
      let normalizedMonth: string;
      if (monthParam) {
        // Validate month format (YYYY-MM) and month range (01-12)
        if (!/^\d{4}-\d{2}$/.test(monthParam)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid month format. Expected YYYY-MM',
          });
        }
        const [, monthStr] = monthParam.split('-');
        const monthNum = parseInt(monthStr, 10);
        if (monthNum < 1 || monthNum > 12) {
          return res.status(400).json({
            success: false,
            error: 'Invalid month. Month must be between 01 and 12',
          });
        }
        normalizedMonth = monthParam;
      } else {
        // Default to current month if not provided
        const now = new Date();
        const year = now.getUTCFullYear();
        const monthNum = now.getUTCMonth() + 1;
        normalizedMonth = `${year}-${String(monthNum).padStart(2, '0')}`;
      }

      const transactions = await getTransactionHistory(userId, normalizedMonth);

      res.status(200).json({
        success: true,
        data: transactions,
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get transaction history',
        error,
        {
          userId: req.user?.id,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const practitionerController = new PractitionerController();

