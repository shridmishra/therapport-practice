import { db } from '../config/database';
import { creditTransactions, bookings, freeBookingVouchers, rooms } from '../db/schema';
import { eq, and, gte, lte, asc } from 'drizzle-orm';
import { getMonthRange, formatTimeForDisplay } from '../utils/date.util';

export interface TransactionHistoryEntry {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // positive for credits, negative for spending, 0 for vouchers
  type: 'credit_grant' | 'booking' | 'voucher_allocation' | 'stripe_payment';
  createdAt?: Date; // Internal field for sorting (not exposed to frontend)
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
    
    // Show the credit used as negative (what was deducted from credits)
    // Use createdAt date (when booking was created) and include booking date in description
    transactions.push({
      date: booking.createdAt.toISOString().split('T')[0], // Use creation date (when transaction happened)
      description: `Booking ${room.name}, ${formattedBookingDate} ${startTime} to ${endTime}`,
      amount: -creditUsed,
      type: 'booking',
      createdAt: booking.createdAt,
    });
    
    // Calculate if there was a pay-the-difference payment
    // Skip this for free bookings - they don't have any payments
    if (booking.bookingType !== 'free') {
      // Payment amount = totalPrice - creditUsed - voucherValue
      // Voucher value = voucherHoursUsed * pricePerHour (using stored pricePerHour for accuracy)
      const pricePerHour = parseFloat(booking.pricePerHour.toString());
      const voucherValue = voucherHoursUsed > 0 && pricePerHour > 0
        ? voucherHoursUsed * pricePerHour
        : 0;
      
      // Only show Stripe transaction if payment amount is significant (more than 0.01 to account for rounding)
      // This means the user actually paid a difference amount, not just rounding differences
      // Round to 2 decimal places to avoid floating-point arithmetic errors
      const paymentAmount = Math.round((totalPrice - creditUsed - voucherValue) * 100) / 100;
      if (paymentAmount > 0.01) {
        transactions.push({
          date: booking.createdAt.toISOString().split('T')[0], // Use creation date (when transaction happened)
          description: 'Stripe transaction',
          amount: paymentAmount,
          type: 'stripe_payment', // Use stripe_payment type to accurately represent Stripe payments
          createdAt: booking.createdAt, // Use booking createdAt for chronological ordering
        });
      }
    }
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

