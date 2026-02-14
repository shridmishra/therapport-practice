import { db } from '../config/database';
import { bookings, rooms, locations, memberships, users, freeBookingVouchers } from '../db/schema';
import { eq, and, gte, gt, lte, asc, inArray, not } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { todayUtcString, formatTimeForEmail } from '../utils/date.util';
import { fromZonedTime } from 'date-fns-tz';
import * as PricingService from './pricing.service';
import * as CreditTransactionService from './credit-transaction.service';
import * as StripePaymentService from './stripe-payment.service';
import { VoucherService } from './voucher.service';
import {
  BookingValidationError,
  BookingNotFoundError,
  PaymentRequiredError,
} from '../errors/booking.errors';
import { logger } from '../utils/logger.util';
import { emailService } from './email.service';
import { isStripeConfigured } from '../config/stripe';
import type { CreditTransactionClient } from './credit-transaction.service';

type LocationName = PricingService.LocationName;

const ALLOWED_LOCATIONS: LocationName[] = ['Pimlico', 'Kensington'];

const ALLOWED_BOOKING_STATUSES = ['confirmed', 'cancelled', 'completed'] as const;

const TIME_PATTERN = /^\d{1,2}(:\d{1,2})?(:\d{1,2})?$/;

/**
 * Normalize time to "HH:mm:ss" for DB storage.
 * @throws {Error} Invalid time string if input is empty or does not match time pattern.
 */
function toTimeString(t: string): string {
  const trimmed = t.trim();
  if (!trimmed || !TIME_PATTERN.test(trimmed)) {
    throw new Error('Invalid time string');
  }
  const parts = trimmed.split(':');
  const h = parts[0]?.padStart(2, '0') ?? '00';
  const m = (parts[1] ?? '00').padStart(2, '0');
  const s = (parts[2] ?? '00').padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Parse time string to decimal hours for duration.
 */
function timeToHours(t: string): number {
  const parts = t.trim().split(':');
  const h = parseInt(parts[0] ?? '0', 10);
  const m = parseInt(parts[1] ?? '0', 10);
  const s = parseInt(parts[2] ?? '0', 10);
  return h + m / 60 + s / 3600;
}

/**
 * Check if user can make bookings: active membership, not suspended, ad_hoc within period.
 */
export async function canUserBook(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const [userRow] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userRow) return { ok: false, reason: 'User not found' };
  if (userRow.status === 'suspended') return { ok: false, reason: 'Account is suspended' };

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (!membership) return { ok: false, reason: 'No membership' };

  const today = todayUtcString();
  if (membership.type === 'ad_hoc') {
    if (membership.subscriptionType === 'monthly' && membership.stripeSubscriptionId) {
      return { ok: true };
    }
    if (membership.subscriptionEndDate && membership.subscriptionEndDate < today) {
      return { ok: false, reason: 'Ad-hoc subscription has ended' };
    }
    if (membership.suspensionDate && membership.suspensionDate <= today) {
      return { ok: false, reason: 'Membership is suspended' };
    }
  }
  return { ok: true };
}

/**
 * Check if membership has an active subscription (monthly or ad_hoc).
 * Monthly: subscriptionType === 'monthly' && stripeSubscriptionId is not null
 * Ad_hoc: subscriptionType is not null && subscriptionEndDate >= today
 */
function hasActiveSubscription(membership: {
  subscriptionType: string | null;
  stripeSubscriptionId: string | null;
  subscriptionEndDate: string | Date | null;
}): boolean {
  const today = todayUtcString();
  
  // Check for monthly subscription
  if (membership.subscriptionType === 'monthly' && membership.stripeSubscriptionId) {
    return true;
  }
  
  // Check for ad_hoc subscription (exclude monthly from this check)
  if (membership.subscriptionType === 'ad_hoc') {
    const endDate =
      membership.subscriptionEndDate != null
        ? String(membership.subscriptionEndDate).slice(0, 10)
        : null;
    if (endDate && endDate >= today) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get room with location name (for pricing). Throws if room not found.
 */
async function getRoomWithLocation(
  roomId: string
): Promise<{ room: typeof rooms.$inferSelect; locationName: LocationName }> {
  const rows = await db
    .select({ room: rooms, locationName: locations.name })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!rows.length) throw new BookingNotFoundError('Room not found');
  const loc = rows[0].locationName as string;
  if (!ALLOWED_LOCATIONS.includes(loc as LocationName)) {
    throw new BookingValidationError(
      `Invalid location: ${loc}. Allowed: ${ALLOWED_LOCATIONS.join(', ')}`
    );
  }
  return { room: rows[0].room, locationName: loc as LocationName };
}

/**
 * Get room with location using transaction client (for use inside db.transaction).
 */
async function getRoomWithLocationTx(
  tx: CreditTransactionClient,
  roomId: string
): Promise<{ room: typeof rooms.$inferSelect; locationName: LocationName }> {
  const rows = await tx
    .select({ room: rooms, locationName: locations.name })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!rows.length) throw new BookingNotFoundError('Room not found');
  const loc = rows[0].locationName as string;
  if (!ALLOWED_LOCATIONS.includes(loc as LocationName)) {
    throw new BookingValidationError(
      `Invalid location: ${loc}. Allowed: ${ALLOWED_LOCATIONS.join(', ')}`
    );
  }
  return { room: rows[0].room, locationName: loc as LocationName };
}

/**
 * Check availability: no overlapping confirmed booking for same room on same date.
 */
export async function checkAvailability(
  roomId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  const start = toTimeString(startTime);
  const end = toTimeString(endTime);
  const overlapping = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.roomId, roomId),
        eq(bookings.bookingDate, date),
        eq(bookings.status, 'confirmed'),
        sql`${bookings.startTime} < ${end}::time AND ${bookings.endTime} > ${start}::time`
      )
    )
    .limit(1);
  return overlapping.length === 0;
}

/**
 * Check availability excluding a booking id (for update).
 */
