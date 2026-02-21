import { createHash } from 'crypto';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { getStripe, STRIPE_WEBHOOK_SECRET } from '../config/stripe';
import { logger } from '../utils/logger.util';
import * as SubscriptionService from '../services/subscription.service';
import * as BookingService from '../services/booking.service';
import * as CreditTransactionService from '../services/credit-transaction.service';

/** Deterministic UUID from Stripe payment intent id for use as credit sourceId (DB source_id is uuid). */
function paymentIntentIdToSourceId(paymentIntentId: string): string {
  const hex = createHash('sha256').update(paymentIntentId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Extract subscription ID from a Stripe Invoice.
 * The subscription field can be a string (ID) or an expanded Subscription object.
 */
function extractSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const subscriptionField = (invoice as any).subscription;
  if (typeof subscriptionField === 'string') {
    return subscriptionField;
  }
  return (subscriptionField as Stripe.Subscription | null | undefined)?.id;
}

/** Grant pay-the-difference credits: amountReceived (pence) to GBP, expiry = last day of current UTC month. */
async function grantPayDifferenceCredits(
  userId: string,
  amountReceived: number,
  description: string,
  sourceId?: string,
  bookingDate?: string
): Promise<string> {
  const amountGBP = amountReceived / 100;
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0));
  const expiryDate = lastDay.toISOString().split('T')[0];
  // Use booking date as grantDate if provided, otherwise use today (reuse d to avoid redundant Date creation)
  const grantDate = bookingDate || d.toISOString().split('T')[0];
  return CreditTransactionService.grantCreditsWithDate(
    userId,
    amountGBP,
    expiryDate,
    'pay_difference',
    sourceId,
    description,
    grantDate
  );
}

/** In-memory map of processed event IDs with timestamps for TTL cleanup (PR 6 minimal). Replace with DB in production. */
const processedEventIds = new Map<string, number>();
const EVENT_ID_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Every hour

function cleanupOldEventIds(): void {
  const now = Date.now();
  for (const [id, timestamp] of processedEventIds.entries()) {
    if (now - timestamp > EVENT_ID_TTL_MS) {
      processedEventIds.delete(id);
    }
  }
}

const cleanupIntervalId = setInterval(cleanupOldEventIds, CLEANUP_INTERVAL_MS);

/** For testing or graceful shutdown: clears the idempotency cleanup interval. */
export function stopIdempotencyCleanup(): void {
  clearInterval(cleanupIntervalId);
}

/** Prorated line identifier (case-insensitive match so Stripe variations still match). */
const PRORATED_LABEL_LOWER = 'prorated current month';

/** Invoice line with optionally expanded price and product (for product name). */
type InvoiceLineWithProduct = Stripe.InvoiceLineItem & {
  price?: Stripe.Price & { product?: Stripe.Product | string };
};

function isProratedLine(line: InvoiceLineWithProduct): boolean {
  const description = (line.description ?? '').trim().toLowerCase();
  if (description === PRORATED_LABEL_LOWER || description.includes(PRORATED_LABEL_LOWER)) return true;
  const product = line.price?.product;
  const productName =
    typeof product === 'object' && product != null && 'name' in product
      ? String((product as Stripe.Product).name ?? '').trim().toLowerCase()
      : '';
  return productName === PRORATED_LABEL_LOWER || productName.includes(PRORATED_LABEL_LOWER);
}

/**
 * Parse subscription invoice line items to detect first-invoice split (prorated + next month).
 * Returns split amounts and subscriptionPeriodEnd from line items (invoice top-level period_end can equal period_start).
 */
