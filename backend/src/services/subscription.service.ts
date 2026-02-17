/**
 * Subscription service: monthly and ad-hoc subscriptions, termination, suspension date.
 * Stripe payment creation and credit granting (webhook) are wired in PR 8; here we implement
 * pro-rata/suspension logic and Stripe customer/subscription/payment-intent creation.
 */

import { db } from '../config/database';
import { memberships, users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { todayUtcString } from '../utils/date.util';
import * as BookingService from './booking.service';
import * as ProrataService from './prorata.service';
import * as StripePaymentService from './stripe-payment.service';
import * as CreditTransactionService from './credit-transaction.service';
import { isStripeConfigured } from '../config/stripe';
import { MembershipNotFoundError, OnlyAdHocTerminableError } from '../errors/subscription.errors';
import { logger } from '../utils/logger.util';
import { emailService } from './email.service';

/**
 * Get existing Stripe customer ID from membership or by email, or create a new customer and persist to membership.
 * Avoids duplicate Stripe customers for the same user.
 */
async function getOrCreateStripeCustomerId(
  userId: string,
  email: string,
  name: string
): Promise<string> {
  const [membership] = await db
    .select({ id: memberships.id, stripeCustomerId: memberships.stripeCustomerId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);

  const existingId = membership?.stripeCustomerId?.trim();
  if (existingId) {
    return existingId;
  }

  const customerIdByEmail = await StripePaymentService.findCustomerByEmail(email);
  if (customerIdByEmail && membership) {
    await db
      .update(memberships)
      .set({ stripeCustomerId: customerIdByEmail, updatedAt: new Date() })
      .where(eq(memberships.id, membership.id));
    return customerIdByEmail;
  }
  if (customerIdByEmail) {
    return customerIdByEmail;
  }

  const { customerId } = await StripePaymentService.createCustomer({ email, name });
  if (membership) {
    await db
      .update(memberships)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(memberships.id, membership.id));
  }
  return customerId;
}

const AD_HOC_AMOUNT_GBP = 150;
const MONTHLY_AMOUNT_GBP = 105;

/** Stripe Price ID for monthly £105 subscription (set in env). */
function getMonthlyPriceId(): string {
  const id = process.env.STRIPE_MONTHLY_PRICE_ID;
  if (!id || !id.trim()) {
    throw new Error('STRIPE_MONTHLY_PRICE_ID is not set');
  }
  return id.trim();
}

/**
 * Get last day of a given month in UTC as YYYY-MM-DD.
 */
function getLastDayOfMonthString(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const y = lastDay.getUTCFullYear();
  const m = (lastDay.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = lastDay.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Calculate suspension date: last day of the month after the termination month.
 * Example: Terminate March 10 → suspensionDate = April 30.
 */
export function calculateSuspensionDate(terminationDate: Date | string): string {
  const d =
    typeof terminationDate === 'string'
      ? new Date(terminationDate + 'T12:00:00Z')
      : terminationDate;
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('Invalid terminationDate');
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return getLastDayOfMonthString(y, m + 1);
}

export interface SubscriptionStatusResult {
  canBook: boolean;
  reason?: string;
  membership?: {
    type: string;
    subscriptionType: string | null;
    subscriptionEndDate: string | null;
    suspensionDate: string | null;
    terminationRequestedAt: string | null;
  };
  monthlyPriceGbp?: number;
  permanentSlots?: Array<{
    dayOfWeek: string;
    roomName: string;
    locationName: string;
    startTime: string;
    endTime: string;
  }>;
}

function formatMembershipForStatus(membership: {
  type: string;
  subscriptionType: string | null;
  subscriptionEndDate: string | Date | null;
  suspensionDate: string | Date | null;
  terminationRequestedAt: Date | null;
}): SubscriptionStatusResult['membership'] {
  return {
    type: membership.type,
    subscriptionType: membership.subscriptionType,
    subscriptionEndDate:
      membership.subscriptionEndDate != null
        ? String(membership.subscriptionEndDate).slice(0, 10)
        : null,
    suspensionDate:
      membership.suspensionDate != null ? String(membership.suspensionDate).slice(0, 10) : null,
    terminationRequestedAt:
      membership.terminationRequestedAt != null
        ? membership.terminationRequestedAt.toISOString()
        : null,
  };
}

/**
 * Verify user can make bookings: has membership, not suspended, ad-hoc within period / monthly active.
 * Returns membership details so callers (e.g. getSubscriptionStatusDetails) can reuse without a second query.
 */
export async function checkSubscriptionStatus(userId: string): Promise<SubscriptionStatusResult> {
  const [userRow] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userRow) return { canBook: false, reason: 'User not found' };
  if (userRow.status === 'suspended') return { canBook: false, reason: 'Account is suspended' };

  const [membership] = await db
    .select({
      type: memberships.type,
      subscriptionType: memberships.subscriptionType,
      subscriptionEndDate: memberships.subscriptionEndDate,
      suspensionDate: memberships.suspensionDate,
      terminationRequestedAt: memberships.terminationRequestedAt,
      stripeSubscriptionId: memberships.stripeSubscriptionId,
    })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (!membership) return { canBook: false, reason: 'No membership' };

  const today = todayUtcString();
  if (membership.subscriptionType === 'monthly' && membership.stripeSubscriptionId) {
    return { canBook: true, membership: formatMembershipForStatus(membership) };
  }
  if (membership.type === 'ad_hoc') {
    const endDate =
      membership.subscriptionEndDate != null
        ? String(membership.subscriptionEndDate).slice(0, 10)
        : null;
    const suspDate =
      membership.suspensionDate != null ? String(membership.suspensionDate).slice(0, 10) : null;
    // Ad-hoc must have an active paid period to book (subscriptionEndDate > today)
    // Use < instead of <= to allow booking on the expiry date itself (last day of subscription period)
    if (membership.subscriptionType == null || endDate == null || endDate < today) {
      return {
        canBook: false,
        reason: 'Purchase an ad-hoc subscription to make bookings',
        membership: formatMembershipForStatus(membership),
      };
    }
    if (suspDate != null && suspDate <= today) {
      return {
        canBook: false,
        reason: 'Membership is suspended',
        membership: formatMembershipForStatus(membership),
      };
    }
  }
  return { canBook: true, membership: formatMembershipForStatus(membership) };
}

/**
 * Terminate ad-hoc subscription: set terminationRequestedAt and suspensionDate.
 * User can book until suspensionDate; cron (PR 10) will suspend on that date.
 */
export async function terminateAdHocSubscription(
  userId: string,
  terminationDate: Date | string
): Promise<void> {
  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (!membership) throw new MembershipNotFoundError();
  if (membership.type !== 'ad_hoc') {
    throw new OnlyAdHocTerminableError();
  }

  const suspensionDate = calculateSuspensionDate(terminationDate);
  const termDate =
    typeof terminationDate === 'string'
      ? new Date(terminationDate + 'T12:00:00Z')
      : terminationDate;

  await db
    .update(memberships)
    .set({
      terminationRequestedAt: termDate,
      suspensionDate,
      updatedAt: new Date(),
    })
    .where(eq(memberships.id, membership.id));

  // Get user details for email notifications
  const [user] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user) {
    // calculateSuspensionDate returns a string (YYYY-MM-DD format)
    const suspensionDateStr = suspensionDate;
    const terminationDateStr = typeof terminationDate === 'string'
      ? terminationDate
      : termDate.toISOString().split('T')[0];

    // Send user notification email
    try {
      await emailService.sendSubscriptionTerminated({
        firstName: user.firstName,
        email: user.email,
        suspensionDate: suspensionDateStr,
      });
    } catch (error) {
      logger.error('Failed to send subscription termination email to user', error, { userId });
      // Don't throw - email failure shouldn't prevent termination
    }

    // Send admin notification email
    try {
      await emailService.sendAdminSubscriptionTerminated({
        practitionerName: `${user.firstName} ${user.lastName}`,
        practitionerEmail: user.email,
        terminationDate: terminationDateStr,
        suspensionDate: suspensionDateStr,
      });
    } catch (error) {
      logger.error('Failed to send subscription termination email to admin', error, { userId });
      // Don't throw - email failure shouldn't prevent termination
    }
  }
}

export interface CreateMonthlySubscriptionResult {
  customerId: string;
  checkoutUrl?: string;
  subscriptionId?: string;
  clientSecret?: string;
  currentMonthAmount: number;
  nextMonthAmount: number;
  currentMonthExpiry: string;
  nextMonthExpiry: string;
}

/**
 * Create monthly subscription: redirect user to Stripe Checkout to pay. Pro-rata for display; credits granted on payment (webhook).
 */
export async function createMonthlySubscription(
  userId: string,
  joinDate: Date | string,
  email: string,
  name: string
): Promise<CreateMonthlySubscriptionResult> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured');
  }
  const join = typeof joinDate === 'string' ? new Date(joinDate + 'T12:00:00Z') : joinDate;
  if (Number.isNaN(join.getTime())) {
    throw new TypeError('Invalid joinDate');
  }

  const prorata = ProrataService.calculateProrataAmount(join, MONTHLY_AMOUNT_GBP);
  const proratedAmountPence = Math.round(prorata.currentMonthAmount * 100);
  const nextMonthAmountPence = Math.round(prorata.nextMonthAmount * 100);
  const customerId = await getOrCreateStripeCustomerId(userId, email, name);
  const priceId = getMonthlyPriceId();
  const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const { checkoutUrl } = await StripePaymentService.createCheckoutSessionForSubscription({
    customerId,
    priceId,
    userId,
    successUrl: `${baseUrl}/subscription?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/subscription`,
    proratedAmountPence,
    firstInvoiceSplit:
      proratedAmountPence > 0 && nextMonthAmountPence > 0
        ? {
            currentMonthAmountPence: proratedAmountPence,
            nextMonthAmountPence,
            currentMonthExpiry: prorata.currentMonthExpiry,
            nextMonthExpiry: prorata.nextMonthExpiry,
          }
        : undefined,
  });

  return {
    customerId,
    checkoutUrl,
    currentMonthAmount: prorata.currentMonthAmount,
    nextMonthAmount: prorata.nextMonthAmount,
    currentMonthExpiry: prorata.currentMonthExpiry,
    nextMonthExpiry: prorata.nextMonthExpiry,
  };
}

