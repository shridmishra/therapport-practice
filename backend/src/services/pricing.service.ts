/**
 * Pricing engine for room bookings.
 * Weekend and rate bands use Europe/London timezone.
 * Morning = 08:00–15:00, Afternoon = 15:00–22:00. Booking window 08:00–22:00 same day.
 */

import { toZonedTime } from 'date-fns-tz';
import { db } from '../config/database';
import { hourlyRates, permanentSlotRates, pricingSettings } from '../db/schema';
import { asc, desc, sql } from 'drizzle-orm';

export type LocationName = 'Pimlico' | 'Kensington';
type DayType = 'weekday' | 'weekend';
type TimeBand = 'morning' | 'afternoon' | 'all_day';

type HourlyRateMap = Record<LocationName, { weekday: { morning: number; afternoon: number }; weekend: number }>;

/**
 * Parse time string "HH:mm" or "HH:mm:ss" to hours (fractional).
 * Minutes are required; seconds optional. Hours 0–23 (or 24:00:00 for end-of-day), minutes and seconds 0–59.
 * Invalid input throws.
 * @throws {Error} Invalid time format: ${timeStr}
 */
function parseTimeToHours(timeStr: string): number {
  const trimmed = timeStr.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Invalid time format: ${timeStr}`);
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = match[3] ? parseInt(match[3], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s))
    throw new Error(`Invalid time format: ${timeStr}`);
  if (h < 0 || h > 24 || m < 0 || m > 59 || s < 0 || s > 59)
    throw new Error(`Invalid time format: ${timeStr}`);
  if (h === 24 && (m !== 0 || s !== 0)) throw new Error(`Invalid time format: ${timeStr}`);
  return h + m / 60 + s / 3600;
}

/**
 * Check if date is weekend (Saturday = 6, Sunday = 0) in Europe/London.
 */
function isWeekend(date: Date): boolean {
  const zoned = toZonedTime(date, 'Europe/London');
  const day = zoned.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

async function getHourlyRateMap(): Promise<HourlyRateMap> {
  const rows = await db.select().from(hourlyRates);
  const map: Partial<HourlyRateMap> = {};
  for (const row of rows) {
    const location = row.locationName as LocationName;
    const dayType = row.dayType as DayType;
    const timeBand = row.timeBand as TimeBand;
    const rate = Number(row.rateGbp);
    if (!Number.isFinite(rate)) continue;
    if (!map[location]) {
      map[location] = { weekday: { morning: 0, afternoon: 0 }, weekend: 0 };
    }
    if (dayType === 'weekday' && (timeBand === 'morning' || timeBand === 'afternoon')) {
      map[location]!.weekday[timeBand] = rate;
    } else if (dayType === 'weekend' && timeBand === 'all_day') {
      map[location]!.weekend = rate;
    }
  }
  const complete = map as HourlyRateMap;
  const valid =
    complete.Kensington?.weekday?.morning > 0 &&
    complete.Kensington?.weekday?.afternoon > 0 &&
    complete.Kensington?.weekend > 0 &&
    complete.Pimlico?.weekday?.morning > 0 &&
    complete.Pimlico?.weekday?.afternoon > 0 &&
    complete.Pimlico?.weekend > 0;
  if (!valid) {
    throw new Error('Hourly rates are not configured');
  }
  return complete;
}

export interface PermanentSlotRateItem {
  id: string;
  locationName: LocationName;
  roomGroup: string;
  dayType: DayType;
  timeBand: TimeBand;
  monthlyFeeGbp: number;
}

export interface AdminPrices {
  monthlySubscriptionGbp: number;
  adHocSubscriptionGbp: number;
  hourlyRates: Array<{
    id: string;
    locationName: LocationName;
    dayType: DayType;
    timeBand: TimeBand;
    rateGbp: number;
  }>;
  permanentSlotRates: PermanentSlotRateItem[];
}

export interface AdminPricesUpdateInput {
  monthlySubscriptionGbp: number;
  adHocSubscriptionGbp: number;
  hourlyRates: Array<{
    locationName: LocationName;
    dayType: DayType;
    timeBand: TimeBand;
    rateGbp: number;
  }>;
  permanentSlotRates: Array<{
    locationName: LocationName;
    roomGroup: string;
    dayType: DayType;
    timeBand: TimeBand;
    monthlyFeeGbp: number;
  }>;
}

export async function getAdminPrices(): Promise<AdminPrices> {
  const [settings] = await db.select().from(pricingSettings).orderBy(desc(pricingSettings.updatedAt)).limit(1);
  if (!settings) {
    throw new Error('Pricing settings are not configured');
  }
  const hourRows = await db.select().from(hourlyRates).orderBy(asc(hourlyRates.locationName));
  const permanentRows = await db.select().from(permanentSlotRates).orderBy(asc(permanentSlotRates.locationName));
  return {
    monthlySubscriptionGbp: Number(settings.monthlySubscriptionGbp),
    adHocSubscriptionGbp: Number(settings.adHocSubscriptionGbp),
    hourlyRates: hourRows.map((row) => ({
      id: row.id,
      locationName: row.locationName as LocationName,
      dayType: row.dayType as DayType,
      timeBand: row.timeBand as TimeBand,
      rateGbp: Number(row.rateGbp),
    })),
    permanentSlotRates: permanentRows.map((row) => ({
      id: row.id,
      locationName: row.locationName as LocationName,
      roomGroup: row.roomGroup,
      dayType: row.dayType as DayType,
      timeBand: row.timeBand as TimeBand,
      monthlyFeeGbp: Number(row.monthlyFeeGbp),
    })),
  };
}

export async function updateAdminPrices(input: AdminPricesUpdateInput, updatedBy?: string): Promise<AdminPrices> {
  await db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ id: pricingSettings.id })
      .from(pricingSettings)
      .orderBy(desc(pricingSettings.updatedAt))
      .limit(1);
    if (settings) {
      await tx
        .update(pricingSettings)
        .set({
          monthlySubscriptionGbp: String(input.monthlySubscriptionGbp.toFixed(2)),
          adHocSubscriptionGbp: String(input.adHocSubscriptionGbp.toFixed(2)),
          updatedBy: updatedBy ?? null,
          updatedAt: new Date(),
        })
        .where(sql`${pricingSettings.id} = ${settings.id}`);
    } else {
      await tx.insert(pricingSettings).values({
        monthlySubscriptionGbp: String(input.monthlySubscriptionGbp.toFixed(2)),
        adHocSubscriptionGbp: String(input.adHocSubscriptionGbp.toFixed(2)),
        updatedBy: updatedBy ?? null,
      });
    }
    await tx.delete(hourlyRates);
    if (input.hourlyRates.length > 0) {
      await tx.insert(hourlyRates).values(
        input.hourlyRates.map((r) => ({
          locationName: r.locationName,
          dayType: r.dayType,
          timeBand: r.timeBand,
          rateGbp: String(r.rateGbp.toFixed(2)),
        }))
      );
    }
    await tx.delete(permanentSlotRates);
    if (input.permanentSlotRates.length > 0) {
      await tx.insert(permanentSlotRates).values(
        input.permanentSlotRates.map((r) => ({
          locationName: r.locationName,
          roomGroup: r.roomGroup,
          dayType: r.dayType,
          timeBand: r.timeBand,
          monthlyFeeGbp: String(r.monthlyFeeGbp.toFixed(2)),
        }))
      );
    }
  });
  return getAdminPrices();
}

export async function getSubscriptionPrices(): Promise<{ monthlySubscriptionGbp: number; adHocSubscriptionGbp: number }> {
  const [settings] = await db.select().from(pricingSettings).orderBy(desc(pricingSettings.updatedAt)).limit(1);
  if (!settings) {
    throw new Error('Pricing settings are not configured');
  }
  return {
    monthlySubscriptionGbp: Number(settings.monthlySubscriptionGbp),
    adHocSubscriptionGbp: Number(settings.adHocSubscriptionGbp),
  };
}

/**
 * Get price per hour for a given location, date, and time.
 * Time is used to determine morning (08:00–15:00) vs afternoon (15:00–22:00).
 */
export async function calculatePricePerHour(location: LocationName, date: Date, time: string): Promise<number> {
  const rates = await getHourlyRateMap();
  const locationRates = rates[location];
  if (isWeekend(date)) return locationRates.weekend;
  const hours = parseTimeToHours(time);
  if (hours < 8 || hours > 22) {
    throw new Error('Booking time outside allowed window 08:00–22:00');
  }
  // Morning: 8–15 (8.0 to 14.999...), Afternoon: 15–22
  if (hours >= 8 && hours < 15) return locationRates.weekday.morning;
  if (hours >= 15 && hours < 22) return locationRates.weekday.afternoon;
  // 22:00 is the end of the booking window, not a valid start time for billing.
  throw new Error('Booking time outside allowed window 08:00–22:00');
}

/**
 * Calculate total price for a booking span.
 * Splits by hour and applies the correct rate per hour (handles morning/afternoon boundary).
 * @throws {Error} Invalid booking span when end time <= start time (overnight not supported).
 * @throws {Error} Invalid time format when start/end time strings are invalid.
 */
export async function calculateTotalPrice(
  location: LocationName,
  date: Date,
  startTime: string,
  endTime: string
): Promise<number> {
  const startHours = parseTimeToHours(startTime);
  const endHours = parseTimeToHours(endTime);
  if (startHours < 8 || endHours > 22) {
    throw new Error('Bookings must be within the 08:00–22:00 window');
  }
  // Overnight or reversed spans are invalid; booking window is 08:00–22:00 same day.
  if (endHours <= startHours) {
    throw new Error(
      'Invalid booking span: end time must be after start time within the same day (overnight bookings are not supported)'
    );
  }
  const rates = await getHourlyRateMap();
  const locationRates = rates[location];
  const isSatSun = isWeekend(date);
  let total = 0;
  // Walk the span by segments up to the next band boundary (15:00, 22:00),
  // so fractional crossings (e.g. 14:30–15:30) are billed correctly.
  let h = startHours;
  while (h < endHours) {
    let nextBoundary = endHours;
    if (!isSatSun) {
      if (h < 15 && endHours > 15) {
        nextBoundary = Math.min(endHours, 15);
      } else {
        nextBoundary = Math.min(endHours, 22);
      }
    }
    const segmentEnd = nextBoundary;
    const segmentHours = segmentEnd - h;
    let rate: number;
    if (isSatSun) {
      rate = locationRates.weekend;
    } else {
      if (h >= 8 && h < 15) {
        rate = locationRates.weekday.morning;
      } else if (h >= 15 && h < 22) {
        rate = locationRates.weekday.afternoon;
      } else {
        // Should not occur due to window validation, but guard defensively.
        throw new Error('Booking segment outside allowed window 08:00–22:00');
      }
    }
    total += rate * segmentHours;
    h = segmentEnd;
  }
  return Math.round(total * 100) / 100;
}
