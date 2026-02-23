import Stripe from 'stripe';
import { getStripe, isStripeConfigured } from '../config/stripe';
import { logger } from '../utils/logger.util';

/**
 * Stripe payment service. Handles payment intents, customers, and subscriptions.
 * Webhook handling is implemented in PR 6+.
 *
 * Amounts are in the smallest currency unit (e.g. pence for GBP, cents for USD).
 */

export interface CreatePaymentIntentParams {
  /** Amount in smallest currency unit (e.g. pence for GBP). */
  amount: number;
  currency?: string;
  customerId?: string;
  metadata?: Record<string, string>;
  description?: string;
  /** Optional idempotency key so retries do not create duplicate charges. */
  idempotencyKey?: string;
}

export interface CreatePaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
}

/**
 * Create a PaymentIntent for one-time payment (e.g. ad-hoc subscription, pay-the-difference).
 * Returns clientSecret for frontend to confirm payment.
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams
): Promise<CreatePaymentIntentResult> {
  const stripe = getStripe();
  if (!Number.isFinite(params.amount)) {
    throw new Error('Invalid amount: must be a positive number');
  }
  const amountAsInt = Math.round(params.amount);
  if (amountAsInt <= 0) {
    throw new Error('Invalid amount: must be a positive number');
  }
  const currency = (params.currency ?? 'gbp').toLowerCase();
  const options: Parameters<typeof stripe.paymentIntents.create>[0] = {
    amount: amountAsInt,
    currency,
    automatic_payment_methods: { enabled: true },
    ...(params.metadata && { metadata: params.metadata }),
    ...(params.description && { description: params.description }),
    ...(params.customerId && { customer: params.customerId }),
  };
  const requestOptions = params.idempotencyKey
    ? { idempotencyKey: params.idempotencyKey }
    : undefined;
  const paymentIntent = await stripe.paymentIntents.create(options, requestOptions);
  if (!paymentIntent.client_secret) {
    throw new Error('Stripe did not return client_secret for PaymentIntent');
  }
  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
  };
}

export interface CreateCustomerParams {
  email: string;
  name?: string;
}

export interface CreateCustomerResult {
  customerId: string;
}

/** Simple RFC-style email validation: non-empty, single @, non-empty local and domain with dot. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Find an existing Stripe customer by email (exact match). Returns the first match or null.
 * Use as fallback to avoid creating duplicate customers.
 */
export async function findCustomerByEmail(email: string): Promise<string | null> {
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
    return null;
  }
  const stripe = getStripe();
  const list = await stripe.customers.list({ email: trimmed, limit: 1 });
  const customer = list.data[0];
  return customer?.id ?? null;
}

/**
 * Create a Stripe customer. Used for subscriptions and saving payment methods.
 */
export async function createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult> {
  const email = typeof params.email === 'string' ? params.email.trim() : '';
  if (!email || !EMAIL_REGEX.test(email)) {
    throw new Error('Invalid email format');
  }
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    ...(params.name && { name: params.name }),
  });
  return { customerId: customer.id };
}