export async function checkAvailabilityExcluding(
  roomId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeBookingId: string
): Promise<boolean> {
  const start = toTimeString(startTime);
  const end = toTimeString(endTime);
  const overlapping = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.roomId, roomId),
        eq(bookings.bookingDate, date),
        eq(bookings.status, 'confirmed'),
        not(eq(bookings.id, excludeBookingId)),
        sql`${bookings.startTime} < ${end}::time AND ${bookings.endTime} > ${start}::time`
      )
    )
    .limit(1);
  return overlapping.length === 0;
}

/**
 * Check availability excluding a booking id, using transaction client (for use inside db.transaction).
 */
async function checkAvailabilityExcludingTx(
  tx: CreditTransactionClient,
  roomId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeBookingId: string
): Promise<boolean> {
  const start = toTimeString(startTime);
  const end = toTimeString(endTime);
  const overlapping = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.roomId, roomId),
        eq(bookings.bookingDate, date),
        eq(bookings.status, 'confirmed'),
        not(eq(bookings.id, excludeBookingId)),
        sql`${bookings.startTime} < ${end}::time AND ${bookings.endTime} > ${start}::time`
      )
    )
    .limit(1);
  return overlapping.length === 0;
}

/**
 * Fetch all confirmed bookings for a room on a date (for availability computation).
 */
async function getConfirmedBookingsForRoomDate(
  roomId: string,
  date: string
): Promise<Array<{ startTime: string; endTime: string }>> {
  const rows = await db
    .select({ startTime: bookings.startTime, endTime: bookings.endTime })
    .from(bookings)
    .where(
      and(
        eq(bookings.roomId, roomId),
        eq(bookings.bookingDate, date),
        eq(bookings.status, 'confirmed')
      )
    );
  return rows.map((r) => {
    const st = r.startTime as string | Date;
    const et = r.endTime as string | Date;
    return {
      startTime: toTimeString(
        typeof st === 'object' && st instanceof Date
          ? `${st.getUTCHours().toString().padStart(2, '0')}:${st
              .getUTCMinutes()
              .toString()
              .padStart(2, '0')}:${st.getUTCSeconds().toString().padStart(2, '0')}`
          : String(st)
      ),
      endTime: toTimeString(
        typeof et === 'object' && et instanceof Date
          ? `${et.getUTCHours().toString().padStart(2, '0')}:${et
              .getUTCMinutes()
              .toString()
              .padStart(2, '0')}:${et.getUTCSeconds().toString().padStart(2, '0')}`
          : String(et)
      ),
    };
  });
}

/**
 * Check if interval [start, end) overlaps any booking (times in "HH:mm:ss" or comparable).
 */
function timeRangesOverlap(
  start: string,
  end: string,
  bookings: Array<{ startTime: string; endTime: string }>
): boolean {
  const s = toTimeString(start);
  const e = toTimeString(end);
  return bookings.some((b) => b.startTime < e && b.endTime > s);
}

/**
 * Get rooms, optionally filtered by location name.
 */
export async function getRooms(locationName?: LocationName) {
  const conditions = [eq(rooms.active, true)];
  if (locationName) conditions.push(eq(locations.name, locationName));
  const rows = await db
    .select({
      id: rooms.id,
      locationId: rooms.locationId,
      name: rooms.name,
      roomNumber: rooms.roomNumber,
      active: rooms.active,
      locationName: locations.name,
    })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(...conditions))
    .orderBy(asc(rooms.roomNumber));
  return rows.map((r) => ({
    id: r.id,
    locationId: r.locationId,
    name: r.name,
    roomNumber: parseFloat(r.roomNumber.toString()),
    active: r.active,
    locationName: r.locationName,
  }));
}

/**
 * Format DB time to "HH:mm" for API.
 */