export interface CreateAdHocSubscriptionResult {
  customerId: string;
  clientSecret: string;
  paymentIntentId: string;
}

/**
 * Create ad-hoc subscription: Stripe customer + payment intent for £150.
 * On payment success (webhook in PR 8), credits are granted and membership updated.
 */
export async function createAdHocSubscription(
  userId: string,
  purchaseDate: Date | string,
  email: string,
  name: string
): Promise<CreateAdHocSubscriptionResult> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured');
  }
  const purchase =
    typeof purchaseDate === 'string' ? new Date(purchaseDate + 'T12:00:00Z') : purchaseDate;
  if (Number.isNaN(purchase.getTime())) {
    throw new TypeError('Invalid purchaseDate');
  }

  const customerId = await getOrCreateStripeCustomerId(userId, email, name);
  const amountPence = AD_HOC_AMOUNT_GBP * 100;
  const { paymentIntentId, clientSecret } = await StripePaymentService.createPaymentIntent({
    amount: amountPence,
    currency: 'gbp',
    customerId,
    metadata: {
      type: 'ad_hoc_subscription',
      userId,
      purchaseDate:
        typeof purchaseDate === 'string' ? purchaseDate : purchaseDate.toISOString().split('T')[0],
    },
    description: 'Ad-hoc one-month subscription',
  });

  return { customerId, clientSecret, paymentIntentId };
}