export interface CreateSubscriptionParams {
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionResult {
  subscriptionId: string;
  clientSecret?: string;
  status: string;
}

/**
 * Create a Stripe subscription (e.g. monthly £105). Requires a Price ID from Stripe Dashboard.
 */
export async function createSubscription(
  params: CreateSubscriptionParams
): Promise<CreateSubscriptionResult> {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.create({
    customer: params.customerId,
    items: [{ price: params.priceId }],
    collection_method: 'charge_automatically',
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    ...(params.metadata && { metadata: params.metadata }),
  });
  // We request expand: ['latest_invoice.payment_intent'], so latest_invoice is a full Invoice with payment_intent expanded.
  const latestInvoice = subscription.latest_invoice;
  const invoice =
    typeof latestInvoice === 'object' && latestInvoice !== null
      ? (latestInvoice as { payment_intent?: unknown })
      : null;
  const paymentIntent =
    invoice && typeof invoice.payment_intent === 'object' && invoice.payment_intent !== null
      ? (invoice.payment_intent as { client_secret?: string })
      : null;
  return {
    subscriptionId: subscription.id,
    clientSecret: paymentIntent?.client_secret ?? undefined,
    status: subscription.status,
  };
}

export interface FirstInvoiceSplit {
  currentMonthAmountPence: number;
  nextMonthAmountPence: number;
  currentMonthExpiry: string; // YYYY-MM-DD
  nextMonthExpiry: string; // YYYY-MM-DD
}

export interface CreateCheckoutSessionForSubscriptionParams {
  customerId: string;
  priceId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
  /** Optional: prorated amount for current month in pence; added as one-time line on first invoice. */
  proratedAmountPence?: number;
  /** Optional: first-invoice split for webhook to grant two credit buckets without parsing line items. */
  firstInvoiceSplit?: FirstInvoiceSplit;
}

export interface CreateCheckoutSessionForSubscriptionResult {
  checkoutUrl: string;
}

/**
 * Create a Stripe Checkout Session for monthly subscription. User is redirected to Stripe's hosted page to pay.
 * Subscription is created by Stripe only after successful payment.
 * First invoice = one-time prorated line (if proratedAmountPence > 0) + first subscription period (£105).
 */
export async function createCheckoutSessionForSubscription(
  params: CreateCheckoutSessionForSubscriptionParams
): Promise<CreateCheckoutSessionForSubscriptionResult> {
  const stripe = getStripe();
  // Get the monthly price amount from the priceId to create a custom line item with the correct name
  const price = await stripe.prices.retrieve(params.priceId);
  if (price.unit_amount === null) {
    throw new Error(
      `Price ${params.priceId} uses tiered or metered billing (unit_amount is null). ` +
      'Only fixed-amount prices are supported for monthly subscriptions.'
    );
  }
  if (price.unit_amount === 0) {
    throw new Error(
      `Price ${params.priceId} has zero unit_amount. ` +
      'Zero-amount subscriptions are not supported.'
    );
  }
  const monthlyAmountPence = price.unit_amount;
  
  const lineItems: Array<{
    price_data: { currency: string; unit_amount: number; product_data: { name: string }; recurring?: { interval: 'month' } };
    quantity: number;
  }> = [
    {
      price_data: {
        currency: 'gbp',
        unit_amount: monthlyAmountPence,
        product_data: { name: 'Monthly membership (next month)' },
        recurring: { interval: 'month' },
      },
      quantity: 1,
    },
  ];
  if (params.proratedAmountPence != null && params.proratedAmountPence > 0) {
    lineItems.unshift({
      price_data: {
        currency: 'gbp',
        unit_amount: Math.round(params.proratedAmountPence),
        product_data: { name: 'Prorated current month' },
      },
      quantity: 1,
    });
  }
  const subscriptionMetadata: Record<string, string> = { userId: params.userId };
  if (params.firstInvoiceSplit) {
    subscriptionMetadata.currentMonthAmountPence = String(params.firstInvoiceSplit.currentMonthAmountPence);
    subscriptionMetadata.nextMonthAmountPence = String(params.firstInvoiceSplit.nextMonthAmountPence);
    subscriptionMetadata.currentMonthExpiry = params.firstInvoiceSplit.currentMonthExpiry;
    subscriptionMetadata.nextMonthExpiry = params.firstInvoiceSplit.nextMonthExpiry;
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: params.customerId,
    line_items: lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { userId: params.userId },
    subscription_data: { metadata: subscriptionMetadata },
  });
  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }
  return { checkoutUrl: session.url };
}

/**
 * Retrieve a PaymentIntent (e.g. to check status after client confirmation).
 */
export async function getPaymentIntent(paymentIntentId: string) {
  if (!paymentIntentId || !paymentIntentId.trim()) {
    throw new Error('Invalid paymentIntentId: must be a non-empty string');
  }
  return getStripe().paymentIntents.retrieve(paymentIntentId.trim());
}

/**
 * Confirm a PaymentIntent server-side (optional; usually the client confirms with clientSecret).
 * Use when you need to confirm with a specific payment method server-side.
 */
