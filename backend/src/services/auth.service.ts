import { and, eq, gte, isNull, or } from 'drizzle-orm';
import { db } from '../config/database';
import { users, memberships, passwordResets, emailChangeRequests, rooms } from '../db/schema';
import { hashPassword, comparePassword } from '../utils/password.util';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt.util';
import { emailService } from './email.service';
import { randomBytes } from 'crypto';
import type {
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  ChangeEmailRequest,
  ChangePasswordRequest,
  UpdateProfileRequest,
  User,
} from '../types';

export class AuthService {
  async register(data: RegisterRequest): Promise<AuthResponse> {
    // Check if user already exists
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, data.email.toLowerCase()),
    });

    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Hash password
    const passwordHash = await hashPassword(data.password);

    // Generate temporary password for email
    const tempPassword = data.password;

    if (data.recurringSlot && data.membershipType !== 'permanent') {
      throw new Error('Recurring slot is only available for permanent memberships');
    }

    // Create user
    // Create user and membership in a transaction
    const [newUser] = await db.transaction(async (tx) => {
      if (data.recurringSlot) {
        // Lock room row so overlapping recurring-signup checks on this room serialize.
        const [selectedRoom] = await tx
          .select({
            id: rooms.id,
            active: rooms.active,
          })
          .from(rooms)
          .where(eq(rooms.id, data.recurringSlot.roomId))
          .limit(1)
          .for('update');

        if (!selectedRoom || !selectedRoom.active) {
          throw new Error('Selected room is not available');
        }

        const conflictingSlots = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.contractType, 'recurring'),
              eq(memberships.recurringRoomId, data.recurringSlot.roomId),
              eq(memberships.recurringWeekday, data.recurringSlot.weekday),
              eq(memberships.recurringTimeBand, data.recurringSlot.timeBand),
              or(
                isNull(memberships.recurringTerminationDate),
                gte(memberships.recurringTerminationDate, data.recurringSlot.startDate)
              )
            )
          )
          .limit(1);

        if (conflictingSlots.length > 0) {
          throw new Error('Selected recurring slot is no longer available');
        }
      }

      const [u] = await tx
        .insert(users)
        .values({
          email: data.email.toLowerCase(),
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          role: 'practitioner',
        })
        .returning();

      await tx.insert(memberships).values({
        userId: u.id,
        type: data.membershipType,
        marketingAddon: data.marketingAddon,
        contractType: data.recurringSlot ? 'recurring' : 'standard',
        recurringStartDate: data.recurringSlot?.startDate,
        recurringPractitionerName: data.recurringSlot?.practitionerName,
        recurringWeekday: data.recurringSlot?.weekday,
        recurringRoomId: data.recurringSlot?.roomId,
        recurringTimeBand: data.recurringSlot?.timeBand,
        recurringTerminationDate: null,
      });

      return [u];
    });

    // Send welcome email
    await emailService.sendWelcomeEmail({
      firstName: data.firstName,
      email: data.email,
      password: tempPassword,
    });

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });
    const refreshToken = generateRefreshToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        phone: newUser.phone || undefined,
        photoUrl: newUser.photoUrl || undefined,
        role: newUser.role,
        nextOfKin: newUser.nextOfKin as any,
        emailVerifiedAt: newUser.emailVerifiedAt || undefined,
        createdAt: newUser.createdAt,
        updatedAt: newUser.updatedAt,
      },
      accessToken,
      refreshToken,
    };
  }

  async login(data: LoginRequest): Promise<AuthResponse> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, data.email.toLowerCase()),
    });

    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isPasswordValid = await comparePassword(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new Error('Invalid email or password');
    }

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone || undefined,
        photoUrl: user.photoUrl || undefined,
        role: user.role,
        nextOfKin: user.nextOfKin as any,
        emailVerifiedAt: user.emailVerifiedAt || undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
      refreshToken,
    };
  }

  async forgotPassword(data: ForgotPasswordRequest): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, data.email.toLowerCase()),
    });

    if (!user) {
      // Don't reveal if user exists
      return;
    }

    // Generate reset token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry

    // Delete any existing reset tokens for this user
    await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));

    // Create new reset token
    await db.insert(passwordResets).values({
      userId: user.id,
      token,
      expiresAt,
      used: false,
    });

    // Send reset email
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${baseUrl}/reset-password?token=${token}`;
    await emailService.sendPasswordResetEmail({
      firstName: user.firstName,
      email: user.email,
      resetLink,
    });
  }

  async resetPassword(data: ResetPasswordRequest): Promise<void> {
    const resetRecord = await db.query.passwordResets.findFirst({
      where: eq(passwordResets.token, data.token),
    });

    if (!resetRecord || resetRecord.used || resetRecord.expiresAt < new Date()) {
      throw new Error('Invalid or expired reset token');
    }

    // Hash new password
    const passwordHash = await hashPassword(data.password);

    // Update user password
    await db.update(users).set({ passwordHash }).where(eq(users.id, resetRecord.userId));

    // Mark token as used
    await db
      .update(passwordResets)
      .set({ used: true })
      .where(eq(passwordResets.id, resetRecord.id));
  }

  async changeEmail(userId: string, data: ChangeEmailRequest): Promise<void> {
    // Check if new email is already in use
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, data.newEmail.toLowerCase()),
    });

    if (existingUser) {
      throw new Error('Email already in use');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Generate verification token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour expiry

    // Delete any existing change requests for this user
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, userId));

    // Create new change request
    await db.insert(emailChangeRequests).values({
      userId,
      newEmail: data.newEmail.toLowerCase(),
      token,
      expiresAt,
      verified: false,
    });

    // Send verification email to new address
    const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'
      }/verify-email-change?token=${token}`;
    await emailService.sendEmailChangeVerification({
      firstName: user.firstName,
      verificationLink,
      newEmail: data.newEmail,
    });
  }

  async verifyEmailChange(token: string): Promise<void> {
    const changeRequest = await db.query.emailChangeRequests.findFirst({
      where: eq(emailChangeRequests.token, token),
    });

    if (!changeRequest || changeRequest.verified || changeRequest.expiresAt < new Date()) {
      throw new Error('Invalid or expired verification token');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, changeRequest.userId),
    });

    if (!user) {
      throw new Error('User not found');
    }

    const oldEmail = user.email;

    // Update user email
    await db
      .update(users)
      .set({ email: changeRequest.newEmail, emailVerifiedAt: new Date() })
      .where(eq(users.id, changeRequest.userId));

    // Mark change request as verified
    await db
      .update(emailChangeRequests)
      .set({ verified: true })
      .where(eq(emailChangeRequests.id, changeRequest.id));

    // Send confirmation to old email
    await emailService.sendEmailChangeConfirmation({
      firstName: user.firstName,
      oldEmail,
    });
  }

  async changePassword(userId: string, data: ChangePasswordRequest): Promise<void> {
    // Get user
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Verify current password
    const isCurrentPasswordValid = await comparePassword(data.currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new Error('Current password is incorrect');
    }

    // Hash new password
    const passwordHash = await hashPassword(data.newPassword);

    // Update password
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  async updateProfile(userId: string, data: UpdateProfileRequest): Promise<User> {
    // Get user
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Update user profile
    const [updatedUser] = await db
      .update(users)
      .set({
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone || null,
        nextOfKin: data.nextOfKin as any,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      phone: updatedUser.phone || undefined,
      photoUrl: updatedUser.photoUrl || undefined,
      role: updatedUser.role,
      nextOfKin: updatedUser.nextOfKin as any,
      emailVerifiedAt: updatedUser.emailVerifiedAt || undefined,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt,
    };
  }

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { verifyRefreshToken, generateAccessToken, generateRefreshToken } = await import(
      '../utils/jwt.util'
    );

    // Verify refresh token
    const payload = verifyRefreshToken(refreshToken);

    // Verify user still exists
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Generate new tokens
    const newAccessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const newRefreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }
}

export const authService = new AuthService();