function formatTimeHHMM(t: string | Date): string {
  if (typeof t === 'string') {
    return t.length >= 5 ? t.slice(0, 5) : t;
  }
  const d = t as Date;
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d
    .getUTCMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export interface DayCalendarRoom {
  id: string;
  name: string;
}

export interface DayCalendarBooking {
  id?: string;
  roomId: string;
  startTime: string;
  endTime: string;
  bookerName?: string;
  userId?: string;
}

function mapRowToDayCalendarBooking(
  row: {
    id?: string;
    roomId: string;
    startTime: string | Date;
    endTime: string | Date;
    firstName?: string;
    lastName?: string;
    userId?: string;
  }
): DayCalendarBooking {
  const booking: DayCalendarBooking = {
    roomId: row.roomId,
    startTime: formatTimeHHMM(row.startTime),
    endTime: formatTimeHHMM(row.endTime),
  };
  if (row.id) booking.id = row.id;
  if (row.userId) booking.userId = row.userId;
  if (row.firstName !== undefined && row.lastName !== undefined) {
    booking.bookerName =
      [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || undefined;
  }
  return booking;
}

/**
 * Get day calendar: rooms for location and all confirmed bookings for that date.
 * Each booking includes bookerName and userId so all users can see who has which booking.
 */
export async function getDayCalendar(
  location: LocationName,
  date: string
): Promise<{ rooms: DayCalendarRoom[]; bookings: DayCalendarBooking[] }> {
  const roomList = await getRooms(location);
  const rooms = roomList.map((r) => ({ id: r.id, name: r.name }));
  if (rooms.length === 0) {
    return { rooms: [], bookings: [] };
  }
  const roomIds = rooms.map((r) => r.id);
  const whereClause = and(
    inArray(bookings.roomId, roomIds),
    eq(bookings.bookingDate, date),
    eq(bookings.status, 'confirmed')
  );

  // Always include userId and booker names so all users can see who has which booking
  const rows = await db
    .select({
      id: bookings.id,
      roomId: bookings.roomId,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      userId: bookings.userId,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.userId, users.id))
    .where(whereClause)
    .orderBy(asc(bookings.startTime));
  return { rooms, bookings: rows.map((r) => mapRowToDayCalendarBooking(r)) };
}

/**
 * Get available time slots for a room on a date (30-minute increments 08:00-22:00).
 * Uses a single query for confirmed bookings, then computes availability in memory.
 */
export async function getAvailableSlots(
  roomId: string,
  date: string
): Promise<Array<{ startTime: string; endTime: string; available: boolean }>> {
  const existingBookings = await getConfirmedBookingsForRoomDate(roomId, date);
  const slots: Array<{ startTime: string; endTime: string; available: boolean }> = [];
  for (let halfHour = 0; halfHour < 29; halfHour++) {
    const startHours = 8 + halfHour * 0.5;
    const endHours = startHours + 0.5;
    const hStart = Math.floor(startHours);
    const mStart = (startHours % 1) * 60;
    const hEnd = Math.floor(endHours);
    const mEnd = (endHours % 1) * 60;
    const start = `${hStart.toString().padStart(2, '0')}:${mStart.toString().padStart(2, '0')}`;
    const end = `${hEnd.toString().padStart(2, '0')}:${mEnd.toString().padStart(2, '0')}`;
    const available = !timeRangesOverlap(start, end, existingBookings);
    slots.push({ startTime: start, endTime: end, available });
  }
  return slots;
}

/**
 * Validate booking request: 1-month advance, within window, room exists, availability.
 */
export async function validateBookingRequest(
  userId: string,
  roomId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<{ valid: boolean; error?: string }> {
  const can = await canUserBook(userId);
  if (!can.ok) return { valid: false, error: can.reason };

  const today = todayUtcString();
  if (date < today) return { valid: false, error: 'Booking date must be today or in the future' };

  // Reject if booking start (date + startTime in Europe/London) is in the past
  const [by, bmo, bd] = date.split('-').map(Number);
  const startPart = startTime.trim().slice(0, 5);
  const [hh, mm] = startPart.split(':').map(Number);
  const bookingStartLocal = new Date(by, bmo - 1, bd, hh, mm, 0);
  const bookingStartUtc = fromZonedTime(bookingStartLocal, 'Europe/London');
  if (bookingStartUtc.getTime() <= Date.now()) {
    return { valid: false, error: 'Cannot book a time that has already passed' };
  }

  const [y, m, d] = today.split('-').map(Number);
  const maxDate = new Date(Date.UTC(y, m - 1, d));
  maxDate.setUTCMonth(maxDate.getUTCMonth() + 1);
  const maxDateStr = maxDate.toISOString().split('T')[0];
  if (date > maxDateStr)
    return { valid: false, error: 'Bookings can only be made up to 1 month in advance' };

  try {
    const { locationName } = await getRoomWithLocation(roomId);
    const dateObj = new Date(date + 'T12:00:00Z');
    PricingService.calculateTotalPrice(locationName, dateObj, startTime, endTime);
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid room or time' };
  }

  try {
    const available = await checkAvailability(roomId, date, startTime, endTime);
    if (!available) return { valid: false, error: 'Time slot is not available' };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid time string' };
  }

  return { valid: true };
}

/**
 * Get a price quote for a booking (no side effects).
 * Validates room and time window (08:00–22:00, end > start).
 */
export async function getBookingQuote(
  roomId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<{ totalPrice: number; currency: string }> {
  const { locationName } = await getRoomWithLocation(roomId);
  const dateObj = new Date(date + 'T12:00:00Z');
  const totalPrice = PricingService.calculateTotalPrice(locationName, dateObj, startTime, endTime);
  return { totalPrice, currency: 'GBP' };
}

export type CreateBookingResult =
  | { id: string }
  | { paymentRequired: true; clientSecret: string; paymentIntentId: string; amountPence: number };

/**
 * Create a booking using credits and/or vouchers. When insufficient credits and Stripe is configured,
 * returns paymentRequired with clientSecret for pay-the-difference (PR 9).
 * @param paymentAmountMade - Optional payment amount already made (in GBP). When provided, this amount
 * is used to cover the shortfall along with existing credits, and no new credits are granted.
 */
export async function createBooking(
  userId: string,
  roomId: string,
  date: string,
  startTime: string,
  endTime: string,
  bookingType: 'permanent_recurring' | 'ad_hoc' | 'free' | 'internal' = 'ad_hoc',
  paymentAmountMade?: number
): Promise<CreateBookingResult> {
  const validation = await validateBookingRequest(userId, roomId, date, startTime, endTime);
  if (!validation.valid) throw new BookingValidationError(validation.error!);

  const { room, locationName } = await getRoomWithLocation(roomId);
  const dateObj = new Date(date + 'T12:00:00Z');
  const totalPrice = PricingService.calculateTotalPrice(locationName, dateObj, startTime, endTime);
  const durationHours = timeToHours(endTime) - timeToHours(startTime);
  if (durationHours <= 0) throw new BookingValidationError('Invalid booking span');

  const pricePerHour = totalPrice / durationHours;
  let startTimeDb: string;
  let endTimeDb: string;
  try {
    startTimeDb = toTimeString(startTime);
    endTimeDb = toTimeString(endTime);
  } catch {
    throw new BookingValidationError('Invalid time string');
  }
  const todayStr = todayUtcString();

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (!membership) throw new BookingValidationError('No membership');

  const voucherRows = await db
    .select()
    .from(freeBookingVouchers)
    .where(
      and(eq(freeBookingVouchers.userId, userId), gte(freeBookingVouchers.expiryDate, todayStr))
    )
    .orderBy(asc(freeBookingVouchers.expiryDate));
  const remainingVoucherHours = voucherRows.reduce((sum, v) => {
    const used = parseFloat(v.hoursUsed.toString());
    const allocated = parseFloat(v.hoursAllocated.toString());
    return sum + Math.max(0, allocated - used);
  }, 0);
  const voucherHoursToUse = Math.min(remainingVoucherHours, durationHours);
  const totalPriceCents = Math.round(totalPrice * 100);
  const creditAmountCents =
    voucherHoursToUse >= durationHours
      ? 0
      : Math.round((totalPriceCents * (durationHours - voucherHoursToUse)) / durationHours);
  const creditAmountNeeded = creditAmountCents / 100;

  const { totalAvailable } = await CreditTransactionService.getCreditBalanceTotals(userId, {
    forBookingMonth: date,
  });
  
  // Total available resources: existing credits + payment already made (if any)
  const totalAvailableResources = totalAvailable + (paymentAmountMade ?? 0);
  
  if (totalAvailableResources < creditAmountNeeded) {
    // Only request payment if paymentAmountMade is not provided (initial booking attempt)
    // If paymentAmountMade is provided, we're in the webhook flow and should have enough
    if (paymentAmountMade != null) {

      // Use Error instead of BookingValidationError to indicate it's a system error, not a client validation error.
      const errorMessage = `Insufficient resources after payment. Need £${creditAmountNeeded.toFixed(
        2
      )} but have £${totalAvailable.toFixed(2)} credits and £${paymentAmountMade.toFixed(2)} payment.`;
      logger.error('Insufficient resources after payment in webhook flow', {
        userId,
        roomId,
        date,
        creditAmountNeeded,
        totalAvailable,
        paymentAmountMade,
      });
      throw new Error(errorMessage);
    }
    
    const amountToPayGBP = creditAmountNeeded - totalAvailable;
    const amountToPayPence = Math.round(amountToPayGBP * 100);
    if (amountToPayPence <= 0) {
      // Rounding made difference zero; proceed with booking using available credits
    } else if (!isStripeConfigured()) {
      throw new BookingValidationError(
        `Insufficient credits. You need £${creditAmountNeeded.toFixed(
          2
        )} but have £${totalAvailable.toFixed(2)}. Payment is not configured.`
      );
    } else {
      // For ad_hoc members, require active subscription to pay the difference
      // For permanent members, allow pay-as-you-go even without active subscription
      if (membership.type === 'ad_hoc' && !hasActiveSubscription(membership)) {
        throw new BookingValidationError(
          'You must have an active subscription to pay the difference. Please purchase a subscription first.'
        );
      }
      
      // Get Stripe customer ID for payment (if available)
      const customerId = membership.stripeCustomerId ?? undefined;
      
      const { paymentIntentId, clientSecret } = await StripePaymentService.createPaymentIntent({
        amount: amountToPayPence,
        currency: 'gbp',
        customerId,
        metadata: {
          type: 'pay_the_difference',
          userId,
          roomId,
          date,
          startTime,
          endTime,
          bookingType,
          expectedAmountPence: String(amountToPayPence),
        },
        description: 'Pay the difference for room booking',
      });
      return {
        paymentRequired: true,
        clientSecret,
        paymentIntentId,
        amountPence: amountToPayPence,
      };
    }
  }

  const result = await db.transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    if (!membership) throw new BookingValidationError('No membership');

    const voucherRows = await tx
      .select()
      .from(freeBookingVouchers)
      .where(
        and(eq(freeBookingVouchers.userId, userId), gte(freeBookingVouchers.expiryDate, todayStr))
      )
      .orderBy(asc(freeBookingVouchers.expiryDate));
    const remainingVoucherHours = voucherRows.reduce((sum, v) => {
      const used = parseFloat(v.hoursUsed.toString());
      const allocated = parseFloat(v.hoursAllocated.toString());
      return sum + Math.max(0, allocated - used);
    }, 0);
    const voucherHoursToUse = Math.min(remainingVoucherHours, durationHours);
    const totalPriceCents = Math.round(totalPrice * 100);
    const creditAmountCents =
      voucherHoursToUse >= durationHours
        ? 0
        : Math.round((totalPriceCents * (durationHours - voucherHoursToUse)) / durationHours);
    const creditAmountNeeded = creditAmountCents / 100;
    
    // When paymentAmountMade is provided, calculate how much credit to actually use
    // Credit to use = creditAmountNeeded - paymentAmountMade (but not less than 0)
    const creditToUse = paymentAmountMade != null
      ? Math.max(0, creditAmountNeeded - paymentAmountMade)
      : creditAmountNeeded;

    const [created] = await tx
      .insert(bookings)
      .values({
        userId,
        roomId,
        membershipId: membership.id,
        bookingDate: date,
        startTime: startTimeDb,
        endTime: endTimeDb,
        pricePerHour: pricePerHour.toFixed(2),
        totalPrice: totalPrice.toFixed(2),
        creditUsed: creditToUse.toFixed(2), // Store actual credits consumed (not including payment amount)
        voucherHoursUsed: voucherHoursToUse.toFixed(2),
        status: 'confirmed',
        bookingType,
      })
      .returning({ id: bookings.id });
    if (!created) throw new BookingValidationError('Failed to create booking');

    if (voucherHoursToUse > 0) {
      let remainingToDeduct = voucherHoursToUse;
      for (const v of voucherRows) {
        if (remainingToDeduct <= 0) break;
        const used = parseFloat(v.hoursUsed.toString());
        const allocated = parseFloat(v.hoursAllocated.toString());
        const remaining = allocated - used;
        const deduct = Math.min(remaining, remainingToDeduct);
        await tx
          .update(freeBookingVouchers)
          .set({
            hoursUsed: (used + deduct).toFixed(2),
            updatedAt: new Date(),
          })
          .where(eq(freeBookingVouchers.id, v.id));
        remainingToDeduct -= deduct;
      }
    }

    // Only use credits for the amount not covered by payment
    if (creditToUse > 0) {
      await CreditTransactionService.useCreditsWithinTransaction(tx, userId, creditToUse, {
        bookingDate: date,
      });
    }

    return { id: created.id, creditUsed: creditToUse };
  });

  // Send confirmation email (fire-and-forget; do not fail the request if email fails)
  const [userRow] = await db
    .select({ email: users.email, firstName: users.firstName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (userRow) {
    const creditUsed = result.creditUsed > 0 ? result.creditUsed.toFixed(2) : undefined;
    emailService
      .sendBookingConfirmation({
        firstName: userRow.firstName,
        email: userRow.email,
        roomName: room.name,
        locationName,
        bookingDate: date,
        startTime: startTimeDb,
        endTime: endTimeDb,
        totalPrice: totalPrice.toFixed(2),
        creditUsed,
      })
      .catch((err) =>
        logger.error('Failed to send booking confirmation email', err, {
          userId,
          bookingId: result.id,
        })
      );
  }

  return { id: result.id };
}

/**
 * Cancel a booking and refund credits (full amount as manual credit for PR3; voucher hours not refunded).
 * Booking update and credit grant run in a single transaction so both succeed or both roll back.
 */
export async function cancelBooking(bookingId: string, userId: string, isAdmin: boolean = false): Promise<void> {
  let emailData: {
    firstName: string;
    email: string;
    roomName: string;
    locationName: string;
    bookingDate: string;
    startTime: string;
    endTime: string;
    refundAmount: string;
  } | null = null;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        booking: bookings,
        userEmail: users.email,
        userFirstName: users.firstName,
        roomName: rooms.name,
        locationName: locations.name,
      })
      .from(bookings)
      .innerJoin(users, eq(bookings.userId, users.id))
      .innerJoin(rooms, eq(bookings.roomId, rooms.id))
      .innerJoin(locations, eq(rooms.locationId, locations.id))
      .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)))
      .limit(1);

    if (!row) throw new BookingNotFoundError('Booking not found');
    const booking = row.booking;
    if (booking.status === 'cancelled')
      throw new BookingValidationError('Booking is already cancelled');

    // Only enforce 24-hour restriction for non-admin users
    if (!isAdmin) {
      const bookingDateStr = String(booking.bookingDate);
      const startTimeStr = formatTimeHHMM(booking.startTime as string | Date);
      const [y, mo, d] = bookingDateStr.split('-').map(Number);
      const [hh, mm] = startTimeStr.split(':').map(Number);
      const bookingStartLocal = new Date(y, mo - 1, d, hh, mm, 0);
      const bookingStartUtc = fromZonedTime(bookingStartLocal, 'Europe/London');
      const now = new Date();
      const minCancelBy = bookingStartUtc.getTime() - 24 * 60 * 60 * 1000;
      if (now.getTime() > minCancelBy) {
        throw new BookingValidationError(
          'Cancellation with less than 24 hours notice is not permitted'
        );
      }
    }

    const refundAmount =
      booking.creditUsed === null
        ? parseFloat(booking.totalPrice.toString())
        : parseFloat(String(booking.creditUsed ?? 0));
    await tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: 'Cancelled by user',
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId));

    if (refundAmount > 0) {
      const bookingDate = String(booking.bookingDate);
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(bookingDate)) {
        throw new BookingValidationError(
          `Invalid booking date format for refund: ${bookingDate}. Expected YYYY-MM or YYYY-MM-DD.`
        );
      }
      const parts = bookingDate.split('-').map(Number);
      const y = parts[0];
      const m = parts[1];
      if (m < 1 || m > 12) {
        throw new BookingValidationError(
          `Invalid month in booking date: ${bookingDate}. Month must be 1-12.`
        );
      }
      const lastDay = new Date(Date.UTC(y, m, 0));
      const expiryDate = lastDay.toISOString().split('T')[0];
      // TODO(PR3): Temporary behavior. Replace with logic to refund/restore original debit transactions (or preserve original expiries) in a future change.
      logger.info('Manual end-of-month grant created for booking cancellation', {
        bookingId,
        bookingDate: booking.bookingDate,
        refundAmount,
        expiryDate,
        grantType: 'manual',
      });
      await CreditTransactionService.grantCreditsWithinTransaction(
        tx,
        userId,
        refundAmount,
        expiryDate,
        'manual',
        undefined,
        'Refund for booking cancellation'
      );
    }

    emailData = {
      firstName: row.userFirstName,
      email: row.userEmail,
      roomName: String(row.roomName),
      locationName: String(row.locationName),
      bookingDate: String(booking.bookingDate),
      startTime: formatTimeForEmail(booking.startTime as string | Date),
      endTime: formatTimeForEmail(booking.endTime as string | Date),
      refundAmount: refundAmount.toFixed(2),
    };
  });

  if (emailData) {
    emailService.sendBookingCancellation(emailData).catch((err) =>
      logger.error('Failed to send booking cancellation email', err, {
        userId,
        bookingId,
      })
    );
  }
}

