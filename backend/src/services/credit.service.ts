import { db } from '../config/database';
import { memberships } from '../db/schema';
import { eq } from 'drizzle-orm';
import { formatMonthYear } from '../utils/date.util';
import { logger } from '../utils/logger.util';
import * as CreditTransactionService from './credit-transaction.service';

export interface CreditSummaryByMonth {
  /** Month key based on expiry date: YYYY-MM (UTC). */
  month: string;
  /** Sum of remainingAmount for non-expired credit transactions in this month. */
  remainingCredit: number;
}

export interface CreditSummary {
  currentMonth: {
    monthYear: string;
    totalGranted: number;
    totalUsed: number;
    remainingCredit: number;
  } | null;
  /** For ad_hoc there is no next-month allocation; nextMonthAllocation is 0. */
  nextMonth: {
    monthYear: string;
    nextMonthAllocation: number;
  } | null;
  /**
   * Breakdown of remaining credit by expiry month (grouped by creditTransactions.expiryDate month).
   * Optional for backward compatibility; UI should fall back when undefined.
   */
  byMonth?: CreditSummaryByMonth[];
  membershipType: 'permanent' | 'ad_hoc' | null;
}

export class CreditService {
  /**
   * Get credit balance for a user.
   * Uses transaction-based credits (non-expired, sum of remainingAmount) regardless of membership type.
   * Response shape is compatible with dashboard (currentMonth, nextMonth, membershipType, byMonth).
   */
  static async getCreditBalance(userId: string): Promise<CreditSummary> {
    try {
      const membership = await db.query.memberships.findFirst({
        where: eq(memberships.userId, userId),
      });

      const now = new Date();
      const currentMonthStr = formatMonthYear(now);
      const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const nextMonthStr = formatMonthYear(nextMonthDate);

      const [totals, summaryByExpiry, allNonExpiredTransactions] = await Promise.all([
        CreditTransactionService.getCreditBalanceTotals(userId),
        CreditTransactionService.getCreditSummary(userId),
        CreditTransactionService.getAllNonExpiredCredits(userId),
      ]);

      // Group remaining non-expired credits by expiry month (YYYY-MM, based on expiryDate in UTC).
      // Include months with 0 balance to show them in the UI (e.g., "February £0", "March £0").
      const byMonthMap = new Map<string, number>();
      
      // First, add all months from transactions (including those with 0 balance)
      for (const transaction of allNonExpiredTransactions) {
        if (!transaction.expiryDate) continue;
        const monthKey = transaction.expiryDate.slice(0, 7); // YYYY-MM
        const existing = byMonthMap.get(monthKey) ?? 0;
        byMonthMap.set(monthKey, existing + transaction.remainingAmount);
      }

      const byMonth: CreditSummaryByMonth[] = Array.from(byMonthMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, remainingCredit]) => ({
          month,
          remainingCredit,
        }));

      return {
        currentMonth: {
          monthYear: currentMonthStr,
          totalGranted: totals.totalGranted,
          totalUsed: totals.totalUsed,
          // Keep totalAvailable here for backward compatibility; UI now prefers byMonth.
          remainingCredit: totals.totalAvailable,
        },
        nextMonth: {
          monthYear: nextMonthStr,
          nextMonthAllocation: 0,
        },
        byMonth,
        membershipType: membership?.type ?? null,
      };
    } catch (error) {
      const now = new Date();
      const currentMonthStr = formatMonthYear(now);
      const nextMonthStr = formatMonthYear(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      );
      logger.error(
        'Failed to get credit balance',
        error instanceof Error ? error : new Error(String(error)),
        {
          userId,
          currentMonthYear: currentMonthStr,
          nextMonthYear: nextMonthStr,
        }
      );
      throw error;
    }
  }
}
