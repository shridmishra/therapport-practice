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
 * List Stripe invoices for a customer. Used for practitioner Finance page (list + download from Stripe only).
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