export async function confirmPayment(paymentIntentId: string) {
  if (!paymentIntentId || !paymentIntentId.trim()) {
    throw new Error('Invalid paymentIntentId: must be a non-empty string');
  }
  return getStripe().paymentIntents.confirm(paymentIntentId.trim());
}

/**
 * Cancel a Stripe subscription (e.g. monthly subscription cancellation).
 */
export async function cancelSubscription(subscriptionId: string) {
  if (!subscriptionId || !subscriptionId.trim()) {
    throw new Error('Invalid subscriptionId: must be a non-empty string');
  }
  return getStripe().subscriptions.cancel(subscriptionId.trim());
}

export interface RefundPaymentParams {
  paymentIntentId: string;
  /** Optional: amount to refund in smallest currency unit. If omitted, full refund. */
  amount?: number;
}

/**
 * Refund a payment (full or partial). Amount in smallest currency unit.
 */
export async function refundPayment(params: RefundPaymentParams) {
  if (!params.paymentIntentId || !params.paymentIntentId.trim()) {
    throw new Error('Invalid paymentIntentId: must be a non-empty string');
  }
  if (params.amount != null && params.amount < 0) {
    throw new Error('Invalid amount: refund amount cannot be negative');
  }
  const payload: { payment_intent: string; amount?: number } = {
    payment_intent: params.paymentIntentId.trim(),
  };
  if (params.amount != null && params.amount > 0) {
    payload.amount = Math.round(params.amount);
  }
  return getStripe().refunds.create(payload);
}

export interface InvoiceListItem {
  id: string;
  number: string | null;
  status: string;
  amount_paid: number;
  currency: string;
  created: number;
  invoice_pdf: string | null;
}

/** Error message thrown when customerId is missing or empty (callers can map to e.g. "No billing account found"). */
export const LIST_INVOICES_MISSING_CUSTOMER_ID = 'Missing or empty customerId';

/**
 * Create a Stripe invoice from a PaymentIntent for pay-the-difference payments.
 * This ensures pay-the-difference payments have invoices in the same format as subscription invoices.
 * @param paymentIntentId - The Stripe PaymentIntent ID
 * @param customerId - The Stripe customer ID
 * @returns The created invoice, or null if invoice creation fails or invoice already exists
 */
