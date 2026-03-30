import { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../config/database';
import { users, memberships } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as SubscriptionService from '../services/subscription.service';
import * as StripePaymentService from '../services/stripe-payment.service';
import { LIST_INVOICES_MISSING_CUSTOMER_ID } from '../services/stripe-payment.service';
import { isStripeConfigured } from '../config/stripe';
import {
  MembershipNotFoundError,
  OnlyAdHocTerminableError,
  SubscriptionServiceError,
} from '../errors/subscription.errors';
import { logger } from '../utils/logger.util';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseOptionalDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (!DATE_REGEX.test(value.trim())) return undefined;
  const d = new Date(value.trim() + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return undefined;
  return value.trim();
}

export class SubscriptionController {
  /**
   * GET /api/practitioner/subscriptions/status
   * Returns subscription status and membership details for the practitioner UI.
   */
  async getStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const details = await SubscriptionService.getSubscriptionStatusDetails(userId);
      res.status(200).json({ success: true, ...details });
    } catch (error) {
      logger.error(
        'Failed to get subscription status',
        error instanceof Error ? error : new Error(String(error)),
        { userId: req.user?.id }
      );
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get subscription status',
      });
    }
  }

  /**
   * POST /api/practitioner/subscriptions/monthly
   * Body: { joinDate?: string } (YYYY-MM-DD). Defaults to today if omitted.
   * Returns Stripe data for frontend to complete payment (clientSecret, subscriptionId, prorata amounts).
   */
  async createMonthly(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const joinDateStr =
        parseOptionalDate(req.body?.joinDate) ?? new Date().toISOString().split('T')[0];

      const [user] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || undefined;

      const result = await SubscriptionService.createMonthlySubscription(
        userId,
        joinDateStr,
        user.email,
        name ?? user.email
      );
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create monthly subscription';
      if (message.includes('not configured')) {
        res.status(503).json({ success: false, error: message });
        return;
      }
      logger.error(
        'Failed to create monthly subscription',
        error instanceof Error ? error : new Error(String(error)),
        { userId: req.user?.id }
      );
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * POST /api/practitioner/subscriptions/ad-hoc
   * Body: { purchaseDate?: string } (YYYY-MM-DD). Defaults to today if omitted.
   * Returns Stripe payment intent (clientSecret, paymentIntentId) for £150 ad-hoc subscription.
   */
  async createAdHoc(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const purchaseDateStr =
        parseOptionalDate(req.body?.purchaseDate) ?? new Date().toISOString().split('T')[0];

      const [user] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || undefined;

      const result = await SubscriptionService.createAdHocSubscription(
        userId,
        purchaseDateStr,
        user.email,
        name ?? user.email
      );
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create ad-hoc subscription';
      if (message.includes('not configured')) {
        res.status(503).json({ success: false, error: message });
        return;
      }
      logger.error(
        'Failed to create ad-hoc subscription',
        error instanceof Error ? error : new Error(String(error)),
        { userId: req.user?.id }
      );
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * POST /api/practitioner/subscriptions/terminate
   * Body: { terminationDate?: string } (YYYY-MM-DD). Defaults to today if omitted.
   * Terminates ad-hoc subscription and sets suspension date (grace period until end of month after termination month).
   */
  async terminate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const terminationDateStr =
        parseOptionalDate(req.body?.terminationDate) ?? new Date().toISOString().split('T')[0];

      await SubscriptionService.terminateAdHocSubscription(userId, terminationDateStr);
      const suspensionDate = SubscriptionService.calculateSuspensionDate(terminationDateStr);
      res.status(200).json({
        success: true,
        message: 'Ad-hoc subscription termination requested',
        suspensionDate,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to terminate subscription';
      if (error instanceof MembershipNotFoundError) {
        res.status(error.statusCode).json({ success: false, error: message });
        return;
      }
      if (error instanceof OnlyAdHocTerminableError) {
        res.status(error.statusCode).json({ success: false, error: message });
        return;
      }
      if (error instanceof SubscriptionServiceError) {
        res.status(error.statusCode).json({ success: false, error: message });
        return;
      }
      logger.error(
        'Failed to terminate ad-hoc subscription',
        error instanceof Error ? error : new Error(String(error)),
        { userId: req.user?.id }
      );
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * GET /api/practitioner/invoices
   * List Stripe invoices for the current user (by stripeCustomerId). Download via invoice_pdf URL from Stripe only; no DB.
   */
  async getInvoices(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      if (!isStripeConfigured()) {
        res.status(200).json({ success: true, invoices: [] });
        return;
      }
      const [row] = await db
        .select({ stripeCustomerId: memberships.stripeCustomerId })
        .from(memberships)
        .where(eq(memberships.userId, userId))
        .limit(1);
      const customerId = row?.stripeCustomerId?.trim() ?? '';
      if (!customerId) {
        res.status(200).json({ success: true, invoices: [] });
        return;
      }
      const invoices = await StripePaymentService.listInvoicesForCustomer(customerId);
      res.status(200).json({ success: true, invoices });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message === LIST_INVOICES_MISSING_CUSTOMER_ID) {
        res.status(404).json({ success: false, error: 'No billing account found' });
        return;
      }
      logger.error('Failed to list invoices', err, { userId: req.user?.id });
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
}

export const subscriptionController = new SubscriptionController();
