import { db } from '../config/database';
import { creditTransactions } from '../db/schema';
import { eq, and, gte, lte, asc, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.util';
import { todayUtcString, getMonthRange } from '../utils/date.util';

export type CreditSourceType =
  | 'monthly_subscription'
  | 'ad_hoc_subscription'
  | 'pay_difference'
  | 'manual';

export interface CreditTransactionRow {
  id: string;
  amount: number;
  usedAmount: number;
  remainingAmount: number;
  grantDate: string;
  expiryDate: string;
  sourceType: CreditSourceType;
  description: string | null;
  revoked: boolean;
}

export interface UseCreditsResult {
  used: Array<{ transactionId: string; amount: number }>;
  totalUsed: number;
}

export interface CreditSummaryByExpiry {
  expiryDate: string;
  remainingAmount: number;
  transactionCount: number;
}

export interface CreditSummaryResult {
  totalAvailable: number;
  byExpiry: CreditSummaryByExpiry[];
  transactions: CreditTransactionRow[];
}

/**
 * Revoke pay-the-difference credits for a given user and sourceId.
 * Intended for rollback when a booking update fails after granting credits.
 * Idempotent: if no matching transactions are found, this is a no-op.
 */
export async function revokePayDifferenceCredits(
  userId: string,
  sourceId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, userId),
          eq(creditTransactions.sourceType, 'pay_difference'),
          eq(creditTransactions.sourceId, sourceId)
        )
      )
      .for('update');

    if (rows.length === 0) {
      // Nothing to revoke (already revoked or never granted).
      return;
    }

    for (const row of rows) {
      const amount = parseFloat(row.amount.toString());
      const usedAmount = parseFloat(row.usedAmount.toString());
      const remainingAmount = parseFloat(row.remainingAmount.toString());

      if (usedAmount !== 0 || remainingAmount !== amount) {
        logger.error('Cannot revoke pay-difference credits that have been used or partially spent', {
          transactionId: row.id,
          userId,
          sourceId,
          amount,
          usedAmount,
          remainingAmount,
        });
        throw new Error('Cannot revoke pay-difference credits that have been used or partially spent');
      }

      await tx
        .update(creditTransactions)
        .set({
          revoked: true,
          updatedAt: new Date(),
        })
        .where(eq(creditTransactions.id, row.id));
      logger.info('Marked pay-difference credits transaction as revoked', {
        transactionId: row.id,
        userId,
        sourceId,
      });
    }
  });
}

/**
 * Grant credits to a user. Creates a new credit transaction.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  expiryDate: string,
  sourceType: CreditSourceType,
  sourceId?: string,
  description?: string
): Promise<string> {
  return grantCreditsWithDate(userId, amount, expiryDate, sourceType, sourceId, description);
}

/**
 * Grant credits with a custom grantDate (for pay-the-difference to match booking date).
 */
export async function grantCreditsWithDate(
  userId: string,
  amount: number,
  expiryDate: string,
  sourceType: CreditSourceType,
  sourceId?: string,
  description?: string,
  grantDate?: string
): Promise<string> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError('Credit amount must be a finite number greater than 0');
  }

  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) {
    throw new TypeError('Invalid expiryDate');
  }

  const amountStr = amount.toFixed(2);
  const [row] = await db
    .insert(creditTransactions)
    .values({
      userId,
      amount: amountStr,
      usedAmount: '0.00',
      remainingAmount: amountStr,
      grantDate: grantDate || todayUtcString(),
      expiryDate,
      sourceType,
      sourceId: sourceId ?? null,
      description: description ?? null,
    })
    .returning({ id: creditTransactions.id });
  if (!row) throw new Error('Failed to create credit transaction');
  return row.id;
}

/**
 * Returns true if the user already has a credit transaction with the given sourceType and sourceId.
 * Used to avoid duplicate grants for the same Stripe payment (e.g. webhook retries).
 */
export async function hasCreditForSourceId(
  userId: string,
  sourceType: CreditSourceType,
  sourceId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.sourceType, sourceType),
        eq(creditTransactions.sourceId, sourceId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Grant credits within an existing transaction. Caller must run inside db.transaction.
 */
export async function grantCreditsWithinTransaction(
  tx: CreditTransactionClient,
  userId: string,
  amount: number,
  expiryDate: string,
  sourceType: CreditSourceType,
  sourceId?: string,
  description?: string
): Promise<string> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError('Credit amount must be a finite number greater than 0');
  }
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) {
    throw new TypeError('Invalid expiryDate');
  }
  const amountStr = amount.toFixed(2);
  const [row] = await tx
    .insert(creditTransactions)
    .values({
      userId,
      amount: amountStr,
      usedAmount: '0.00',
      remainingAmount: amountStr,
      grantDate: todayUtcString(),
      expiryDate,
      sourceType,
      sourceId: sourceId ?? null,
      description: description ?? null,
    })
    .returning({ id: creditTransactions.id });
  if (!row) throw new Error('Failed to create credit transaction');
  return row.id;
}

