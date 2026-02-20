import { db } from '../config/database';
import { creditTransactions, bookings, freeBookingVouchers, rooms } from '../db/schema';
import { eq, and, gte, lte, asc } from 'drizzle-orm';
import { getMonthRange, formatTimeForDisplay } from '../utils/date.util';

export interface BreakdownItem {
  type: 'credits' | 'stripe' | 'voucher';
  amount: number;
  description: string;
  hours?: number; // For vouchers
}

export interface TransactionHistoryEntry {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // stored as positive: credits (positive), bookings (positive, frontend negates for display), vouchers (0), free bookings (0)
  type: 'credit_grant' | 'booking' | 'voucher_allocation' | 'stripe_payment';
  createdAt?: Date; // Internal field for sorting (not exposed to frontend)
  bookingId?: string; // Optional: link to group related entries
  breakdown?: BreakdownItem[]; // Optional: payment breakdown for bookings
}

/**
 * Get transaction history for a user for a specific month.
 * Combines credit transactions, bookings, and voucher allocations.
 */
export async function getTransactionHistory(
  userId: string,
  month: string // YYYY-MM format
): Promise<TransactionHistoryEntry[]> {
  const { firstDay, lastDay } = getMonthRange(`${month}-01`);
  const transactions: TransactionHistoryEntry[] = [];

  // Convert firstDay/lastDay strings to Date objects for timestamp comparison
  // Filter by createdAt to show transactions that happened in the selected month
  const firstDayDate = new Date(firstDay + 'T00:00:00Z');
  const lastDayDate = new Date(lastDay + 'T23:59:59.999Z');

  // Get credit transactions (grants) for the month
  const creditGrants = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        gte(creditTransactions.createdAt, firstDayDate),
        lte(creditTransactions.createdAt, lastDayDate),
        eq(creditTransactions.revoked, false)
      )
    )
    .orderBy(asc(creditTransactions.createdAt));

  for (const grant of creditGrants) {
    const amount = parseFloat(grant.amount.toString());
    let description = grant.description || 'Credit grant';
    
    // Format description based on source type
    if (grant.sourceType === 'ad_hoc_subscription') {
      description = 'Ad hoc membership Stripe credit';
    } else if (grant.sourceType === 'monthly_subscription') {
      description = 'Monthly subscription credit';
    } else if (grant.sourceType === 'pay_difference') {
      // Preserve custom description if present (e.g., "Pay the difference for room booking")
      // Otherwise use generic fallback
      description = grant.description || 'Stripe transaction';
    } else if (grant.sourceType === 'manual') {
      description = grant.description || 'Manual credit allocation';
    }

    transactions.push({
      date: grant.createdAt.toISOString().split('T')[0], // Use creation date (when transaction happened)
      description,
      amount,
      type: 'credit_grant',
      createdAt: grant.createdAt,
    });
  }

  // Get bookings for the month
  // Filter by createdAt to show transactions that happened in the selected month
  const bookingRows = await db
    .select({
      booking: bookings,
      room: rooms,
    })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .where(
      and(
        eq(bookings.userId, userId),
        gte(bookings.createdAt, firstDayDate),
        lte(bookings.createdAt, lastDayDate),
        eq(bookings.status, 'confirmed')
      )
    )
    .orderBy(asc(bookings.createdAt));

  for (const { booking, room } of bookingRows) {
    const startTime = formatTimeForDisplay(booking.startTime);
    const endTime = formatTimeForDisplay(booking.endTime);
    const creditUsed = parseFloat(String(booking.creditUsed ?? 0));
    const totalPrice = parseFloat(booking.totalPrice.toString());
    const voucherHoursUsed = parseFloat(String(booking.voucherHoursUsed ?? 0));
    
    // Format booking date as DD.MM.YYYY for display in description
    // Use String() for safety - Drizzle date() may return string or Date object depending on driver
    const bookingDateStr = String(booking.bookingDate);
    const [bookingYear, bookingMonth, bookingDay] = bookingDateStr.split('-');
    const formattedBookingDate = `${bookingDay}.${bookingMonth}.${bookingYear}`;
    
    // Calculate voucher value (needed for both booking amount and payment calculation)
    const pricePerHour = parseFloat(booking.pricePerHour.toString());
    const voucherValue = voucherHoursUsed > 0 && pricePerHour > 0
      ? voucherHoursUsed * pricePerHour
      : 0;
    
    // Build breakdown array for payment methods used
    const breakdown: BreakdownItem[] = [];
    
    // Add credits breakdown if credits were used
    if (creditUsed > 0.01) {
      breakdown.push({
        type: 'credits',
        amount: creditUsed,
        description: 'Credits used',
      });
    }
    
    // Add Stripe payment breakdown if payment was made (skip for free bookings)
    if (booking.bookingType !== 'free') {
      // Clamp to zero to prevent negative values due to floating-point rounding differences
      // This ensures breakdown always sums correctly to totalPrice
      const paymentAmount = Math.max(0, Math.round((totalPrice - creditUsed - voucherValue) * 100) / 100);
      if (paymentAmount > 0.01) {
        breakdown.push({
          type: 'stripe',
          amount: paymentAmount,
          description: 'Stripe payment',
        });
      }
    }
    
    // Add voucher breakdown if vouchers were used
    if (voucherHoursUsed > 0) {
      breakdown.push({
        type: 'voucher',
        amount: voucherValue,
        description: 'Voucher',
        hours: voucherHoursUsed,
      });
    }
    
    // Create main booking entry with breakdown
    // Show total booking cost (positive amount for clarity, frontend will handle display)
    // For free bookings, set amount to 0 since they have no cost
    transactions.push({
      date: booking.createdAt.toISOString().split('T')[0], // Use creation date (when transaction happened)
      description: `Booking ${room.name}, ${formattedBookingDate} ${startTime} to ${endTime}`,
      amount: booking.bookingType === 'free' ? 0 : totalPrice, // Free bookings show £0.00, others show total cost
      type: 'booking',
      bookingId: booking.id, // Link to group related entries
      breakdown: breakdown.length > 0 ? breakdown : undefined, // Only include if there's a breakdown
      createdAt: booking.createdAt,
    });
  }

  // Get voucher allocations for the month
  const vouchers = await db
    .select()
    .from(freeBookingVouchers)
    .where(
      and(
        eq(freeBookingVouchers.userId, userId),
        gte(freeBookingVouchers.createdAt, firstDayDate),
        lte(freeBookingVouchers.createdAt, lastDayDate)
      )
    )
    .orderBy(asc(freeBookingVouchers.createdAt));

  for (const voucher of vouchers) {
    const hours = parseFloat(voucher.hoursAllocated.toString());
    
    // Format expiry date as DD.MM.YYYY
    // Use String() for safety - Drizzle date() may return string or Date object depending on driver
    const expiryDateStr = String(voucher.expiryDate);
    const [year, expiryMonth, day] = expiryDateStr.split('-');
    const formattedExpiryDate = `${day}.${expiryMonth}.${year}`;
    
    transactions.push({
      date: voucher.createdAt.toISOString().split('T')[0],
      description: `${hours} hours free booking expiring ${formattedExpiryDate} allocated`,
      amount: 0,
      type: 'voucher_allocation',
      createdAt: voucher.createdAt,
    });
  }

  // Sort all transactions by date, then by creation time (chronological order)
  transactions.sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    // For same date, sort by creation timestamp (chronological order)
    if (a.createdAt && b.createdAt) {
      return a.createdAt.getTime() - b.createdAt.getTime();
    }
    // Fallback: if createdAt is missing, maintain current order
    return 0;
  });

  // Remove createdAt from final result (it was only used for sorting)
  return transactions.map(({ createdAt, ...rest }) => rest);
}

