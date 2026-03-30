import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../config/database';
import { hourlyRates, locations, memberships, permanentSlotRates, pricingSettings, rooms } from '../db/schema';

type LocationName = 'Pimlico' | 'Kensington';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const TIME_BANDS = ['morning', 'afternoon'] as const;
const BOOKING_TIME_ZONE = 'Europe/London';

function getTodayInBookingTimeZone(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOOKING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('Failed to derive current date in booking timezone');
  }

  return `${year}-${month}-${day}`;
}

function isValidLocationName(value: string): value is LocationName {
  return value === 'Pimlico' || value === 'Kensington';
}

export async function getPublicRooms(locationName: string) {
  if (!isValidLocationName(locationName)) {
    throw new Error('Invalid location');
  }

  const rows = await db
    .select({
      id: rooms.id,
      name: rooms.name,
      roomNumber: rooms.roomNumber,
    })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(eq(locations.name, locationName), eq(rooms.active, true)));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    roomNumber: Number(r.roomNumber),
  }));
}

export async function getPublicAvailability(locationName: string) {
  if (!isValidLocationName(locationName)) {
    throw new Error('Invalid location');
  }

  const today = getTodayInBookingTimeZone();

  const recurringWeekdayOrder = sql`CASE ${memberships.recurringWeekday}::text
    WHEN 'monday' THEN 1
    WHEN 'tuesday' THEN 2
    WHEN 'wednesday' THEN 3
    WHEN 'thursday' THEN 4
    WHEN 'friday' THEN 5
    ELSE 6 END`;

  const recurringTimeBandOrder = sql`CASE ${memberships.recurringTimeBand}::text
    WHEN 'morning' THEN 1
    WHEN 'afternoon' THEN 2
    ELSE 3 END`;

  const rows = await db
    .select({
      practitionerName: memberships.recurringPractitionerName,
      weekday: memberships.recurringWeekday,
      timeBand: memberships.recurringTimeBand,
      startDate: memberships.recurringStartDate,
      terminationDate: memberships.recurringTerminationDate,
      roomId: rooms.id,
      roomName: rooms.name,
      roomNumber: rooms.roomNumber,
    })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.recurringRoomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(
      and(
        eq(memberships.contractType, 'recurring'),
        eq(locations.name, locationName),
        eq(rooms.active, true),
        or(isNull(memberships.recurringStartDate), lte(memberships.recurringStartDate, today)),
        or(isNull(memberships.recurringTerminationDate), gte(memberships.recurringTerminationDate, today))
      )
    )
    .orderBy(
      asc(rooms.roomNumber),
      recurringWeekdayOrder,
      recurringTimeBandOrder,
      asc(memberships.recurringPractitionerName)
    );

  return rows.map((row) => ({
    practitionerName: row.practitionerName ?? 'Permanent Practitioner',
    weekday: row.weekday,
    timeBand: row.timeBand,
    startDate: row.startDate,
    terminationDate: row.terminationDate,
    room: {
      id: row.roomId,
      name: row.roomName,
      roomNumber: Number(row.roomNumber),
    },
  }));
}

export async function getPublicPrices(locationName: string) {
  if (!isValidLocationName(locationName)) {
    throw new Error('Invalid location');
  }

  const [settings] = await db
    .select({
      monthlySubscriptionGbp: pricingSettings.monthlySubscriptionGbp,
      adHocSubscriptionGbp: pricingSettings.adHocSubscriptionGbp,
    })
    .from(pricingSettings)
    .limit(1);

  const permanentRates = await db
    .select({
      roomGroup: permanentSlotRates.roomGroup,
      dayType: permanentSlotRates.dayType,
      timeBand: permanentSlotRates.timeBand,
      monthlyFeeGbp: permanentSlotRates.monthlyFeeGbp,
    })
    .from(permanentSlotRates)
    .where(eq(permanentSlotRates.locationName, locationName));

  const hourlyRows = await db
    .select({
      dayType: hourlyRates.dayType,
      timeBand: hourlyRates.timeBand,
      rateGbp: hourlyRates.rateGbp,
    })
    .from(hourlyRates)
    .where(eq(hourlyRates.locationName, locationName));

  return {
    membership: {
      monthlySubscriptionGbp: Number(settings?.monthlySubscriptionGbp ?? 0),
      adHocSubscriptionGbp: Number(settings?.adHocSubscriptionGbp ?? 0),
    },
    permanentSlotRates: permanentRates.map((rate) => ({
      roomGroup: rate.roomGroup,
      dayType: rate.dayType,
      timeBand: rate.timeBand,
      monthlyFeeGbp: Number(rate.monthlyFeeGbp),
    })),
    adHocHourlyRates: hourlyRows.map((row) => ({
      dayType: row.dayType,
      timeBand: row.timeBand,
      rateGbp: Number(row.rateGbp),
    })),
    schedule: {
      weekdays: WEEKDAYS,
      timeBands: TIME_BANDS,
    },
  };
}