/**
 * Get booking owner userId by booking id (for admin cancel).
 */
export async function getBookingOwnerId(bookingId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: bookings.userId })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return row?.userId ?? null;
}

export type UpdateBookingParams = {
  roomId?: string;
  bookingDate?: string;
  startTime?: string;
  endTime?: string;
};

export type UpdateBookingPaymentRequired = {
  paymentRequired: true;
  clientSecret: string;
  paymentIntentId: string;
  amountPence: number;
};

class BookingUpdatePaymentComputationError extends Error {
  constructor(
    public readonly payload: {
      userId: string;
      bookingId: string;
      newRoomId: string;
      newDate: string;
      newStartTime: string;
      newEndTime: string;
      amountToPayPence: number;
      stripeCustomerId?: string | null;
    }
  ) {
    super('Payment required for booking update (computed inside transaction)');
  }
}

/**
 * Update booking date/time/room. Caller must be owner or admin. 24h before start required.
 * Recalculates price from new room/date/times. Runs in a single DB transaction: re-fetches and
 * locks the booking row, validates, checks availability, reconciles credit/voucher usage for
 * price delta, then updates the booking. When voucher hours are short, attempts to cover
 * shortfall with credits or Stripe (payment required); only throws when payment/coverage fails.
 * Thrown errors roll back the transaction.
 */
