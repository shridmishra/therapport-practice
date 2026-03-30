import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { z } from 'zod';
import { recurringSlotSchema } from '../schemas/auth.schemas';

const router = Router();

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
const uploadCroppedPhotoSchema = z.object({
  imageData: z.string()
    .min(1, 'Image data is required')
    .max(MAX_BASE64_LENGTH, 'Image data must not exceed 10MB'),
});

router.post('/register', validate(registerSchema), authController.register.bind(authController));
router.post('/login', validate(loginSchema), authController.login.bind(authController));
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword.bind(authController));
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword.bind(authController));
router.post('/change-email', authenticate, validate(changeEmailSchema), authController.changeEmail.bind(authController));
router.get('/verify-email-change', authController.verifyEmailChange.bind(authController));
router.post('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword.bind(authController));
router.put('/profile', authenticate, validate(updateProfileSchema), authController.updateProfile.bind(authController));
router.post('/refresh', authController.refreshToken.bind(authController));
router.get('/me', authenticate, authController.getCurrentUser.bind(authController));
router.post('/profile/photo/upload-url', authenticate, validate(photoUploadUrlSchema), authController.getPhotoUploadUrl.bind(authController));
router.put('/profile/photo/confirm', authenticate, validate(photoConfirmSchema), authController.confirmPhotoUpload.bind(authController));
router.get('/profile/photo', authenticate, authController.getPhotoUrl.bind(authController));
// Cropped photo upload (frontend sends base64 image data)
router.post('/profile/photo/upload-cropped', authenticate, validate(uploadCroppedPhotoSchema), authController.uploadCroppedPhoto.bind(authController));

export default router;