export async function createInvoiceFromPaymentIntent(
  paymentIntentId: string,
  customerId: string
): Promise<Stripe.Invoice | null> {
  const stripe = getStripe();
  
  if (!paymentIntentId?.trim() || !customerId?.trim()) {
    logger.warn('Invalid parameters for createInvoiceFromPaymentIntent', {
      paymentIntentId: paymentIntentId?.trim() || 'missing',
      customerId: customerId?.trim() || 'missing',
    });
    return null;
  }
  
  try {
    // Check if an invoice already exists for this payment intent
    // Use auto-pagination to check all invoices, not just the first 100
    // This ensures we don't miss duplicates even for high-volume customers
    for await (const inv of stripe.invoices.list({
      customer: customerId,
      limit: 100,
    })) {
      // Check for existing invoice matching this payment intent
      // We use metadata.payment_intent_id which we always set when creating invoices
      // Note: The invoice.payment_intent field was removed in Stripe API 2025-03-31.basil
      // and replaced with InvoicePayment object, so we rely solely on metadata
      const metadataPaymentIntentId = inv.metadata?.payment_intent_id;
      if (metadataPaymentIntentId === paymentIntentId) {
        // Only return if invoice is fully completed (paid)
        // If it's in draft/open state, continue to complete it
        if (inv.status === 'paid' && inv.amount_paid > 0) {
          logger.info('Invoice already exists and is paid for payment intent', {
            paymentIntentId,
            invoiceId: inv.id,
          });
          return inv;
        }
        // Invoice exists but not paid - log and continue to complete it
        logger.info('Invoice exists but not paid, will complete it', {
          paymentIntentId,
          invoiceId: inv.id,
          status: inv.status,
          amount_paid: inv.amount_paid,
        });
        // Don't return - continue to finalize and pay
      }
    }
    
    // Retrieve the PaymentIntent to get details
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Verify customer ID matches
    if (paymentIntent.customer) {
      const piCustomerId =
        typeof paymentIntent.customer === 'string'
          ? paymentIntent.customer
          : paymentIntent.customer.id;
      if (piCustomerId !== customerId) {
        logger.warn('PaymentIntent customer ID does not match provided customer ID', {
          paymentIntentId,
          paymentIntentCustomerId: piCustomerId,
          providedCustomerId: customerId,
        });
        return null;
      }
    } else {
      logger.warn('PaymentIntent has no customer ID', {
        paymentIntentId,
      });
      return null;
    }
    
    // Only create invoice for succeeded payments
    if (paymentIntent.status !== 'succeeded') {
      logger.debug('PaymentIntent not succeeded, skipping invoice creation', {
        paymentIntentId,
        status: paymentIntent.status,
      });
      return null;
    }
    
    if (!paymentIntent.amount_received || paymentIntent.amount_received <= 0) {
      logger.warn('PaymentIntent has no amount received', {
        paymentIntentId,
        amount_received: paymentIntent.amount_received,
      });
      return null;
    }
    
    // Extract booking details from metadata for invoice description
    const metadata = paymentIntent.metadata || {};
    const date = metadata.date || '';
    const startTime = metadata.startTime || '';
    const endTime = metadata.endTime || '';
    
    let description = 'Pay the difference for room booking';
    if (date && startTime && endTime) {
      description = `Pay the difference for room booking - ${date} ${startTime}-${endTime}`;
    }
    
    // Create invoice with line item
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.create(
        {
          customer: customerId,
          collection_method: 'charge_automatically',
          auto_advance: false, // Don't auto-finalize since payment is already received
          description,
          metadata: {
            payment_intent_id: paymentIntentId,
            type: 'pay_the_difference',
            ...metadata,
          },
        },
        {
          // Ensure duplicate webhook deliveries don't create multiple invoices
          // Stripe will return the same invoice if this key is reused
          idempotencyKey: `pay_the_difference_invoice_${paymentIntentId}`,
        }
      );
    } catch (createError) {
      // If invoice creation fails, log and return null
      logger.error(
        'Failed to create invoice',
        createError instanceof Error ? createError : new Error(String(createError)),
        { paymentIntentId, customerId }
      );
      return null;
    }
    
    // Add line item for the payment amount
    // Validate currency - must be 'gbp' (our codebase only supports GBP)
    const currency = paymentIntent.currency;
    if (!currency || currency.toLowerCase() !== 'gbp') {
      const reason = !currency 
        ? 'PaymentIntent currency is missing when creating invoice line item'
        : 'PaymentIntent currency is not GBP when creating invoice line item';
      
      logger.warn(reason, {
        paymentIntentId,
        customerId,
        invoiceId: invoice.id,
        ...(currency && { currency }),
      });
      
      // Try to delete the invoice to avoid orphaned state
      try {
        await stripe.invoices.del(invoice.id);
        logger.info('Invoice deleted after currency validation failure', {
          invoiceId: invoice.id,
          paymentIntentId,
          ...(currency && { currency }),
        });
      } catch (deleteError) {
        logger.error(
          'Failed to delete invoice after currency validation failure',
          deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
          { invoiceId: invoice.id, paymentIntentId, ...(currency && { currency }) }
        );
      }
      return null;
    }
    
    try {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
        amount: paymentIntent.amount_received,
        currency,
        description: description,
      });
    } catch (itemError) {
      // If line item creation fails, try to delete the invoice to avoid orphaned state
      try {
        await stripe.invoices.del(invoice.id);
        logger.info('Invoice deleted after line item creation failure', {
          invoiceId: invoice.id,
          paymentIntentId,
        });
      } catch (deleteError) {
        logger.error(
          'Failed to delete invoice after line item creation failure',
          deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
          { invoiceId: invoice.id, paymentIntentId }
        );
      }
      logger.error(
        'Failed to create invoice line item',
        itemError instanceof Error ? itemError : new Error(String(itemError)),
        { paymentIntentId, customerId, invoiceId: invoice.id }
      );
      return null;
    }
    
    // Finalize the invoice (since payment is already received)
    let finalizedInvoice: Stripe.Invoice;
    try {
      finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
    } catch (finalizeError) {
      logger.error(
        'Failed to finalize invoice',
        finalizeError instanceof Error ? finalizeError : new Error(String(finalizeError)),
        { paymentIntentId, customerId, invoiceId: invoice.id }
      );
      return null;
    }
    
    // Mark as paid since payment was already received
    let paidInvoice: Stripe.Invoice;
    try {
      paidInvoice = await stripe.invoices.pay(finalizedInvoice.id, {
        paid_out_of_band: true,
      });
    } catch (payError) {
      // If marking as paid fails, return null to ensure callers only get invoices in expected state (paid)
      // The webhook will retry and the duplicate check will prevent double creation
      logger.error(
        'Failed to mark invoice as paid (invoice was created and finalized but not marked as paid)',
        payError instanceof Error ? payError : new Error(String(payError)),
        { paymentIntentId, customerId, invoiceId: finalizedInvoice.id }
      );
      return null;
    }
    
    logger.info('Created invoice from PaymentIntent', {
      paymentIntentId,
      invoiceId: paidInvoice.id,
      amount: paymentIntent.amount_received,
    });
    
    return paidInvoice;
  } catch (error) {
    logger.error(
      'Failed to create invoice from PaymentIntent',
      error instanceof Error ? error : new Error(String(error)),
      { paymentIntentId, customerId }
    );
    return null;
  }
}