/**
 * Process recurring monthly payment (called from webhook when invoice.payment_succeeded).
 * Grants credit equal to amount paid (in GBP), expiring at end of the invoice period month.
 */
export async function processMonthlyPayment(
  userId: string,
  paymentDate: Date | string,
  amountPaidPence: number
): Promise<void> {
  if (!Number.isFinite(amountPaidPence) || amountPaidPence <= 0) {
    return;
  }
  const d = typeof paymentDate === 'string' ? new Date(paymentDate + 'T12:00:00Z') : paymentDate;
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('Invalid paymentDate');
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const expiryDate = getLastDayOfMonthString(y, m);
  const amountGBP = amountPaidPence / 100;
  await CreditTransactionService.grantCredits(
    userId,
    amountGBP,
    expiryDate,
    'monthly_subscription',
    undefined,
    'Monthly subscription payment'
  );
}

/**
 * Process first monthly subscription invoice when it contains both a prorated current month
 * and a full next month. Grants two separate credit buckets with correct expiries.
 */
export async function processInitialMonthlyInvoice(
  userId: string,
  currentMonthAmountPence: number,
  nextMonthAmountPence: number,
  currentMonthPeriodEnd: Date,
  nextMonthPeriodEnd: Date
): Promise<void> {
  if (currentMonthAmountPence > 0) {
    const y = currentMonthPeriodEnd.getUTCFullYear();
    const m = currentMonthPeriodEnd.getUTCMonth();
    const currentMonthExpiry = getLastDayOfMonthString(y, m);
    const amountGBP = currentMonthAmountPence / 100;
    await CreditTransactionService.grantCredits(
      userId,
      amountGBP,
      currentMonthExpiry,
      'monthly_subscription',
      undefined,
      'Monthly subscription payment (current month prorated)'
    );
  }
  if (nextMonthAmountPence > 0) {
    const y = nextMonthPeriodEnd.getUTCFullYear();
    const m = nextMonthPeriodEnd.getUTCMonth();
    const nextMonthExpiry = getLastDayOfMonthString(y, m);
    const amountGBP = nextMonthAmountPence / 100;
    await CreditTransactionService.grantCredits(
      userId,
      amountGBP,
      nextMonthExpiry,
      'monthly_subscription',
      undefined,
      'Monthly subscription payment (next month)'
    );
  }
}