/**
 * Get all non-expired credit transactions for a user with remaining balance.
 * Sorted by expiryDate ascending so soonest-to-expire (e.g. February) is used before later months (e.g. March).
 */
export async function getAvailableCredits(
  userId: string,
  asOfDate?: string
): Promise<CreditTransactionRow[]> {
  const dateStr = asOfDate ?? todayUtcString();
  const rows = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.revoked, false),
        gte(creditTransactions.expiryDate, dateStr),
        sql`${creditTransactions.remainingAmount} > 0`
      )
    )
    .orderBy(asc(creditTransactions.expiryDate), asc(creditTransactions.grantDate));
  return rows.map((r) => ({
    id: r.id,
    amount: parseFloat(r.amount.toString()),
    usedAmount: parseFloat(r.usedAmount.toString()),
    remainingAmount: parseFloat(r.remainingAmount.toString()),
    grantDate: r.grantDate,
    expiryDate: r.expiryDate,
    sourceType: r.sourceType as CreditSourceType,
    description: r.description,
    revoked: !!r.revoked,
  }));
}

/** Transaction client type for useCreditsWithinTransaction (same as db.transaction callback param). */
export type CreditTransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Use credits within an existing transaction. When bookingDate is provided, only credits expiring
 * in the same month as the booking are used (e.g. February bookings use only February credits);
 * when that month is exhausted, caller should require payment, not use next month's credits.
 * Deducts from soonest-expiring first within that month. Caller must run inside db.transaction.
 * Throws if insufficient credits.
 */
export async function useCreditsWithinTransaction(
  tx: CreditTransactionClient,
  userId: string,
  amount: number,
  options?: { bookingDate?: string }
): Promise<UseCreditsResult> {
  if (amount <= 0) return { used: [], totalUsed: 0 };

  const todayStr = todayUtcString();
  const conditions = [
    eq(creditTransactions.userId, userId),
    eq(creditTransactions.revoked, false),
    gte(creditTransactions.expiryDate, todayStr),
    sql`${creditTransactions.remainingAmount} > 0`,
  ];
  
  // When bookingDate is provided, restrict to credits expiring in the same month
  // February bookings use only February credits, March bookings use only March credits
  if (options?.bookingDate) {
    const { firstDay, lastDay } = getMonthRange(options.bookingDate);
    conditions.push(
      gte(creditTransactions.expiryDate, firstDay),
      lte(creditTransactions.expiryDate, lastDay)
    );
  }

  const rows = await tx
    .select()
    .from(creditTransactions)
    .where(and(...conditions))
    .orderBy(asc(creditTransactions.expiryDate), asc(creditTransactions.grantDate))
    .for('update');

  const totalAvailableCents = rows.reduce(
    (s, r) => s + Math.round(parseFloat(r.remainingAmount.toString()) * 100),
    0
  );
  const totalAvailable = totalAvailableCents / 100;
  let remainingToDeduct = amount;
  const used: Array<{ transactionId: string; amount: number }> = [];
  for (const row of rows) {
    if (remainingToDeduct <= 0) break;
    const rem = parseFloat(row.remainingAmount.toString());
    const deduct = Math.min(rem, remainingToDeduct);
    const newRemaining = rem - deduct;
    const newUsed = parseFloat(row.usedAmount.toString()) + deduct;
    await tx
      .update(creditTransactions)
      .set({
        remainingAmount: newRemaining.toFixed(2),
        usedAmount: newUsed.toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(creditTransactions.id, row.id));
    used.push({ transactionId: row.id, amount: deduct });
    remainingToDeduct -= deduct;
  }

  const totalUsed = used.reduce((s, u) => s + u.amount, 0);
  if (remainingToDeduct > 0) {
    throw new Error(
      `Insufficient credits: requested £${amount.toFixed(2)}, available £${totalAvailable.toFixed(2)}`
    );
  }
  return { used, totalUsed };
}

/**
 * Use credits (FIFO, oldest first). Deducts from transactions until amount is covered.
 * Throws if insufficient credits. Runs in a transaction.
 */
export async function useCredits(userId: string, amount: number): Promise<UseCreditsResult> {
  if (amount <= 0) return { used: [], totalUsed: 0 };
  return db.transaction((tx) => useCreditsWithinTransaction(tx, userId, amount));
}

/**
 * Refund credits to a specific transaction (e.g. on booking cancellation).
 * Runs in a transaction; validates amount <= usedAmount to prevent over-refund.
 * @throws {Error} Credit transaction not found.
 * @throws {Error} Refund amount exceeds used amount.
 */
export async function refundCredits(transactionId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.id, transactionId))
      .limit(1)
      .for('update');
    if (!row) throw new Error(`Credit transaction not found: ${transactionId}`);
    const today = todayUtcString();
    // Refunds to expired transactions are allowed for audit; restored credits remain unusable (filtered by getAvailableCredits).
    if (row.expiryDate < today) {
      logger.warn('Refunding credits to expired transaction', {
        transactionId,
        expiryDate: row.expiryDate,
      });
    }
    const used = parseFloat(row.usedAmount.toString());
    const remaining = parseFloat(row.remainingAmount.toString());
    if (amount > used) {
      throw new Error(
        `Refund amount £${amount.toFixed(2)} exceeds used amount £${used.toFixed(2)}`
      );
    }
    const newUsed = used - amount;
    const newRemaining = remaining + amount;
    const updatedAt = new Date();
    await tx
      .update(creditTransactions)
      .set({
        usedAmount: newUsed.toFixed(2),
        remainingAmount: newRemaining.toFixed(2),
        updatedAt,
      })
      .where(eq(creditTransactions.id, transactionId));
  });
}