export async function updateBooking(
  bookingId: string,
  requesterUserId: string,
  isAdmin: boolean,
  updates: UpdateBookingParams
): Promise<void | UpdateBookingPaymentRequired> {
  try {
    // First, run a transaction that performs all validation and computes any required
    // payment amount while holding the necessary row locks. The transaction is rolled
    // back when payment is required so no changes are persisted before Stripe is called.
    const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        booking: bookings,
        roomName: rooms.name,
        locationName: locations.name,
      })
      .from(bookings)
      .innerJoin(rooms, eq(bookings.roomId, rooms.id))
      .innerJoin(locations, eq(rooms.locationId, locations.id))
      .where(
        isAdmin
          ? eq(bookings.id, bookingId)
          : and(eq(bookings.id, bookingId), eq(bookings.userId, requesterUserId))
      )
      .limit(1)
      .for('update');

    if (!row) throw new BookingNotFoundError('Booking not found');
    const booking = row.booking;
    if (booking.status === 'cancelled')
      throw new BookingValidationError('Booking is already cancelled');

    const userId = booking.userId;
    const bookingDateStr = String(booking.bookingDate);
    const startTimeStr = formatTimeHHMM(booking.startTime as string | Date);
    const endTimeStr = formatTimeHHMM(booking.endTime as string | Date);
    const [y, mo, d] = bookingDateStr.split('-').map(Number);
    const [hh, mm] = startTimeStr.split(':').map(Number);
    const bookingStartLocal = new Date(y, mo - 1, d, hh, mm, 0);
    const bookingStartUtc = fromZonedTime(bookingStartLocal, 'Europe/London');
    const now = new Date();
    const minChangeBy = bookingStartUtc.getTime() - 24 * 60 * 60 * 1000;
    if (now.getTime() > minChangeBy) {
      throw new BookingValidationError(
        'Changes with less than 24 hours before start are not permitted'
      );
    }

    const newRoomId = updates.roomId ?? booking.roomId;
    const newDate = updates.bookingDate ?? bookingDateStr;
    const newStartTime = updates.startTime ?? startTimeStr;
    const newEndTime = updates.endTime ?? endTimeStr;

    const changed =
      newRoomId !== booking.roomId ||
      newDate !== bookingDateStr ||
      newStartTime !== startTimeStr ||
      newEndTime !== endTimeStr;

    let locationName: LocationName;
    if (changed) {
      const today = todayUtcString();
      if (newDate < today)
        throw new BookingValidationError('Booking date must be today or in the future');
      const [by, bmo, bd] = newDate.split('-').map(Number);
      const startPart = newStartTime.trim().slice(0, 5);
      const [nHH, nMM] = startPart.split(':').map(Number);
      const newStartLocal = new Date(by, bmo - 1, bd, nHH, nMM, 0);
      const newStartUtc = fromZonedTime(newStartLocal, 'Europe/London');
      if (newStartUtc.getTime() <= Date.now()) {
        throw new BookingValidationError('Cannot move booking to a time that has already passed');
      }
      const [ty, tm, td] = today.split('-').map(Number);
      const maxDate = new Date(Date.UTC(ty, tm - 1, td));
      maxDate.setUTCMonth(maxDate.getUTCMonth() + 1);
      const maxDateStr = maxDate.toISOString().split('T')[0];
      if (newDate > maxDateStr) {
        throw new BookingValidationError('Bookings can only be up to 1 month in advance');
      }
      const roomWithLoc = await getRoomWithLocationTx(tx, newRoomId);
      locationName = roomWithLoc.locationName;
      try {
        PricingService.calculateTotalPrice(
          locationName,
          new Date(newDate + 'T12:00:00Z'),
          newStartTime,
          newEndTime
        );
      } catch (e) {
        throw new BookingValidationError(e instanceof Error ? e.message : 'Invalid time window');
      }
      const available = await checkAvailabilityExcludingTx(
        tx,
        newRoomId,
        newDate,
        newStartTime,
        newEndTime,
        bookingId
      );
      if (!available) throw new BookingValidationError('Time slot is not available');
    } else {
      locationName = row.locationName as LocationName;
    }

    const dateObj = new Date(newDate + 'T12:00:00Z');
    const totalPrice = PricingService.calculateTotalPrice(
      locationName,
      dateObj,
      newStartTime,
      newEndTime
    );

    const startTimeDb = toTimeString(
      typeof newStartTime === 'string'
        ? newStartTime
        : new Date(newStartTime).toTimeString().slice(0, 8)
    );
    const endTimeDb = toTimeString(
      typeof newEndTime === 'string' ? newEndTime : new Date(newEndTime).toTimeString().slice(0, 8)
    );

    const durationHours =
      (parseInt(endTimeDb.slice(0, 2), 10) * 60 +
        parseInt(endTimeDb.slice(3, 5), 10) -
        (parseInt(startTimeDb.slice(0, 2), 10) * 60 + parseInt(startTimeDb.slice(3, 5), 10))) /
      60;
    const pricePerHour = durationHours > 0 ? totalPrice / durationHours : totalPrice;

    const oldCreditUsed = parseFloat(String(booking.creditUsed ?? 0));
    const oldVoucherHoursUsed = parseFloat(String(booking.voucherHoursUsed ?? 0));

    const todayStr = todayUtcString();
    const voucherRows = await tx
      .select()
      .from(freeBookingVouchers)
      .where(
        and(
          eq(freeBookingVouchers.userId, userId),
          gte(freeBookingVouchers.expiryDate, todayStr)
        )
      )
      .orderBy(asc(freeBookingVouchers.expiryDate));
    const remainingVoucherHours = voucherRows.reduce((sum, v) => {
      const used = parseFloat(v.hoursUsed.toString());
      const allocated = parseFloat(v.hoursAllocated.toString());
      return sum + Math.max(0, allocated - used);
    }, 0);
    const effectiveAvailableVoucherHours = remainingVoucherHours + oldVoucherHoursUsed;

    const newVoucherHoursToUse = Math.min(effectiveAvailableVoucherHours, durationHours);
    const totalPriceCents = Math.round(totalPrice * 100);
    const newCreditNeeded =
      newVoucherHoursToUse >= durationHours
        ? 0
        : Math.round((totalPriceCents * (durationHours - newVoucherHoursToUse)) / durationHours) /
          100;

    const creditDelta = newCreditNeeded - oldCreditUsed;
    const voucherHoursDelta = newVoucherHoursToUse - oldVoucherHoursUsed;

    let finalCreditUsed = newCreditNeeded;
    let finalVoucherHoursUsed = newVoucherHoursToUse;

    if (creditDelta > 0) {
      await CreditTransactionService.useCreditsWithinTransaction(tx, userId, creditDelta, {
        bookingDate: newDate,
      });
    } else if (creditDelta < 0) {
      const [by, bmo] = newDate.split('-').map(Number);
      const lastDay = new Date(Date.UTC(by, bmo, 0));
      const expiryDate = lastDay.toISOString().split('T')[0];
      await CreditTransactionService.grantCreditsWithinTransaction(
        tx,
        userId,
        Math.abs(creditDelta),
        expiryDate,
        'manual',
        undefined,
        'Refund for booking update'
      );
    }

    if (voucherHoursDelta > 0) {
      const remainingForDeduct = voucherRows.reduce((sum, v) => {
        const used = parseFloat(v.hoursUsed.toString());
        const allocated = parseFloat(v.hoursAllocated.toString());
        return sum + Math.max(0, allocated - used);
      }, 0);

      const actualVoucherDeduct = Math.min(voucherHoursDelta, remainingForDeduct);
      const hasShortfall = remainingForDeduct < voucherHoursDelta;

      if (hasShortfall) {
        const shortfall = voucherHoursDelta - remainingForDeduct;
        const shortfallCredit = (totalPriceCents * shortfall) / durationHours / 100;
        const totalCreditToUse = (creditDelta > 0 ? creditDelta : 0) + shortfallCredit;
        const { totalAvailable } = await CreditTransactionService.getCreditBalanceTotals(userId, {
          forBookingMonth: newDate,
        });
        if (totalAvailable < totalCreditToUse) {
          const amountToPayGBP = totalCreditToUse - totalAvailable;
          const amountToPayPence = Math.round(amountToPayGBP * 100);
          if (amountToPayPence <= 0) {
            // Rounding made difference zero; proceed with available credits
          } else if (!isStripeConfigured()) {
            throw new BookingValidationError(
              `Insufficient credits to cover the voucher shortfall. You need £${totalCreditToUse.toFixed(
                2
              )} but have £${totalAvailable.toFixed(
                2
              )}. Payment is not configured.`
            );
          } else {
            const [membership] = await tx
              .select()
              .from(memberships)
              .where(eq(memberships.userId, userId))
              .limit(1);
            if (!membership) throw new BookingValidationError('No membership');
            
            // For ad_hoc members, require active subscription to pay the difference
            // For permanent members, allow pay-as-you-go even without active subscription
            if (membership.type === 'ad_hoc' && !hasActiveSubscription(membership)) {
              throw new BookingValidationError(
                'You must have an active subscription to pay the difference. Please purchase a subscription first.'
              );
            }
            
            // Compute everything needed for payment while holding the DB locks,
            // then signal to the outer scope to perform the Stripe call.
            throw new BookingUpdatePaymentComputationError({
              userId,
              bookingId,
              newRoomId,
              newDate,
              newStartTime,
              newEndTime,
              amountToPayPence,
              stripeCustomerId: membership.stripeCustomerId,
            });
          }
        }
        await CreditTransactionService.useCreditsWithinTransaction(
          tx,
          userId,
          shortfallCredit,
          { bookingDate: newDate }
        );
        finalCreditUsed = newCreditNeeded + shortfallCredit;
        finalVoucherHoursUsed = oldVoucherHoursUsed + actualVoucherDeduct;
      }

      let remainingToDeduct = actualVoucherDeduct;
      for (const v of voucherRows) {
        if (remainingToDeduct <= 0) break;
        const used = parseFloat(v.hoursUsed.toString());
        const allocated = parseFloat(v.hoursAllocated.toString());
        const remaining = allocated - used;
        const deduct = Math.min(remaining, remainingToDeduct);
        await tx
          .update(freeBookingVouchers)
          .set({
            hoursUsed: (used + deduct).toFixed(2),
            updatedAt: new Date(),
          })
          .where(eq(freeBookingVouchers.id, v.id));
        remainingToDeduct -= deduct;
      }
    } else if (voucherHoursDelta < 0) {
      const releaseHours = Math.abs(voucherHoursDelta);
      const rowsWithUsed = await tx
        .select()
        .from(freeBookingVouchers)
        .where(
          and(
            eq(freeBookingVouchers.userId, userId),
            gt(freeBookingVouchers.hoursUsed, '0')
          )
        )
        .orderBy(asc(freeBookingVouchers.expiryDate));
      let remainingToRelease = releaseHours;
      for (const v of rowsWithUsed) {
        if (remainingToRelease <= 0) break;
        const used = parseFloat(v.hoursUsed.toString());
        const release = Math.min(used, remainingToRelease);
        await tx
          .update(freeBookingVouchers)
          .set({
            hoursUsed: (used - release).toFixed(2),
            updatedAt: new Date(),
          })
          .where(eq(freeBookingVouchers.id, v.id));
        remainingToRelease -= release;
      }
    }

    await tx
      .update(bookings)
      .set({
        roomId: newRoomId,
        bookingDate: newDate,
        startTime: startTimeDb,
        endTime: endTimeDb,
        totalPrice: totalPrice.toFixed(2),
        pricePerHour: pricePerHour.toFixed(2),
        creditUsed: finalCreditUsed.toFixed(2),
        voucherHoursUsed: finalVoucherHoursUsed.toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId));

      return;
    });
    return result;
  } catch (err) {
    if (err instanceof BookingUpdatePaymentComputationError) {
      const {
        userId,
        bookingId: bookingIdForMetadata,
        newRoomId,
        newDate,
        newStartTime,
        newEndTime,
        amountToPayPence,
        stripeCustomerId,
      } = err.payload;

      const { paymentIntentId, clientSecret } = await StripePaymentService.createPaymentIntent({
        amount: amountToPayPence,
        currency: 'gbp',
        customerId: stripeCustomerId ?? undefined,
        metadata: {
          type: 'pay_the_difference_update',
          userId,
          bookingId: bookingIdForMetadata,
          roomId: newRoomId,
          bookingDate: newDate,
          startTime: newStartTime,
          endTime: newEndTime,
          expectedAmountPence: String(amountToPayPence),
        },
        description: 'Pay the difference for booking update',
      });

      // Now that the transaction has been rolled back and the DB locks released,
      // throw the existing PaymentRequiredError so the API returns the same payload.
      const paymentError = new PaymentRequiredError('Payment required for booking update', {
        clientSecret,
        paymentIntentId,
        amountPence: amountToPayPence,
      });

      if (paymentError instanceof PaymentRequiredError) {
        return {
          paymentRequired: true,
          clientSecret: paymentError.payload.clientSecret,
          paymentIntentId: paymentError.payload.paymentIntentId,
          amountPence: paymentError.payload.amountPence,
        };
      }
    }

    if (err instanceof PaymentRequiredError) {
      return {
        paymentRequired: true,
        clientSecret: err.payload.clientSecret,
        paymentIntentId: err.payload.paymentIntentId,
        amountPence: err.payload.amountPence,
      };
    }
    throw err;
  }
}