/**
 * Process ad-hoc subscription payment success (called from webhook when payment_intent.succeeded
 * with metadata.type === 'ad_hoc_subscription'). Grants £150 credit and updates membership.
 */
export async function processAdHocPaymentSuccess(
  userId: string,
  purchaseDateStr: string
): Promise<void> {
  const d = new Date(purchaseDateStr + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('Invalid purchaseDate');
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  // Grant credits expiring at end of current month (purchase month), not next month
  // This matches the requirement: buy on Feb 17 → credits expire Feb 28/29 → usable only for February bookings
  const subscriptionEndDate = getLastDayOfMonthString(y, m);
  const expiryDate = subscriptionEndDate;

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (!membership) {
    throw new MembershipNotFoundError('Membership not found for user');
  }

  await CreditTransactionService.grantCredits(
    userId,
    AD_HOC_AMOUNT_GBP,
    expiryDate,
    'ad_hoc_subscription',
    undefined,
    'Ad-hoc one-month subscription'
  );

  await db
    .update(memberships)
    .set({
      type: 'ad_hoc',
      subscriptionType: 'ad_hoc',
      subscriptionStartDate: purchaseDateStr,
      subscriptionEndDate,
      updatedAt: new Date(),
    })
    .where(eq(memberships.id, membership.id));
}

/**
 * Update membership when a Stripe monthly subscription is created (customer.subscription.created).
 */
export async function linkMonthlySubscriptionToMembership(
  userId: string,
  stripeSubscriptionId: string
): Promise<void> {
  try {
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);

    if (!membership) {
      // Older users or non-standard flows may not have a membership row yet.
      // Auto-create an ad-hoc membership linked to this monthly Stripe subscription
      // so subscription status and booking permissions stay consistent.
      await db.insert(memberships).values({
        userId,
        type: 'ad_hoc',
        marketingAddon: false,
        subscriptionType: 'monthly',
        stripeSubscriptionId,
      });
      logger.info('linkMonthlySubscriptionToMembership: created membership for user', {
        userId,
        stripeSubscriptionId,
      });
      return;
    }

    await db
      .update(memberships)
      .set({
        stripeSubscriptionId,
        subscriptionType: 'monthly',
        updatedAt: new Date(),
      })
      .where(eq(memberships.id, membership.id));
  } catch (error) {
    logger.error(
      'linkMonthlySubscriptionToMembership: failed to link or create membership',
      error instanceof Error ? error : new Error(String(error)),
      {
        userId,
        stripeSubscriptionId,
      }
    );
    throw error;
  }
}

/** Alias for practitioner UI; same shape as SubscriptionStatusResult. */
export type SubscriptionStatusDetails = SubscriptionStatusResult;

/**
 * Get subscription status and membership details for the practitioner UI.
 * Reuses membership from checkSubscriptionStatus (single membership query).
 * Adds monthlyPriceGbp when user has monthly subscription; adds permanentSlots when user is permanent.
 */
export async function getSubscriptionStatusDetails(
  userId: string
): Promise<SubscriptionStatusResult> {
  const status = await checkSubscriptionStatus(userId);
  const result: SubscriptionStatusResult = {
    canBook: status.canBook,
    reason: status.reason,
    membership: status.membership,
  };
  if (status.membership?.subscriptionType === 'monthly') {
    result.monthlyPriceGbp = MONTHLY_AMOUNT_GBP;
  }
  if (status.membership?.type === 'permanent') {
    result.permanentSlots = await BookingService.getPermanentSlotsForUser(userId);
  }
  return result;
}
