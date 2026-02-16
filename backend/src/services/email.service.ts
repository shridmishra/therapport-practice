import { transporter, EMAIL_FROM } from '../config/email';

// Shared admin email constant for all admin notifications
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@therapport.co.uk';

/**
 * Escapes HTML special characters to prevent HTML injection attacks
 */
function escapeHtml(text: string | number): string {
  const str = String(text);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Safely formats a date string with timezone awareness and validation
 * @param dateString - The date string to parse and format
 * @param locale - The locale for formatting (default: 'en-GB')
 * @param timeZone - The timezone to use (default: 'Europe/London')
 * @returns Formatted date string or throws an error if date is invalid
 */
function formatDateSafely(
  dateString: string,
  locale: string = 'en-GB',
  timeZone: string = 'Europe/London'
): string {
  const date = new Date(dateString);
  if (!isFinite(date.getTime())) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  });
}

export interface WelcomeEmailData {
  firstName: string;
  email: string;
  password: string;
}

export interface PasswordResetEmailData {
  firstName: string;
  email: string;
  resetLink: string;
}

export interface EmailChangeVerificationData {
  firstName: string;
  verificationLink: string;
  newEmail: string;
}

export interface EmailChangeConfirmationData {
  firstName: string;
  oldEmail: string;
}

export interface DocumentExpiryReminderData {
  firstName: string;
  email: string;
  documentType: 'insurance' | 'clinical_registration';
  documentName: string;
  expiryDate: string;
}

export interface AdminEscalationData {
  practitionerName: string;
  practitionerEmail: string;
  documentType: 'insurance' | 'clinical_registration';
  documentName: string;
  expiryDate: string;
  daysOverdue: number;
}

export interface DocumentUploadNotificationData {
  practitionerName: string;
  practitionerEmail: string;
  documentType: 'insurance' | 'clinical_registration';
  documentName: string;
  expiryDate: string | null;
}

export interface BookingConfirmationEmailData {
  firstName: string;
  email: string;
  roomName: string;
  locationName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  totalPrice: string;
  creditUsed?: string;
}

export interface BookingReminderEmailData {
  firstName: string;
  email: string;
  roomName: string;
  locationName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
}

export interface BookingCancellationEmailData {
  firstName: string;
  email: string;
  roomName: string;
  locationName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  refundAmount: string;
}

export interface SuspensionNoticeEmailData {
  firstName: string;
  email: string;
  suspensionDate: string;
}

export interface SubscriptionTerminatedEmailData {
  firstName: string;
  email: string;
  suspensionDate: string;
}

export interface AdminSubscriptionTerminatedEmailData {
  practitionerName: string;
  practitionerEmail: string;
  terminationDate: string;
  suspensionDate: string;
}