/**
 * Get credit summary for a user: total available and breakdown by expiry date.
 */
export async function getCreditSummary(userId: string): Promise<CreditSummaryResult> {
  const transactions = await getAvailableCredits(userId);
  const totalAvailable = transactions.reduce((s, t) => s + t.remainingAmount, 0);
  const byExpiryMap = new Map<string, { remaining: number; count: number }>();
  for (const t of transactions) {
    const existing = byExpiryMap.get(t.expiryDate) ?? { remaining: 0, count: 0 };
    byExpiryMap.set(t.expiryDate, {
      remaining: existing.remaining + t.remainingAmount,
      count: existing.count + 1,
    });
  }
  const byExpiry: CreditSummaryByExpiry[] = Array.from(byExpiryMap.entries())
    .map(([expiryDate, v]) => ({
      expiryDate,
      remainingAmount: v.remaining,
      transactionCount: v.count,
    }))
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  return { totalAvailable, byExpiry, transactions };
}

/**
 * Get credit balance totals for a user (for dashboard).
 * totalAvailable = sum of remainingAmount for non-expired transactions with remaining > 0.
 * totalGranted = sum of amount for all transactions (including expired).
 * totalUsed = sum of usedAmount for all transactions (including expired).
 * When forBookingMonth is provided, only credits expiring in that month are counted in totalAvailable.
 * This ensures February bookings only see February credits, March bookings only see March credits.
 */
export async function getCreditBalanceTotals(
  userId: string,
  options?: { forBookingMonth?: string }
): Promise<{ totalAvailable: number; totalGranted: number; totalUsed: number }> {
  const dateStr = todayUtcString();
  // Base filter: credits must not be expired, have remaining amount, and not be revoked
  const baseExpiryFilter = sql`${creditTransactions.expiryDate} >= ${dateStr} AND ${creditTransactions.remainingAmount} > 0 AND ${creditTransactions.revoked} = false`;
  
  // When forBookingMonth is provided, restrict to credits expiring in that month
  let expiryFilter = baseExpiryFilter;
  if (options?.forBookingMonth) {
    const { firstDay, lastDay } = getMonthRange(options.forBookingMonth);
    // Add month restriction: expiryDate must be within the booking month
    // Both conditions (>= dateStr and >= firstDay) ensure credits are not expired AND within the month
    expiryFilter = sql`${baseExpiryFilter} AND ${creditTransactions.expiryDate} >= ${firstDay} AND ${creditTransactions.expiryDate} <= ${lastDay}`;
  }

  const [row] = await db
    .select({
      totalGranted: sql<number | string>`COALESCE(SUM(${creditTransactions.amount}), 0)`,
      totalUsed: sql<number | string>`COALESCE(SUM(${creditTransactions.usedAmount}), 0)`,
      totalAvailable: sql<number | string>`COALESCE(SUM(CASE WHEN ${expiryFilter} THEN ${creditTransactions.remainingAmount} ELSE 0 END), 0)`,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId));

  if (!row) return { totalAvailable: 0, totalGranted: 0, totalUsed: 0 };
  const totalGranted = parseFloat(String(row.totalGranted));
  const totalUsed = parseFloat(String(row.totalUsed));
  const totalAvailable = parseFloat(String(row.totalAvailable));
  return { totalAvailable, totalGranted, totalUsed };
}