/**
 * List Stripe invoices for a customer. Used for practitioner Finance page (list + download from Stripe only).
 * Includes both subscription invoices and pay-the-difference invoices.
 * Invoices are created automatically via webhooks when payments succeed (for payments from this point forward).
 * Note: Historical pay-the-difference payments (before invoice creation was implemented) may not have invoices.
 * @throws Error with message LIST_INVOICES_MISSING_CUSTOMER_ID when customerId is missing or empty
 */
export async function listInvoicesForCustomer(customerId: string): Promise<InvoiceListItem[]> {
  if (!customerId?.trim()) {
    logger.warn('listInvoicesForCustomer called with missing or empty customerId');
    throw new Error(LIST_INVOICES_MISSING_CUSTOMER_ID);
  }
  const stripe = getStripe();
  const customer = customerId.trim();
  const results: InvoiceListItem[] = [];
  
  // Get all invoices (subscription + pay-the-difference)
  // All invoices should already exist since they're created via webhook when payments succeed
  for await (const inv of stripe.invoices.list({ customer })) {
    results.push({
      id: inv.id,
      number: inv.number ?? null,
      status: inv.status ?? 'unknown',
      amount_paid: inv.amount_paid ?? 0,
      currency: (inv.currency ?? 'gbp').toLowerCase(),
      created: inv.created,
      invoice_pdf: inv.invoice_pdf ?? null,
    });
  }
  
  // Sort by creation date (newest first)
  results.sort((a, b) => b.created - a.created);
  
  return results;
}

/**
 * Sum succeeded PaymentIntents for a calendar month (UTC), excluding pay-the-difference.
 * Used for admin dashboard revenue. Returns 0 if Stripe is not configured.
 * @param yearMonth - { year, month } 1-based month (1–12)
 * @returns Revenue in GBP (pounds, not pence)
 */
export async function getRevenueForMonthGbp(yearMonth: {
  year: number;
  month: number;
}): Promise<number> {
  if (!isStripeConfigured()) {
    return 0;
  }
  const stripe = getStripe();
  const start = Math.floor(
    Date.UTC(yearMonth.year, yearMonth.month - 1, 1, 0, 0, 0, 0) / 1000
  );
  const end = Math.floor(
    Date.UTC(yearMonth.year, yearMonth.month, 1, 0, 0, 0, 0) / 1000
  );
  let totalPence = 0;
  for await (const pi of stripe.paymentIntents.list({
    created: { gte: start, lt: end },
    limit: 100,
  })) {
    if (pi.status !== 'succeeded' || pi.amount_received == null) continue;
    const type = (pi.metadata?.type as string) ?? '';
    if (type === 'pay_the_difference') continue;
    totalPence += pi.amount_received;
  }
  return totalPence / 100;
}