export class EmailService {
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    // Escape all user-controlled values
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedEmail = escapeHtml(data.email);
    const escapedPassword = escapeHtml(data.password);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Welcome to Therapport</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Welcome to Therapport, ${escapedFirstName}!</h1>
            <p>Your account has been successfully created. Here are your login credentials:</p>
            <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Email:</strong> ${escapedEmail}</p>
              <p><strong>Password:</strong> ${escapedPassword}</p>
            </div>
            <p>Please log in and change your password after your first login.</p>
            <p>If you have any questions, please contact us at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Welcome to Therapport - Your Account Details',
      html,
    });
  }

  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<void> {
    // Escape all user-controlled values
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedResetLink = escapeHtml(data.resetLink);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Password Reset Request</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Password Reset Request</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>You have requested to reset your password. Click the link below to reset it:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapedResetLink}" style="background-color: #3498db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
            </div>
            <p>This link will expire in 1 hour.</p>
            <p>If you did not request this, please ignore this email.</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Password Reset Request - Therapport',
      html,
    });
  }

  async sendEmailChangeVerification(data: EmailChangeVerificationData): Promise<void> {
    // Escape all user-controlled values
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedNewEmail = escapeHtml(data.newEmail);
    const escapedVerificationLink = escapeHtml(data.verificationLink);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Email Change Verification</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Verify Your New Email Address</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>You have requested to change your email address to <strong>${escapedNewEmail}</strong>.</p>
            <p>Please click the link below to verify this email address:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapedVerificationLink}" style="background-color: #3498db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify Email</a>
            </div>
            <p>This link will expire in 24 hours.</p>
            <p>If you did not request this change, please ignore this email.</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.newEmail,
      subject: 'Verify Your New Email Address - Therapport',
      html,
    });
  }

  async sendEmailChangeConfirmation(data: EmailChangeConfirmationData): Promise<void> {
    // Escape all user-controlled values
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedOldEmail = escapeHtml(data.oldEmail);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Email Change Confirmation</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Email Address Changed</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>This is to confirm that your email address has been successfully changed from <strong>${escapedOldEmail}</strong>.</p>
            <p>If you did not make this change, please contact us immediately at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.oldEmail,
      subject: 'Email Address Changed - Therapport',
      html,
    });
  }

  async sendDocumentExpiryReminder(data: DocumentExpiryReminderData): Promise<void> {
    const documentTypeLabel =
      data.documentType === 'insurance'
        ? 'Professional Indemnity Insurance'
        : 'Clinical Registration';
    const expiryDateFormatted = formatDateSafely(data.expiryDate);

    // Escape all user-controlled values
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedDocumentName = escapeHtml(data.documentName);
    const escapedDocumentTypeLabel = escapeHtml(documentTypeLabel);
    const escapedExpiryDateFormatted = escapeHtml(expiryDateFormatted);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Document Expiry Reminder</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #e74c3c;">Important: Document Expiry Reminder</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>This is a reminder that your <strong>${escapedDocumentTypeLabel}</strong> document is expiring soon or has expired.</p>
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Document:</strong> ${escapedDocumentName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Expiry Date:</strong> ${escapedExpiryDateFormatted}</p>
            </div>
            <p>Please log in to your Therapport account and upload a new document to maintain compliance.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'https://therapport.co.uk'}/profile" style="background-color: #3498db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Update Document</a>
            </div>
            <p>If you have any questions, please contact us at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: `Action Required: ${documentTypeLabel} Document Expiry - Therapport`,
      html,
    });
  }

  async sendAdminEscalation(data: AdminEscalationData): Promise<void> {
    const documentTypeLabel =
      data.documentType === 'insurance'
        ? 'Professional Indemnity Insurance'
        : 'Clinical Registration';
    const expiryDateFormatted = formatDateSafely(data.expiryDate);

    // Escape all user-controlled values
    const escapedPractitionerName = escapeHtml(data.practitionerName);
    const escapedPractitionerEmail = escapeHtml(data.practitionerEmail);
    const escapedDocumentName = escapeHtml(data.documentName);
    const escapedDocumentTypeLabel = escapeHtml(documentTypeLabel);
    const escapedExpiryDateFormatted = escapeHtml(expiryDateFormatted);
    const escapedDaysOverdue = escapeHtml(data.daysOverdue);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Document Expiry Escalation</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #e74c3c;">Action Required: Document Expiry Escalation</h1>
            <p>Hello Admin,</p>
            <p>This is an escalation notice regarding an expired document that has not been renewed.</p>
            <div style="background-color: #f8d7da; border-left: 4px solid #dc3545; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Practitioner:</strong> ${escapedPractitionerName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Email:</strong> ${escapedPractitionerEmail}</p>
              <p style="margin: 5px 0 0 0;"><strong>Document:</strong> ${escapedDocumentName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Document Type:</strong> ${escapedDocumentTypeLabel}</p>
              <p style="margin: 5px 0 0 0;"><strong>Expiry Date:</strong> ${escapedExpiryDateFormatted}</p>
              <p style="margin: 5px 0 0 0;"><strong>Days Overdue:</strong> ${escapedDaysOverdue}</p>
            </div>
            <p>Please follow up with the practitioner to ensure compliance.</p>
            <p>Best regards,<br>The Therapport System</p>
          </div>
        </body>
      </html>
    `;

    // Send to admin email
    const adminEmail = ADMIN_EMAIL;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: adminEmail,
      subject: `Escalation: ${documentTypeLabel} Document Expired - ${data.practitionerName}`,
      html,
    });
  }

  async sendDocumentUploadNotification(data: DocumentUploadNotificationData): Promise<void> {
    const documentTypeLabel =
      data.documentType === 'insurance'
        ? 'Professional Indemnity Insurance'
        : 'Clinical Registration';

    const expiryDateFormatted = data.expiryDate ? formatDateSafely(data.expiryDate) : 'N/A';

    // Escape all user-controlled values
    const escapedPractitionerName = escapeHtml(data.practitionerName);
    const escapedPractitionerEmail = escapeHtml(data.practitionerEmail);
    const escapedDocumentName = escapeHtml(data.documentName);
    const escapedDocumentTypeLabel = escapeHtml(documentTypeLabel);
    const escapedExpiryDateFormatted = escapeHtml(expiryDateFormatted);
    const uploadDate = escapeHtml(
      new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/London',
      })
    );

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>New Document Upload</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">New Document Upload Notification</h1>
            <p>Hello Admin,</p>
            <p>A practitioner has uploaded a new document. Here are the details:</p>
            <div style="background-color: #e8f4f8; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Practitioner:</strong> ${escapedPractitionerName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Email:</strong> ${escapedPractitionerEmail}</p>
              <p style="margin: 5px 0 0 0;"><strong>Document Type:</strong> ${escapedDocumentTypeLabel}</p>
              <p style="margin: 5px 0 0 0;"><strong>Document Name:</strong> ${escapedDocumentName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Expiry Date:</strong> ${escapedExpiryDateFormatted}</p>
              <p style="margin: 5px 0 0 0;"><strong>Upload Date:</strong> ${uploadDate}</p>
            </div>
            <p>Please review this document at your earliest convenience.</p>
            <p>Best regards,<br>The Therapport System</p>
          </div>
        </body>
      </html>
    `;

    const adminEmail = ADMIN_EMAIL;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: adminEmail,
      subject: `New Document Upload: ${data.practitionerName} - ${documentTypeLabel}`,
      html,
    });
  }

  async sendBookingConfirmation(data: BookingConfirmationEmailData): Promise<void> {
    const dateFormatted = formatDateSafely(data.bookingDate);
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedRoomName = escapeHtml(data.roomName);
    const escapedLocationName = escapeHtml(data.locationName);
    const escapedDate = escapeHtml(dateFormatted);
    const escapedStartTime = escapeHtml(data.startTime);
    const escapedEndTime = escapeHtml(data.endTime);
    const escapedTotalPrice = escapeHtml(data.totalPrice);
    const creditLine = data.creditUsed
      ? `<p><strong>Credit used:</strong> £${escapeHtml(data.creditUsed)}</p>`
      : '';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Booking Confirmation</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Booking Confirmed</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>Your room booking has been confirmed. Here are the details:</p>
            <div style="background-color: #e8f4f8; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Room:</strong> ${escapedRoomName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Location:</strong> ${escapedLocationName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Date:</strong> ${escapedDate}</p>
              <p style="margin: 5px 0 0 0;"><strong>Time:</strong> ${escapedStartTime} – ${escapedEndTime}</p>
              <p style="margin: 5px 0 0 0;"><strong>Total:</strong> £${escapedTotalPrice}</p>
              ${creditLine}
            </div>
            <p>If you need to cancel or change your booking, please log in to your account.</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Booking Confirmation - Therapport',
      html,
    });
  }

  async sendBookingReminder(data: BookingReminderEmailData): Promise<void> {
    const dateFormatted = formatDateSafely(data.bookingDate);
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedRoomName = escapeHtml(data.roomName);
    const escapedLocationName = escapeHtml(data.locationName);
    const escapedDate = escapeHtml(dateFormatted);
    const escapedStartTime = escapeHtml(data.startTime);
    const escapedEndTime = escapeHtml(data.endTime);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Booking Reminder</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Reminder: Your Booking in 48 Hours</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>This is a reminder that you have a room booking coming up:</p>
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Room:</strong> ${escapedRoomName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Location:</strong> ${escapedLocationName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Date:</strong> ${escapedDate}</p>
              <p style="margin: 5px 0 0 0;"><strong>Time:</strong> ${escapedStartTime} – ${escapedEndTime}</p>
            </div>
            <p>We look forward to seeing you. If you need to cancel, please log in to your account.</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Reminder: Your Booking in 48 Hours - Therapport',
      html,
    });
  }

  async sendBookingCancellation(data: BookingCancellationEmailData): Promise<void> {
    const dateFormatted = formatDateSafely(data.bookingDate);
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedRoomName = escapeHtml(data.roomName);
    const escapedLocationName = escapeHtml(data.locationName);
    const escapedDate = escapeHtml(dateFormatted);
    const escapedStartTime = escapeHtml(data.startTime);
    const escapedEndTime = escapeHtml(data.endTime);
    const escapedRefundAmount = escapeHtml(data.refundAmount);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Booking Cancelled</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Booking Cancelled</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>Your room booking has been cancelled. Details of the cancelled booking:</p>
            <div style="background-color: #f4f4f4; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Room:</strong> ${escapedRoomName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Location:</strong> ${escapedLocationName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Date:</strong> ${escapedDate}</p>
              <p style="margin: 5px 0 0 0;"><strong>Time:</strong> ${escapedStartTime} – ${escapedEndTime}</p>
              <p style="margin: 5px 0 0 0;"><strong>Credit refunded:</strong> £${escapedRefundAmount}</p>
            </div>
            <p>The refunded amount has been added back to your credit balance.</p>
            <p>If you have any questions, please contact us at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Booking Cancelled - Therapport',
      html,
    });
  }

  async sendSuspensionNotice(data: SuspensionNoticeEmailData): Promise<void> {
    const suspensionDateFormatted = formatDateSafely(data.suspensionDate);
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedSuspensionDate = escapeHtml(suspensionDateFormatted);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Account Suspension Notice</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Account Suspension Notice</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>Your ad-hoc subscription termination has taken effect. Your account has been suspended as of ${escapedSuspensionDate}.</p>
            <p>You will no longer be able to make new bookings. If you wish to use the service again, please contact us to reactivate your membership.</p>
            <p>If you have any questions, please contact us at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Account Suspension Notice - Therapport',
      html,
    });
  }

  async sendSubscriptionTerminated(data: SubscriptionTerminatedEmailData): Promise<void> {
    const suspensionDateFormatted = formatDateSafely(data.suspensionDate);
    const escapedFirstName = escapeHtml(data.firstName);
    const escapedSuspensionDate = escapeHtml(suspensionDateFormatted);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Ad-hoc Subscription Terminated</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Ad-hoc Subscription Terminated</h1>
            <p>Hello ${escapedFirstName},</p>
            <p>Your ad-hoc subscription has been terminated as requested. You can continue to use the service until ${escapedSuspensionDate}. After that date your account will be suspended.</p>
            <p>If you have any questions, please contact us at info@therapport.co.uk</p>
            <p>Best regards,<br>The Therapport Team</p>
          </div>
        </body>
      </html>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: data.email,
      subject: 'Ad-hoc Subscription Terminated - Therapport',
      html,
    });
  }

  async sendAdminSubscriptionTerminated(data: AdminSubscriptionTerminatedEmailData): Promise<void> {
    const terminationDateFormatted = formatDateSafely(data.terminationDate);
    const suspensionDateFormatted = formatDateSafely(data.suspensionDate);
    const escapedPractitionerName = escapeHtml(data.practitionerName);
    const escapedPractitionerEmail = escapeHtml(data.practitionerEmail);
    const escapedTerminationDate = escapeHtml(terminationDateFormatted);
    const escapedSuspensionDate = escapeHtml(suspensionDateFormatted);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Subscription Termination Notification</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #2c3e50;">Subscription Termination Notification</h1>
            <p>Hello Admin,</p>
            <p>A practitioner has terminated their ad-hoc subscription.</p>
            <div style="background-color: #f8f9fa; border-left: 4px solid #2c3e50; padding: 15px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Practitioner:</strong> ${escapedPractitionerName}</p>
              <p style="margin: 5px 0 0 0;"><strong>Email:</strong> ${escapedPractitionerEmail}</p>
              <p style="margin: 5px 0 0 0;"><strong>Termination Date:</strong> ${escapedTerminationDate}</p>
              <p style="margin: 5px 0 0 0;"><strong>Suspension Date:</strong> ${escapedSuspensionDate}</p>
            </div>
            <p>The practitioner can continue to use the service until the suspension date, after which their account will be suspended.</p>
            <p>Best regards,<br>The Therapport System</p>
          </div>
        </body>
      </html>
    `;

    // Send to admin email
    const adminEmail = ADMIN_EMAIL;
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: adminEmail,
      subject: 'Subscription Termination Notification - Therapport',
      html,
    });
  }
}

export const emailService = new EmailService();