/**
 * Get a single booking by id (must belong to user).
 */
export async function getBookingById(
  bookingId: string,
  userId: string
): Promise<{
  id: string;
  roomId: string;
  roomName: string;
  locationName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  pricePerHour: number;
  totalPrice: number;
  status: string;
  bookingType: string;
} | null> {
  const rows = await db
    .select({
      booking: bookings,
      roomName: rooms.name,
      locationName: locations.name,
    })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)))
    .limit(1);
  if (!rows.length) return null;
  const { booking: b, roomName, locationName } = rows[0];
  return {
    id: b.id,
    roomId: b.roomId,
    roomName,
    locationName,
    bookingDate: b.bookingDate,
    startTime: b.startTime,
    endTime: b.endTime,
    pricePerHour: parseFloat(b.pricePerHour.toString()),
    totalPrice: parseFloat(b.totalPrice.toString()),
    status: b.status,
    bookingType: b.bookingType,
  };
}

/**
 * Get user's bookings with room and location info.
 */
export async function getUserBookings(
  userId: string,
  filters?: { fromDate?: string; toDate?: string; status?: string }
) {
  const conditions = [eq(bookings.userId, userId)];
  if (filters?.fromDate) conditions.push(gte(bookings.bookingDate, filters.fromDate));
  if (filters?.toDate) conditions.push(sql`${bookings.bookingDate} <= ${filters.toDate}`);
  if (filters?.status) {
    const status = filters.status;
    if (status !== 'confirmed' && status !== 'cancelled' && status !== 'completed') {
      throw new BookingValidationError(
        `Invalid status: ${filters.status}. Allowed: ${ALLOWED_BOOKING_STATUSES.join(', ')}`
      );
    }
    conditions.push(eq(bookings.status, status));
  }

  const rows = await db
    .select({
      booking: bookings,
      roomName: rooms.name,
      locationName: locations.name,
    })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(...conditions))
    .orderBy(asc(bookings.bookingDate), asc(bookings.startTime));

  return rows.map(({ booking: b, roomName, locationName }) => ({
    id: b.id,
    roomId: b.roomId,
    roomName,
    locationName,
    bookingDate: b.bookingDate,
    startTime: b.startTime,
    endTime: b.endTime,
    pricePerHour: parseFloat(b.pricePerHour.toString()),
    totalPrice: parseFloat(b.totalPrice.toString()),
    status: b.status,
    bookingType: b.bookingType,
  }));
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTimeForDisplay(t: string | Date): string {
  const str =
    typeof t === 'string'
      ? t.slice(0, 5)
      : `${(t as Date).getUTCHours().toString().padStart(2, '0')}:${(t as Date)
          .getUTCMinutes()
          .toString()
          .padStart(2, '0')}`;
  const [hh, mm] = str.split(':').map(Number);
  const h = hh % 12 || 12;
  const m = mm;
  const ampm = hh < 12 ? 'am' : 'pm';
  return m === 0 ? `${h}${ampm}` : `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

export interface PermanentSlot {
  dayOfWeek: string;
  roomName: string;
  locationName: string;
  startTime: string;
  endTime: string;
}

/**
 * Get distinct permanent (recurring) slots for a user from their confirmed permanent_recurring bookings.
 * Uses a 12-week window from today to sample recurring occurrences.
 */
export async function getPermanentSlotsForUser(userId: string): Promise<PermanentSlot[]> {
  const today = todayUtcString();
  const toDate = new Date(today + 'T12:00:00Z');
  toDate.setUTCDate(toDate.getUTCDate() + 84);
  const toDateStr = toDate.toISOString().split('T')[0];

  const rows = await db
    .select({
      bookingDate: bookings.bookingDate,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      roomName: rooms.name,
      locationName: locations.name,
    })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(
      and(
        eq(bookings.userId, userId),
        eq(bookings.status, 'confirmed'),
        eq(bookings.bookingType, 'permanent_recurring'),
        gte(bookings.bookingDate, today),
        lte(bookings.bookingDate, toDateStr)
      )
    );

  const seen = new Set<string>();
  const slots: PermanentSlot[] = [];
  for (const r of rows) {
    const dateStr = String(r.bookingDate);
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayOfWeek = DAY_NAMES[new Date(y, m - 1, d).getDay()];
    const startFormatted = formatTimeForDisplay(r.startTime as string | Date);
    const endFormatted = formatTimeForDisplay(r.endTime as string | Date);
    const key = `${dayOfWeek}|${r.roomName}|${r.locationName}|${startFormatted}|${endFormatted}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({
      dayOfWeek,
      roomName: r.roomName,
      locationName: r.locationName,
      startTime: startFormatted,
      endTime: endFormatted,
    });
  }
  return slots.sort((a, b) => {
    const dayOrder = DAY_NAMES.indexOf(a.dayOfWeek) - DAY_NAMES.indexOf(b.dayOfWeek);
    if (dayOrder !== 0) return dayOrder;
    return a.roomName.localeCompare(b.roomName) || a.locationName.localeCompare(b.locationName);
  });
}
