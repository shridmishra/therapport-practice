import { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../config/database';
import {
  users,
  memberships,
  documents,
  clinicalExecutors,
  bookings,
  creditLedgers,
  freeBookingVouchers,
  kioskLogs,
  invoices,
  emailNotifications,
  passwordResets,
  emailChangeRequests,
  rooms,
} from '../db/schema';
import { eq, and, or, not, ilike, aliasedTable, isNull, sql, SQL, count, gte, lte, lt, desc, ne } from 'drizzle-orm';
import { logger } from '../utils/logger.util';
import { z, ZodError } from 'zod';
import { FileService } from '../services/file.service';
import { ReminderService } from '../services/reminder.service';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '../config/r2';
import { calculateExpiryStatus } from '../utils/date.util';
import { CreditService } from '../services/credit.service';
import { VoucherService } from '../services/voucher.service';
import { getRevenueForMonthGbp } from '../services/stripe-payment.service';

const updateMembershipSchema = z.object({
  type: z.enum(['permanent', 'ad_hoc']).nullable().optional(),
  marketingAddon: z.boolean().optional(),
});

const updatePractitionerSchema = z.object({
  firstName: z.string().min(1, 'First name is required').trim().optional(),
  lastName: z.string().min(1, 'Last name is required').trim().optional(),
  phone: z.string().min(1, 'Phone must be at least 1 character').nullable().optional(),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
});

const updateNextOfKinSchema = z.object({
  name: z.string().min(1, 'Name is required').trim(),
  relationship: z.string().min(1, 'Relationship is required').trim(),
  phone: z.string().min(1, 'Phone is required').trim(),
  email: z.string().email('Invalid email address').optional().or(z.literal('')).transform(val => val === '' ? undefined : val),
});

const updateClinicalExecutorSchema = z.object({
  name: z.string().min(1, 'Name is required').trim(),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(1, 'Phone is required').trim(),
});

const updateDocumentExpirySchema = z.object({
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be in YYYY-MM-DD format').nullable().optional(),
});

const referenceUploadUrlSchema = z.object({
  filename: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().positive(),
});

const referenceConfirmSchema = z.object({
  filePath: z.string().min(1),
  fileName: z.string().min(1),
  oldDocumentId: z.string().uuid().optional(),
});

/** Operating hours 08:00–22:00 = 14h per room per day for occupancy capacity. */
const DAILY_OPERATING_HOURS = 14;

export class AdminController {
  async getPractitioners(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const searchQuery = req.query.search as string | undefined;

      // Parse and validate pagination parameters
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limitRaw = parseInt(req.query.limit as string) || 20;
      const maxLimit = 100;
      const limit = Math.min(Math.max(1, limitRaw), maxLimit);
      const offset = (page - 1) * limit;

      // Build where conditions
      const whereConditions: SQL<unknown>[] = [eq(users.role, 'practitioner')];

      // Add search filter if provided
      if (searchQuery && searchQuery.trim()) {
        const searchTerm = `%${searchQuery.trim()}%`;
        const searchCondition = or(
          ilike(users.email, searchTerm),
          ilike(users.firstName, searchTerm),
          ilike(users.lastName, searchTerm)
        );
        // Note: or() always returns a truthy SQL condition when given arguments,
        // but TypeScript types it as potentially undefined, so we keep this check for type safety
        if (searchCondition) {
          whereConditions.push(searchCondition);
        }
      }

      // Get total count for pagination metadata
      const [countResult] = await db
        .select({ count: count() })
        .from(users)
        .leftJoin(memberships, eq(users.id, memberships.userId))
        .where(and(...whereConditions));

      const totalCount = countResult?.count || 0;
      const totalPages = Math.ceil(totalCount / limit);

      // Build query with pagination
      const practitioners = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          membershipType: memberships.type,
          marketingAddon: memberships.marketingAddon,
        })
        .from(users)
        .leftJoin(memberships, eq(users.id, memberships.userId))
        .where(and(...whereConditions))
        .limit(limit)
        .offset(offset);

      // Format response
      const formattedPractitioners = practitioners.map((p) => ({
        id: p.id,
        email: p.email,
        firstName: p.firstName,
        lastName: p.lastName,
        status: p.status,
        membership: p.membershipType
          ? {
            type: p.membershipType,
            marketingAddon: p.marketingAddon || false,
          }
          : null,
      }));

      res.status(200).json({
        success: true,
        data: formattedPractitioners,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages,
        },
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get practitioners list',
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

  async getAdminStats(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
      const now = new Date();
      const firstDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
      const defaultFrom = firstDayOfMonth.toISOString().split('T')[0];
      const defaultTo = lastDayOfMonth.toISOString().split('T')[0];

      const fromDate = (req.query.fromDate as string)?.trim() || defaultFrom;
      const toDate = (req.query.toDate as string)?.trim() || defaultTo;
      if (!DATE_REGEX.test(fromDate) || !DATE_REGEX.test(toDate)) {
        return res.status(400).json({
          success: false,
          error: 'fromDate and toDate must be YYYY-MM-DD',
        });
      }
      if (fromDate > toDate) {
        return res.status(400).json({
          success: false,
          error: 'fromDate must be before or equal to toDate',
        });
      }

      // Practitioner and membership counts
      const [result] = await db
        .select({ count: count() })
        .from(users)
        .where(eq(users.role, 'practitioner'));

      const practitionerCount = result?.count || 0;

      const [membershipCounts] = await db
        .select({
          adHocCount: sql<number>`count(*) filter (where ${memberships.type} = 'ad_hoc')`,
          permanentCount: sql<number>`count(*) filter (where ${memberships.type} = 'permanent')`,
        })
        .from(memberships);

      // Occupancy: booked slot-hours vs total slot capacity in date range (08:00–22:00 = 14h per room per day)
      const [roomCountRow] = await db
        .select({ count: count() })
        .from(rooms)
        .where(eq(rooms.active, true));
      const roomCount = roomCountRow?.count || 0;

      const fromDateObj = new Date(fromDate + 'T12:00:00Z');
      const toDateObj = new Date(toDate + 'T12:00:00Z');
      const daysInRange =
        Math.max(0, Math.ceil((toDateObj.getTime() - fromDateObj.getTime()) / (24 * 60 * 60 * 1000)) + 1);
      const totalSlotHours = daysInRange * roomCount * DAILY_OPERATING_HOURS;

      const confirmedBookingsInRange = await db
        .select({
          startTime: bookings.startTime,
          endTime: bookings.endTime,
        })
        .from(bookings)
        .where(
          and(
            or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed')),
            gte(bookings.bookingDate, fromDate),
            lte(bookings.bookingDate, toDate)
          )
        );

      let bookedHours = 0;
      for (const b of confirmedBookingsInRange) {
        const startTime = String(b.startTime);
        const endTime = String(b.endTime);
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        const startMins = sh * 60 + (sm || 0);
        const endMins = eh * 60 + (em || 0);
        const durationMins = (endMins - startMins + 24 * 60) % (24 * 60);
        bookedHours += durationMins / 60;
      }
      const occupancyPercent =
        totalSlotHours > 0 ? Math.min(100, Math.round((bookedHours / totalSlotHours) * 100 * 100) / 100) : 0;

      // Revenue: current month only — Stripe (from API) + booking total_price (confirmed/completed)
      const stripeRevenue = await getRevenueForMonthGbp({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      });

      const [bookingRevenueRow] = await db
        .select({
          total: sql<string>`coalesce(sum(${bookings.totalPrice}), 0)`,
        })
        .from(bookings)
        .where(
          and(
            or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed')),
            ne(bookings.bookingType, 'free'),
            gte(bookings.bookingDate, defaultFrom),
            lte(bookings.bookingDate, defaultTo)
          )
        );
      const bookingRevenue = parseFloat(bookingRevenueRow?.total ?? '0') || 0;
      const revenueCurrentMonthGbp = stripeRevenue + bookingRevenue;

      res.status(200).json({
        success: true,
        data: {
          practitionerCount,
          adHocCount: membershipCounts?.adHocCount || 0,
          permanentCount: membershipCounts?.permanentCount || 0,
          occupancy: {
            fromDate,
            toDate,
            totalSlotHours,
            bookedHours: Math.round(bookedHours * 100) / 100,
            occupancyPercent,
          },
          revenueCurrentMonthGbp: Math.round(revenueCurrentMonthGbp * 100) / 100,
        },
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get admin stats',
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

  async getPractitioner(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;

      // Build query with leftJoin
      const result = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          role: users.role,
          status: users.status,
          membershipId: memberships.id,
          membershipType: memberships.type,
          marketingAddon: memberships.marketingAddon,
        })
        .from(users)
        .leftJoin(memberships, eq(users.id, memberships.userId))
        .where(and(eq(users.id, userId), eq(users.role, 'practitioner')))
        .limit(1);

      if (result.length === 0) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      const practitioner = result[0];

      res.status(200).json({
        success: true,
        data: {
          id: practitioner.id,
          email: practitioner.email,
          firstName: practitioner.firstName,
          lastName: practitioner.lastName,
          phone: practitioner.phone || undefined,
          role: practitioner.role,
          status: practitioner.status,
          membership: practitioner.membershipType
            ? {
              id: practitioner.membershipId,
              type: practitioner.membershipType,
              marketingAddon: practitioner.marketingAddon,
            }
            : null,
        },
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get practitioner details',
        error,
        {
          userId: req.user?.id,
          targetUserId: req.params.userId,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Get full practitioner details including next of kin, documents, clinical executor
  async getFullPractitioner(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;

      // Get user with membership
      const userResult = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          photoUrl: users.photoUrl,
          role: users.role,
          status: users.status,
          nextOfKin: users.nextOfKin,
          createdAt: users.createdAt,
          membershipId: memberships.id,
          membershipType: memberships.type,
          marketingAddon: memberships.marketingAddon,
        })
        .from(users)
        .leftJoin(memberships, eq(users.id, memberships.userId))
        .where(and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)))
        .limit(1);

      if (userResult.length === 0) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      const practitioner = userResult[0];

      // Get documents
      const userDocuments = await db
        .select()
        .from(documents)
        .where(eq(documents.userId, userId));

      // Get clinical executor
      const executorResult = await db
        .select()
        .from(clinicalExecutors)
        .where(eq(clinicalExecutors.userId, userId))
        .limit(1);

      res.status(200).json({
        success: true,
        data: {
          id: practitioner.id,
          email: practitioner.email,
          firstName: practitioner.firstName,
          lastName: practitioner.lastName,
          phone: practitioner.phone || undefined,
          photoUrl: practitioner.photoUrl || undefined,
          role: practitioner.role,
          status: practitioner.status,
          nextOfKin: practitioner.nextOfKin || null,
          createdAt: practitioner.createdAt,
          membership: practitioner.membershipType
            ? {
              id: practitioner.membershipId,
              type: practitioner.membershipType,
              marketingAddon: practitioner.marketingAddon,
            }
            : null,
          documents: await Promise.all(userDocuments.map(async (doc) => ({
            id: doc.id,
            documentType: doc.documentType,
            fileName: doc.fileName,
            fileUrl: await FileService.generatePresignedGetUrl(doc.fileUrl, 'documents'),
            expiryDate: doc.expiryDate,
            createdAt: doc.createdAt,
          }))),
          clinicalExecutor: executorResult.length > 0
            ? {
              id: executorResult[0].id,
              name: executorResult[0].name,
              email: executorResult[0].email,
              phone: executorResult[0].phone,
            }
            : null,
        },
      });
    } catch (error: unknown) {
      logger.error('Failed to get full practitioner details', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** GET /admin/practitioners/:userId/credits – admin view of practitioner credit + voucher summary */
  async getPractitionerCredits(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      const { userId } = req.params;
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });
      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }
      const [creditSummary, voucherSummary] = await Promise.all([
        CreditService.getCreditBalance(userId),
        VoucherService.getRemainingFreeHours(userId),
      ]);
      res.status(200).json({
        success: true,
        data: { credit: creditSummary, voucher: voucherSummary },
      });
    } catch (error: unknown) {
      logger.error('Failed to get practitioner credits', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** POST /admin/practitioners/:userId/vouchers – allocate free booking hours */
  async allocateVoucher(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      const { userId } = req.params;
      const schema = z.object({
        hoursAllocated: z.number().positive('Hours must be positive'),
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
        reason: z.string().optional(),
      });
      const body = await schema.parseAsync(req.body);
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });
      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }
      const [row] = await db
        .insert(freeBookingVouchers)
        .values({
          userId,
          hoursAllocated: String(body.hoursAllocated),
          hoursUsed: '0.00',
          expiryDate: body.expiryDate,
          reason: body.reason ?? null,
        })
        .returning();
      res.status(201).json({
        success: true,
        data: {
          id: row.id,
          hoursAllocated: body.hoursAllocated,
          expiryDate: body.expiryDate,
          reason: row.reason ?? undefined,
        },
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: error.errors.map((e) => e.message).join(', ') });
      }
      logger.error('Failed to allocate voucher', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Update practitioner profile (name, phone)
  async updatePractitioner(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;

      // Validate request body
      const validated = await updatePractitionerSchema.parseAsync(req.body);

      const { firstName, lastName, phone, status } = validated;

      // Verify practitioner exists
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      // Build update object
      const updateData: {
        firstName?: string;
        lastName?: string;
        phone?: string | null;
        status?: 'pending' | 'active' | 'suspended' | 'rejected';
        updatedAt: Date
      } = {
        updatedAt: new Date(),
      };

      if (firstName !== undefined) updateData.firstName = firstName;
      if (lastName !== undefined) updateData.lastName = lastName;
      if (phone !== undefined) updateData.phone = phone || null;
      if (status !== undefined) updateData.status = status;

      const [updated] = await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, userId))
        .returning();

      res.status(200).json({
        success: true,
        data: {
          id: updated.id,
          firstName: updated.firstName,
          lastName: updated.lastName,
          phone: updated.phone || undefined,
          status: updated.status,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
      }
      logger.error('Failed to update practitioner', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Update next of kin
  async updateNextOfKin(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;

      // Validate request body
      let validated;
      try {
        validated = await updateNextOfKinSchema.parseAsync(req.body);
      } catch (error) {
        if (error instanceof ZodError) {
          return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
        }
        throw error;
      }

      const { name, relationship, phone, email } = validated;

      // Verify practitioner exists
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      const nextOfKinData = { name, relationship, phone, email };

      const [updated] = await db
        .update(users)
        .set({ nextOfKin: nextOfKinData, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();

      res.status(200).json({
        success: true,
        data: {
          nextOfKin: updated.nextOfKin,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
      }
      logger.error('Failed to update next of kin', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Update clinical executor
  async updateClinicalExecutor(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;

      // Validate request body
      const validated = await updateClinicalExecutorSchema.parseAsync(req.body);

      const { name, email, phone } = validated;

      // Verify practitioner exists
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      // Check if clinical executor exists
      const existing = await db.query.clinicalExecutors.findFirst({
        where: eq(clinicalExecutors.userId, userId),
      });

      let result;
      if (existing) {
        // Update existing
        [result] = await db
          .update(clinicalExecutors)
          .set({ name, email, phone, updatedAt: new Date() })
          .where(eq(clinicalExecutors.userId, userId))
          .returning();
      } else {
        // Create new
        [result] = await db
          .insert(clinicalExecutors)
          .values({ userId, name, email, phone })
          .returning();
      }

      res.status(200).json({
        success: true,
        data: {
          id: result.id,
          name: result.name,
          email: result.email,
          phone: result.phone,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
      }
      logger.error('Failed to update clinical executor', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Delete practitioner (hard delete with cascade)
  async deletePractitioner(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;
      const { confirm } = req.query;
      const isHardDelete = confirm === 'true';

      // Verify practitioner exists
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner')),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      // 1. Audit - Gather counts of related entities
      const [aggregatedCounts] = await db
        .select({
          memberships: sql<number>`(SELECT count(*) FROM ${memberships} WHERE ${memberships.userId} = ${userId})`,
          bookings: sql<number>`(SELECT count(*) FROM ${bookings} WHERE ${bookings.userId} = ${userId})`,
          creditLedgers: sql<number>`(SELECT count(*) FROM ${creditLedgers} WHERE ${creditLedgers.userId} = ${userId})`,
          freeBookingVouchers: sql<number>`(SELECT count(*) FROM ${freeBookingVouchers} WHERE ${freeBookingVouchers.userId} = ${userId})`,
          documents: sql<number>`(SELECT count(*) FROM ${documents} WHERE ${documents.userId} = ${userId})`,
          clinicalExecutors: sql<number>`(SELECT count(*) FROM ${clinicalExecutors} WHERE ${clinicalExecutors.userId} = ${userId})`,
          kioskLogs: sql<number>`(SELECT count(*) FROM ${kioskLogs} WHERE ${kioskLogs.userId} = ${userId})`,
          invoices: sql<number>`(SELECT count(*) FROM ${invoices} WHERE ${invoices.userId} = ${userId})`,
          emailNotifications: sql<number>`(SELECT count(*) FROM ${emailNotifications} WHERE ${emailNotifications.userId} = ${userId})`,
          passwordResets: sql<number>`(SELECT count(*) FROM ${passwordResets} WHERE ${passwordResets.userId} = ${userId})`,
          emailChangeRequests: sql<number>`(SELECT count(*) FROM ${emailChangeRequests} WHERE ${emailChangeRequests.userId} = ${userId})`,
        })
        .from(users)
        .where(eq(users.id, userId));

      const auditData = {
        action: isHardDelete ? 'HARD_DELETE_PRACTITIONER' : 'SOFT_DELETE_PRACTITIONER',
        targetUserId: userId,
        performedBy: req.user.id,
        timestamp: new Date(),
        affectedEntities: {
          memberships: Number(aggregatedCounts?.memberships || 0),
          bookings: Number(aggregatedCounts?.bookings || 0),
          creditLedgers: Number(aggregatedCounts?.creditLedgers || 0),
          freeBookingVouchers: Number(aggregatedCounts?.freeBookingVouchers || 0),
          documents: Number(aggregatedCounts?.documents || 0),
          clinicalExecutors: Number(aggregatedCounts?.clinicalExecutors || 0),
          kioskLogs: Number(aggregatedCounts?.kioskLogs || 0),
          invoices: Number(aggregatedCounts?.invoices || 0),
          emailNotifications: Number(aggregatedCounts?.emailNotifications || 0),
          passwordResets: Number(aggregatedCounts?.passwordResets || 0),
          emailChangeRequests: Number(aggregatedCounts?.emailChangeRequests || 0),
        }
      };

      // Log the audit record
      logger.warn(`[AUDIT] ${JSON.stringify(auditData)}`);

      if (isHardDelete) {
        // Hard delete (cascades to all related tables due to ON DELETE CASCADE)
        await db.delete(users).where(eq(users.id, userId));
        logger.info(`Practitioner hard deleted: ${userId}`);
        return res.status(200).json({ success: true, message: 'Practitioner permanently deleted' });
      } else {
        // Soft delete / Deactivate
        await db.update(users)
          .set({
            status: 'suspended',
            deletedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(users.id, userId));

        logger.info(`Practitioner soft deleted/deactivated: ${userId}`);
        return res.status(200).json({ success: true, message: 'Practitioner deactivated via soft delete' });
      }
    } catch (error: unknown) {
      logger.error('Failed to delete practitioner', error, {
        userId: req.user?.id,
        targetUserId: req.params.userId,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async updateMembership(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId } = req.params;
      const data = updateMembershipSchema.parse(req.body);

      // Verify practitioner exists and is a practitioner
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner')),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      // Get current membership
      const currentMembership = await db.query.memberships.findFirst({
        where: eq(memberships.userId, userId),
      });



      // Handle membership deletion (type: null)
      if (data.type === null && currentMembership) {
        await db.delete(memberships).where(eq(memberships.id, currentMembership.id));
        return res.status(200).json({
          success: true,
          data: null,
        });
      }

      // Update or create membership
      if (currentMembership) {
        // Update existing membership
        const updateData: {
          type?: 'permanent' | 'ad_hoc';
          marketingAddon?: boolean;
        } = {};

        if (data.type !== undefined && data.type !== null) {
          updateData.type = data.type;
        }

        if (data.marketingAddon !== undefined) {
          updateData.marketingAddon = data.marketingAddon;
          // If disabling marketing add-on, no type change needed
          // If enabling, we already validated type is permanent
        }



        // Atomic conditional update: include expected current values in WHERE clause
        // to detect concurrent modifications (TOCTOU protection)
        const updatedRows = await db
          .update(memberships)
          .set({
            ...updateData,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(memberships.id, currentMembership.id),
              eq(memberships.type, currentMembership.type),
              eq(memberships.marketingAddon, currentMembership.marketingAddon)
            )
          )
          .returning();

        // If no rows were updated, membership was modified concurrently
        if (updatedRows.length === 0) {
          return res.status(409).json({
            success: false,
            error: 'Membership was modified by another request. Please refresh and try again.',
          });
        }

        // Use the returned row from the update
        const updatedMembership = updatedRows[0];

        res.status(200).json({
          success: true,
          data: {
            id: updatedMembership.id,
            type: updatedMembership.type,
            marketingAddon: updatedMembership.marketingAddon,
          },
        });
      } else {
        // Create new membership
        if (!data.type || data.type === null) {
          return res.status(400).json({
            success: false,
            error: 'Membership type is required when creating a new membership',
          });
        }

        const [newMembership] = await db
          .insert(memberships)
          .values({
            userId,
            type: data.type,
            marketingAddon: data.marketingAddon ?? false,
          })
          .returning();

        res.status(200).json({
          success: true,
          data: {
            id: newMembership.id,
            type: newMembership.type,
            marketingAddon: newMembership.marketingAddon,
          },
        });
      }
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: error.errors.map((e) => e.message).join(', '),
        });
      }

      logger.error(
        'Failed to update membership',
        error,
        {
          userId: req.user?.id,
          targetUserId: req.params.userId,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
  async getPractitionersWithMissingInfo(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;

      // Use UTC YYYY-MM-DD for comparison to match "start of day" logic consistently
      const dateNow = new Date().toISOString().split('T')[0];

      // Aliases for joining documents
      const insuranceDocs = aliasedTable(documents, 'insurance_docs');
      const registrationDocs = aliasedTable(documents, 'registration_docs');
      const referenceDocs = aliasedTable(documents, 'reference_docs');

      // Common Where Clause Conditions
      const missingInsurance = or(
        isNull(insuranceDocs.id),
        sql`${insuranceDocs.expiryDate} < ${dateNow}`
      );

      const marketingAddonRequired = eq(memberships.marketingAddon, true);

      const missingRegistration = and(
        marketingAddonRequired,
        or(
          isNull(registrationDocs.id),
          sql`${registrationDocs.expiryDate} < ${dateNow}`
        )
      );

      const missingReference = isNull(referenceDocs.id);

      // Removed redundant isNull checks on non-nullable columns (name, email, phone)
      const missingExecutor = and(
        marketingAddonRequired,
        isNull(clinicalExecutors.id)
      );

      // We want users who have ANY of these missing items
      const whereClause = and(
        eq(users.role, 'practitioner'),
        or(missingInsurance, missingRegistration, missingReference, missingExecutor)
      );

      // 1. Get Total Count
      const [countResult] = await db
        .select({ count: sql<number>`count(distinct ${users.id})` })
        .from(users)
        .leftJoin(memberships, eq(memberships.userId, users.id))
        .leftJoin(insuranceDocs, and(eq(insuranceDocs.userId, users.id), eq(insuranceDocs.documentType, 'insurance')))
        .leftJoin(registrationDocs, and(eq(registrationDocs.userId, users.id), eq(registrationDocs.documentType, 'clinical_registration')))
        .leftJoin(referenceDocs, and(eq(referenceDocs.userId, users.id), eq(referenceDocs.documentType, 'reference')))
        .leftJoin(clinicalExecutors, eq(clinicalExecutors.userId, users.id))
        .where(whereClause);

      const total = Number(countResult.count);
      const totalPages = Math.ceil(total / limit);

      // 2. Get Paginated Data
      const rows = await db
        .select({
          user: users,
          membership: memberships,
          insurance: insuranceDocs,
          registration: registrationDocs,
          reference: referenceDocs,
          executor: clinicalExecutors,
        })
        .from(users)
        .leftJoin(memberships, eq(memberships.userId, users.id))
        .leftJoin(insuranceDocs, and(eq(insuranceDocs.userId, users.id), eq(insuranceDocs.documentType, 'insurance')))
        .leftJoin(registrationDocs, and(eq(registrationDocs.userId, users.id), eq(registrationDocs.documentType, 'clinical_registration')))
        .leftJoin(referenceDocs, and(eq(referenceDocs.userId, users.id), eq(referenceDocs.documentType, 'reference')))
        .leftJoin(clinicalExecutors, eq(clinicalExecutors.userId, users.id))
        .where(whereClause)
        .orderBy(users.lastName, users.firstName) // Deterministic ordering
        .limit(limit)
        .offset(offset);

      const results = rows.map((row) => {
        const missing: string[] = [];

        // Consistent UTC start-of-day comparison
        const todayStr = new Date().toISOString().split('T')[0];

        const isExpired = (d: string | null) => {
          if (!d) return false;
          // Compare string-to-string (YYYY-MM-DD < YYYY-MM-DD) which handles UTC automatically
          return d < todayStr;
        }

        // Insurance
        if (!row.insurance) {
          missing.push('Insurance (Missing)');
        } else if (isExpired(row.insurance.expiryDate)) {
          missing.push('Insurance (Expired)');
        }

        // Reference (one per practitioner)
        if (!row.reference) {
          missing.push('References (Missing)');
        }

        // Marketing Addon Checks
        if (row.membership?.marketingAddon) {
          // Registration
          if (!row.registration) {
            missing.push('Registration (Missing)');
          } else if (isExpired(row.registration.expiryDate)) {
            missing.push('Registration (Expired)');
          }

          // Executor
          if (!row.executor) {
            missing.push('Clinical executor');
          }
          // Note: name, email, phone are not null in schema, so strictly we only check existence
        }

        return {
          id: row.user.id,
          name: `${row.user.firstName} ${row.user.lastName}`,
          missing,
        };
      });

      res.status(200).json({
        success: true,
        data: {
          data: results,
          pagination: {
            total,
            page,
            totalPages,
            limit,
          },
        },
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to get practitioners with missing info',
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

  /** POST /admin/practitioners/:userId/documents/reference/upload-url */
  async getReferenceUploadUrl(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      const { userId } = req.params;
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });
      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }
      if (!R2_BUCKET_NAME) {
        res.status(500).json({ success: false, error: 'File storage service is not configured' });
        return;
      }
      const data = referenceUploadUrlSchema.parse(req.body);
      const validation = FileService.validateDocumentFile({
        filename: data.filename,
        fileType: data.fileType,
        fileSize: data.fileSize,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.error });
      }
      const currentDocument = await db.query.documents.findFirst({
        where: and(eq(documents.userId, userId), eq(documents.documentType, 'reference')),
        orderBy: (documents, { desc }) => [desc(documents.createdAt)],
      });
      const filePath = FileService.generateFilePath(userId, 'documents', data.filename);
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
        return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
      }
      logger.error('Failed to get reference upload URL', error, { userId: req.user?.id, targetUserId: req.params.userId });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** PUT /admin/practitioners/:userId/documents/reference/confirm */
  async confirmReferenceUpload(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      const { userId } = req.params;
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });
      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }
      const data = referenceConfirmSchema.parse(req.body);
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: data.filePath,
        });
        await r2Client.send(headCommand);
      } catch (err: unknown) {
        const errObj = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (errObj.name === 'NotFound' || errObj.$metadata?.httpStatusCode === 404) {
          return res.status(400).json({ success: false, error: 'Uploaded file not found. Please try uploading again.' });
        }
        logger.error('R2 error verifying reference file', err, { filePath: data.filePath });
        return res.status(500).json({ success: false, error: 'Failed to verify uploaded file' });
      }
      const { newDocument, oldDocument } = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(documents)
          .values({
            userId,
            documentType: 'reference',
            fileUrl: data.filePath,
            fileName: data.fileName,
            expiryDate: null,
          })
          .returning();
        const [latest] = await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.userId, userId),
              eq(documents.documentType, 'reference'),
              not(eq(documents.id, inserted.id))
            )
          )
          .orderBy(desc(documents.createdAt))
          .limit(1);
        if (latest) {
          await tx.delete(documents).where(eq(documents.id, latest.id));
        }
        return { newDocument: inserted, oldDocument: latest ?? null };
      });
      if (oldDocument) {
        try {
          await FileService.deleteFile(FileService.extractFilePath(oldDocument.fileUrl));
        } catch (err) {
          logger.error('Failed to delete old reference file from R2', err, { oldDocumentId: oldDocument.id });
        }
      }
      const documentUrl = await FileService.generatePresignedGetUrl(newDocument.fileUrl, 'documents');
      res.status(200).json({
        success: true,
        data: {
          id: newDocument.id,
          fileName: newDocument.fileName,
          documentUrl,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({ success: false, error: 'Validation failed', details: error.flatten() });
      }
      logger.error('Failed to confirm reference upload', error, { userId: req.user?.id, targetUserId: req.params.userId });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // Update document expiry date
  async updateDocumentExpiry(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const { userId, documentId } = req.params;

      // Validate request body
      const validated = await updateDocumentExpirySchema.parseAsync(req.body);

      // Verify practitioner exists
      const practitioner = await db.query.users.findFirst({
        where: and(eq(users.id, userId), eq(users.role, 'practitioner'), isNull(users.deletedAt)),
      });

      if (!practitioner) {
        return res.status(404).json({ success: false, error: 'Practitioner not found' });
      }

      // Verify document exists and belongs to the practitioner
      const document = await db.query.documents.findFirst({
        where: and(eq(documents.id, documentId), eq(documents.userId, userId)),
      });

      if (!document) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }

      const oldExpiryDate = document.expiryDate;
      const newExpiryDate = validated.expiryDate || null;

      // Update document expiry date
      const [updatedDocument] = await db
        .update(documents)
        .set({
          expiryDate: newExpiryDate,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
        .returning();

      // If expiry date changed and new date is provided, reschedule reminders (insurance and clinical_registration only)
      if (oldExpiryDate !== newExpiryDate && newExpiryDate) {
        await ReminderService.cancelDocumentReminders(documentId);
        if (document.documentType === 'insurance' || document.documentType === 'clinical_registration') {
          await ReminderService.scheduleDocumentReminders(
            userId,
            documentId,
            document.documentType,
            document.fileName,
            newExpiryDate
          );
        }
      } else if (oldExpiryDate && !newExpiryDate) {
        // If expiry date was removed, cancel existing reminders
        await ReminderService.cancelDocumentReminders(documentId);
      }

      // Calculate expiry status
      const { isExpired, isExpiringSoon, daysUntilExpiry } = calculateExpiryStatus(updatedDocument.expiryDate);

      res.status(200).json({
        success: true,
        data: {
          id: updatedDocument.id,
          documentType: updatedDocument.documentType,
          fileName: updatedDocument.fileName,
          expiryDate: updatedDocument.expiryDate,
          isExpired,
          isExpiringSoon,
          daysUntilExpiry,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.flatten(),
        });
      }

      logger.error(
        'Failed to update document expiry',
        error,
        {
          userId: req.user?.id,
          targetUserId: req.params.userId,
          documentId: req.params.documentId,
          method: req.method,
          url: req.originalUrl,
        }
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const adminController = new AdminController();