function parseSubscriptionInvoiceLines(invoice: Stripe.Invoice): {
  currentMonthAmountPence: number;
  nextMonthAmountPence: number;
  subscriptionPeriodEnd: number | null;
} | null {
  const lines = (invoice.lines?.data ?? []) as InvoiceLineWithProduct[];
  let currentMonthAmountPence = 0;
  let nextMonthAmountPence = 0;
  let subscriptionPeriodEnd: number | null = null;

  for (const line of lines) {
    const amount = line.amount ?? 0;
    if (amount <= 0) continue;
    if (line.period?.end != null) subscriptionPeriodEnd = line.period.end;

    if (isProratedLine(line)) {
      currentMonthAmountPence += amount;
    } else {
      nextMonthAmountPence += amount;
    }
  }

  if (currentMonthAmountPence > 0 && nextMonthAmountPence > 0) {
    return {
      currentMonthAmountPence,
      nextMonthAmountPence,
      subscriptionPeriodEnd,
    };
  }
  return null;
}

/**
 * Stripe webhook handler: verify signature, enforce idempotency, dispatch by event type.
 * Credit granting and subscription updates are implemented in PR 8+; here we only verify and acknowledge.
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    logger.warn('Stripe webhook received without stripe-signature header');
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    logger.error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const rawBody = req.body;
  if (!rawBody || !(rawBody instanceof Buffer)) {
    logger.warn(
      'Stripe webhook body is not raw Buffer (ensure express.raw() is used for this route)'
    );
    res.status(400).json({ error: 'Invalid webhook body' });
    return;
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn('Stripe webhook signature verification failed', { error: message });
    res.status(400).json({ error: 'Webhook signature verification failed' });
    return;
  }

  if (processedEventIds.has(event.id)) {
    logger.info('Stripe webhook event already processed (idempotent)', { eventId: event.id });
    res.status(200).json({ received: true });
    return;
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const type = paymentIntent.metadata?.type;
        const userId = paymentIntent.metadata?.userId;
        const purchaseDate = paymentIntent.metadata?.purchaseDate;
        if (type === 'ad_hoc_subscription' && userId && purchaseDate) {
          await SubscriptionService.processAdHocPaymentSuccess(userId, purchaseDate);
          logger.info('Ad-hoc subscription payment processed', { eventId: event.id, userId });
        } else if (type === 'pay_the_difference' && userId && paymentIntent.metadata?.roomId) {
          const roomId = paymentIntent.metadata.roomId;
          const date = paymentIntent.metadata.date;
          const startTime = paymentIntent.metadata.startTime;
          const endTime = paymentIntent.metadata.endTime;
          // Validate bookingType to prevent invalid values from reaching createBooking
          // Note: 'free' bookings bypass payment, so they should never appear in pay_the_difference flow
          const rawBookingType = paymentIntent.metadata.bookingType;
          const allowedTypes = ['permanent_recurring', 'ad_hoc'] as const;
          const isValidType = rawBookingType && allowedTypes.includes(rawBookingType as typeof allowedTypes[number]);
          const bookingType: 'permanent_recurring' | 'ad_hoc' | 'free' = isValidType
            ? (rawBookingType as 'permanent_recurring' | 'ad_hoc')
            : 'ad_hoc';
          
          if (!isValidType) {
            if (rawBookingType === 'free') {
              logger.warn('Unexpected "free" bookingType in pay_the_difference payment intent, defaulting to ad_hoc', {
                eventId: event.id,
                paymentIntentId: paymentIntent.id,
                userId,
              });
            } else {
              logger.warn('Invalid or missing bookingType in pay_the_difference payment intent, defaulting to ad_hoc', {
                eventId: event.id,
                paymentIntentId: paymentIntent.id,
                userId,
                rawBookingType: rawBookingType || 'missing',
              });
            }
          }
          const amountReceived = paymentIntent.amount_received;
          if (!date || !startTime || !endTime || amountReceived == null) {
            logger.warn('Pay-the-difference metadata incomplete', {
              eventId: event.id,
              userId,
              missing: {
                date: !date,
                startTime: !startTime,
                endTime: !endTime,
                amount_received: amountReceived == null,
              },
            });
          } else {
            const expectedPence = paymentIntent.metadata.expectedAmountPence;
            if (expectedPence != null) {
              const expected = parseInt(String(expectedPence), 10);
              if (!Number.isNaN(expected) && expected !== amountReceived) {
                logger.warn('Pay-the-difference amount mismatch', {
                  eventId: event.id,
                  userId,
                  expectedAmountPence: expected,
                  amountReceived,
                });
              }
            }
            const available = await BookingService.checkAvailability(
              roomId,
              date,
              startTime,
              endTime
            );
            if (!available) {
              logger.warn('Pay-the-difference slot no longer available', {
                eventId: event.id,
                userId,
                roomId,
                date,
              });
              break;
            }
            // For pay-the-difference, payment directly covers the shortfall
            // Convert amountReceived (pence) to GBP for passing to createBooking
            // Note: Credits are NOT granted for new bookings - payment appears in transaction history via booking record
            const paymentAmountGBP = amountReceived / 100;
            // Preserve admin context from payment intent metadata for correct error messages
            const isAdminRequest = paymentIntent.metadata.isAdminRequest === 'true';
            const isAdmin = paymentIntent.metadata.isAdmin === 'true';
            const result = await BookingService.createBooking(
              userId,
              roomId,
              date,
              startTime,
              endTime,
              bookingType,
              paymentAmountGBP,
              isAdminRequest,
              isAdmin,
              paymentIntent.id, // Pass paymentIntentId to store in booking
              paymentAmountGBP // Pass actual Stripe payment amount to store in database
            );
            if ('paymentRequired' in result && result.paymentRequired) {
              logger.error('Pay-the-difference createBooking returned paymentRequired', {
                eventId: event.id,
                userId,
                roomId,
                date,
              });
            } else if ('id' in result) {
              // For new bookings with pay-the-difference, the payment directly covers the shortfall
              // We do NOT grant credits because the payment is not a credit grant - it's a direct payment
              // The payment will still appear in transaction history via the booking record
              // (Note: For booking updates, we DO grant credits because the booking already exists)
              logger.info('Pay-the-difference booking created', {
                eventId: event.id,
                userId,
                bookingId: result.id,
                paymentAmountGBP: paymentAmountGBP,
                paymentIntentId: paymentIntent.id,
              });
            }
          }
        } else if (type === 'pay_the_difference_update' && userId && paymentIntent.metadata?.bookingId) {
          const bookingId = paymentIntent.metadata.bookingId;
          const roomId = paymentIntent.metadata.roomId;
          const bookingDate = paymentIntent.metadata.bookingDate;
          const startTime = paymentIntent.metadata.startTime;
          const endTime = paymentIntent.metadata.endTime;
          const amountReceived = paymentIntent.amount_received;
          if (amountReceived == null) {
            logger.warn('Pay-the-difference-update metadata incomplete', {
              eventId: event.id,
              userId,
              bookingId,
            });
          } else {
            const sourceId = paymentIntentIdToSourceId(paymentIntent.id);
            const alreadyGranted = await CreditTransactionService.hasCreditForSourceId(
              userId,
              'pay_difference',
              sourceId
            );
            let creditsGrantedThisCall = false;
            if (alreadyGranted) {
              logger.info('Pay-the-difference-update credits already granted (idempotent)', {
                eventId: event.id,
                userId,
                bookingId,
                paymentIntentId: paymentIntent.id,
              });
            } else {
              await grantPayDifferenceCredits(
                userId,
                amountReceived,
                'Pay the difference for booking update',
                sourceId
              );
              creditsGrantedThisCall = true;
              logger.info('Pay-the-difference-update credits granted', {
                eventId: event.id,
                userId,
                bookingId,
                paymentIntentId: paymentIntent.id,
              });
            }
            const updates: Parameters<typeof BookingService.updateBooking>[3] = {};
            if (typeof roomId === 'string') updates.roomId = roomId;
            if (typeof bookingDate === 'string') updates.bookingDate = bookingDate;
            if (typeof startTime === 'string') updates.startTime = startTime;
            if (typeof endTime === 'string') updates.endTime = endTime;
            const hasUpdates =
              updates.roomId != null ||
              updates.bookingDate != null ||
              updates.startTime != null ||
              updates.endTime != null;
            if (hasUpdates) {
              try {
                // Preserve admin context from payment intent metadata for correct error messages
                const isAdmin = paymentIntent.metadata.isAdmin === 'true';
                await BookingService.updateBooking(bookingId, userId, isAdmin, updates);
                logger.info('Pay-the-difference-update booking update completed', {
                  eventId: event.id,
                  userId,
                  bookingId,
                });
              } catch (updateErr) {
                if (creditsGrantedThisCall) {
                  try {
                    await CreditTransactionService.revokePayDifferenceCredits(userId, sourceId);
                    logger.warn(
                      'Pay-the-difference-update credits revoked due to booking update failure',
                      { eventId: event.id, userId, bookingId, paymentIntentId: paymentIntent.id }
                    );
                  } catch (revokeErr) {
                    logger.error(
                      'Failed to revoke pay-the-difference-update credits after booking update failure',
                      revokeErr instanceof Error ? revokeErr : new Error(String(revokeErr)),
                      { eventId: event.id, userId, bookingId, paymentIntentId: paymentIntent.id }
                    );
                  }
                }
                logger.error(
                  'Pay-the-difference-update booking update failed',
                  updateErr instanceof Error ? updateErr : new Error(String(updateErr)),
                  { eventId: event.id, userId, bookingId }
                );
                throw updateErr;
              }
            }
          }
        } else {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        }
        break;
      }
      case 'payment_intent.payment_failed':
        logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        break;
      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        if (userId && subscription.id && subscription.status === 'active') {
          await SubscriptionService.linkMonthlySubscriptionToMembership(userId, subscription.id);
          logger.info('Monthly subscription linked to membership', { eventId: event.id, userId });
        } else {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        if (userId && subscription.id && subscription.status === 'active') {
          await SubscriptionService.linkMonthlySubscriptionToMembership(userId, subscription.id);
          logger.info('Monthly subscription linked to membership', { eventId: event.id, userId });
        } else {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        }
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (
          session.mode === 'subscription' &&
          session.payment_status === 'paid' &&
          session.subscription
        ) {
          const userId = session.metadata?.userId;
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : (session.subscription as { id?: string })?.id;
          if (userId && subscriptionId) {
            await SubscriptionService.linkMonthlySubscriptionToMembership(userId, subscriptionId);
            logger.info('Monthly subscription linked from Checkout', {
              eventId: event.id,
              userId,
              subscriptionId,
            });
          } else {
            logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
          }
        } else {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        }
        break;
      }
      case 'customer.subscription.deleted':
        logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        break;
      case 'invoice.payment_succeeded': {
        let invoice = event.data.object as Stripe.Invoice & {
          subscription?: string | { id?: string };
          parent?: { subscription_details?: { metadata?: { userId?: string } } };
        };
        const periodEnd = invoice.period_end;
        if (periodEnd == null) {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
          break;
        }
        // Fetch full invoice with lines and price.product so we can detect prorated line by product name.
        const fullInvoice = (await stripe.invoices.retrieve(invoice.id, {
          expand: ['lines.data.price.product'],
        })) as Stripe.Invoice;
        let amountPaidPence = fullInvoice.amount_paid ?? 0;
        if (amountPaidPence <= 0) {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
          break;
        }
        // Prefer userId from invoice parent metadata (Stripe snapshots subscription metadata at finalization) to avoid synchronous stripe.subscriptions.retrieve.
        let userId: string | undefined = fullInvoice.parent?.subscription_details?.metadata?.userId;
        if (userId == null) {
          const subId = extractSubscriptionId(fullInvoice);
          if (subId) {
            const subscription = await stripe.subscriptions.retrieve(subId);
            userId = subscription.metadata?.userId ?? undefined;
          }
        }
        if (userId == null) {
          logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
          break;
        }
        // First invoice: grant from subscription metadata if present (no line parsing).
        const billingReason = fullInvoice.billing_reason ?? '';
        if (billingReason === 'subscription_create') {
          const subId = extractSubscriptionId(fullInvoice);
          if (subId) {
            const subscription = await stripe.subscriptions.retrieve(subId);
            const meta = subscription.metadata ?? {};
            const curPence = meta.currentMonthAmountPence != null ? parseInt(meta.currentMonthAmountPence, 10) : NaN;
            const nextPence = meta.nextMonthAmountPence != null ? parseInt(meta.nextMonthAmountPence, 10) : NaN;
            const curExpiry = (meta.currentMonthExpiry ?? '').trim();
            const nextExpiry = (meta.nextMonthExpiry ?? '').trim();
            const expiryRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (
              Number.isFinite(curPence) &&
              curPence > 0 &&
              Number.isFinite(nextPence) &&
              nextPence > 0 &&
              expiryRegex.test(curExpiry) &&
              expiryRegex.test(nextExpiry)
            ) {
              const currentMonthPeriodEnd = new Date(curExpiry + 'T12:00:00Z');
              const nextMonthPeriodEnd = new Date(nextExpiry + 'T12:00:00Z');
              await SubscriptionService.processInitialMonthlyInvoice(
                userId,
                curPence,
                nextPence,
                currentMonthPeriodEnd,
                nextMonthPeriodEnd
              );
              logger.info('Monthly subscription payment processed (from metadata)', {
                eventId: event.id,
                userId,
                currentMonthAmountPence: curPence,
                nextMonthAmountPence: nextPence,
              });
              break;
            }
          }
        }
        // Recurring invoice or metadata missing: use line parsing or single credit.
        const split = parseSubscriptionInvoiceLines(fullInvoice as Stripe.Invoice);
        const lineCount = fullInvoice.lines?.data?.length ?? 0;
        if (split == null && lineCount >= 2) {
          const lineSummaries = (fullInvoice.lines?.data ?? []).map((l: Stripe.InvoiceLineItem) => ({
            amount: l.amount,
            description: l.description ?? null,
            subscription: l.subscription != null,
          }));
          logger.info('Invoice has multiple lines but no prorated split detected', {
            eventId: event.id,
            invoiceId: fullInvoice.id,
            lineCount,
            lineSummaries,
          });
        }
        if (split != null) {
          const effectivePeriodEnd = split.subscriptionPeriodEnd ?? periodEnd;
          const periodEndDate = new Date(effectivePeriodEnd * 1000);
          const periodEndYear = periodEndDate.getUTCFullYear();
          const periodEndMonth = periodEndDate.getUTCMonth();
          const currentMonthPeriodEnd = new Date(Date.UTC(periodEndYear, periodEndMonth, 0));
          const nextMonthPeriodEnd = new Date(Date.UTC(periodEndYear, periodEndMonth + 1, 0));
          await SubscriptionService.processInitialMonthlyInvoice(
            userId,
            split.currentMonthAmountPence,
            split.nextMonthAmountPence,
            currentMonthPeriodEnd,
            nextMonthPeriodEnd
          );
          logger.info('Monthly subscription payment processed (split from lines)', {
            eventId: event.id,
            userId,
            currentMonthAmountPence: split.currentMonthAmountPence,
            nextMonthAmountPence: split.nextMonthAmountPence,
          });
        } else {
          const paymentDate = new Date(periodEnd * 1000);
          await SubscriptionService.processMonthlyPayment(userId, paymentDate, amountPaidPence);
          logger.info('Monthly subscription payment processed', { eventId: event.id, userId });
        }
        break;
      }
      case 'invoice.payment_failed':
        logger.info('Stripe webhook event received', { eventId: event.id, type: event.type });
        break;
      default:
        logger.info('Stripe webhook event (unhandled type)', {
          eventId: event.id,
          type: event.type,
        });
    }
  } catch (err) {
    logger.error(
      'Stripe webhook handler error',
      err instanceof Error ? err : new Error(String(err)),
      { eventId: event.id, type: event.type }
    );
    res.status(500).json({ error: 'Webhook handler failed' });
    return;
  }

  processedEventIds.set(event.id, Date.now());
  res.status(200).json({ received: true });
}
