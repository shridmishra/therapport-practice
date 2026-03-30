import { db } from '../config/database';
import { bookings, rooms, locations } from '../db/schema';
import { and, asc, eq, gte, lte, or, sql, count } from 'drizzle-orm';

export type LocationScope = 'Pimlico' | 'Kensington' | 'combined';

/** Matches admin stats: 08:00–22:00 = 14h capacity per room per day */
export const DAILY_OPERATING_HOURS = 14;

export const HEATMAP_START_HOUR = 8;
export const HEATMAP_END_HOUR_EXCLUSIVE = 22;

/** Annual summary table only populates on or after this date (first FY row: 2025–26 ending May 2026). */
export const OCCUPANCY_ANNUAL_TABLE_LIVE_DATE = '2026-06-01';

export interface OccupancyResult {
  fromDate: string;
  toDate: string;
  totalSlotHours: number;
  bookedHours: number;
  occupancyPercent: number;
}

export type OccupancyRangePreset =
  | 'last_month'
  | 'last_3_months'
  | 'fy_to_date'
  | 'two_fy_window'
  | 'all_time';

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatDateUTC(y: number, monthIndex0: number, day: number): string {
  return `${y}-${pad2(monthIndex0 + 1)}-${pad2(day)}`;
}

export function countDaysInclusive(fromDate: string, toDate: string): number {
  const fromDateObj = new Date(fromDate + 'T12:00:00Z');
  const toDateObj = new Date(toDate + 'T12:00:00Z');
  return (
    Math.max(0, Math.ceil((toDateObj.getTime() - fromDateObj.getTime()) / (24 * 60 * 60 * 1000)) + 1)
  );
}

/** Same-day bookings only; createBooking rejects non-positive span. */
export function durationHoursFromTimes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + (sm || 0);
  const endMins = eh * 60 + (em || 0);
  return Math.max(0, (endMins - startMins) / 60);
}

/** Fiscal year starts June 1 (UTC calendar). */
export function getFiscalYearStartYearUTC(reference: Date = new Date()): number {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth();
  return m >= 5 ? y : y - 1;
}

export function getFiscalYearBoundsUTC(fyStartYear: number): { from: string; to: string } {
  const from = formatDateUTC(fyStartYear, 5, 1);
  const to = formatDateUTC(fyStartYear + 1, 4, 31);
  return { from, to };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 12 months from June of fyStartYear through May of fyStartYear+1 */
export function listFiscalYearMonths(fyStartYear: number): Array<{ from: string; to: string; label: string }> {
  const out: Array<{ from: string; to: string; label: string }> = [];
  for (let i = 0; i < 12; i++) {
    const first = new Date(Date.UTC(fyStartYear, 5 + i, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const from = formatDateUTC(y, m, 1);
    const to = formatDateUTC(y, m, lastDay);
    out.push({ from, to, label: `${MONTH_NAMES[m]} ${y}` });
  }
  return out;
}

async function getActiveRoomCount(scope: LocationScope): Promise<number> {
  if (scope === 'combined') {
    const [row] = await db.select({ c: count() }).from(rooms).where(eq(rooms.active, true));
    return row?.c ?? 0;
  }
  const [row] = await db
    .select({ c: count() })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(eq(rooms.active, true), eq(locations.name, scope)));
  return row?.c ?? 0;
}

/** Sum booked hours in Postgres (same result as summing durationHoursFromTimes per row). */
async function getBookedHours(fromDate: string, toDate: string, scope: LocationScope): Promise<number> {
  const statusFilter = or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed'));
  const dateFilter = and(gte(bookings.bookingDate, fromDate), lte(bookings.bookingDate, toDate));
  const base = and(statusFilter, dateFilter);

  const hoursExpr = sql`coalesce(sum(greatest(0::double precision, extract(epoch from (${bookings.endTime}::time - ${bookings.startTime}::time)) / 3600)), 0)`;

  if (scope === 'combined') {
    const [row] = await db
      .select({ booked: hoursExpr })
      .from(bookings)
      .where(base);
    return Number(row?.booked ?? 0);
  }

  const [row] = await db
    .select({ booked: hoursExpr })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(base, eq(locations.name, scope)));
  return Number(row?.booked ?? 0);
}

type BookingDurationRow = {
  bookingDate: string;
  startTime: string;
  endTime: string;
};

async function fetchBookingDurationRows(
  fromDate: string,
  toDate: string,
  scope: LocationScope
): Promise<BookingDurationRow[]> {
  const statusFilter = or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed'));
  const dateFilter = and(gte(bookings.bookingDate, fromDate), lte(bookings.bookingDate, toDate));
  const base = and(statusFilter, dateFilter);

  if (scope === 'combined') {
    const rows = await db
      .select({
        bookingDate: bookings.bookingDate,
        startTime: bookings.startTime,
        endTime: bookings.endTime,
      })
      .from(bookings)
      .where(base);
    return rows.map((r) => ({
      bookingDate: String(r.bookingDate),
      startTime: String(r.startTime),
      endTime: String(r.endTime),
    }));
  }

  const rows = await db
    .select({
      bookingDate: bookings.bookingDate,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
    })
    .from(bookings)
    .innerJoin(rooms, eq(bookings.roomId, rooms.id))
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(and(base, eq(locations.name, scope)));
  return rows.map((r) => ({
    bookingDate: String(r.bookingDate),
    startTime: String(r.startTime),
    endTime: String(r.endTime),
  }));
}

function sumBookedHoursInDateRange(
  rows: BookingDurationRow[],
  fromDate: string,
  toDate: string
): number {
  let booked = 0;
  for (const r of rows) {
    if (r.bookingDate >= fromDate && r.bookingDate <= toDate) {
      booked += durationHoursFromTimes(r.startTime, r.endTime);
    }
  }
  return booked;
}

function buildOccupancyResult(
  fromDate: string,
  toDate: string,
  roomCount: number,
  bookedHours: number
): OccupancyResult {
  const days = countDaysInclusive(fromDate, toDate);
  const totalSlotHours = days * roomCount * DAILY_OPERATING_HOURS;
  const occupancyPercent =
    totalSlotHours > 0
      ? Math.min(100, Math.round((bookedHours / totalSlotHours) * 100 * 100) / 100)
      : 0;
  return {
    fromDate,
    toDate,
    totalSlotHours,
    bookedHours: Math.round(bookedHours * 100) / 100,
    occupancyPercent,
  };
}

export async function computeOccupancy(
  fromDate: string,
  toDate: string,
  scope: LocationScope,
  options?: { roomCount?: number }
): Promise<OccupancyResult> {
  const roomCount = options?.roomCount ?? (await getActiveRoomCount(scope));
  const bookedHours = await getBookedHours(fromDate, toDate, scope);
  return buildOccupancyResult(fromDate, toDate, roomCount, bookedHours);
}

export async function getFiscalYearMonthlyBreakdown(fyStartYear: number) {
  const months = listFiscalYearMonths(fyStartYear);
  const fyLabel = `${fyStartYear}–${String(fyStartYear + 1).slice(-2)}`;
  const fyFrom = months[0].from;
  const fyTo = months[11].to;

  const [roomKen, roomPim, roomComb, rowsKen, rowsPim, rowsComb] = await Promise.all([
    getActiveRoomCount('Kensington'),
    getActiveRoomCount('Pimlico'),
    getActiveRoomCount('combined'),
    fetchBookingDurationRows(fyFrom, fyTo, 'Kensington'),
    fetchBookingDurationRows(fyFrom, fyTo, 'Pimlico'),
    fetchBookingDurationRows(fyFrom, fyTo, 'combined'),
  ]);

  const rows = months.map((m) => {
    const bk = sumBookedHoursInDateRange(rowsKen, m.from, m.to);
    const bp = sumBookedHoursInDateRange(rowsPim, m.from, m.to);
    const bc = sumBookedHoursInDateRange(rowsComb, m.from, m.to);
    return {
      monthKey: m.from.slice(0, 7),
      monthLabel: m.label,
      fromDate: m.from,
      toDate: m.to,
      kensingtonPercent: buildOccupancyResult(m.from, m.to, roomKen, bk).occupancyPercent,
      pimlicoPercent: buildOccupancyResult(m.from, m.to, roomPim, bp).occupancyPercent,
      combinedPercent: buildOccupancyResult(m.from, m.to, roomComb, bc).occupancyPercent,
    };
  });

  return { fyStartYear, fyLabel, months: rows };
}

export async function getMinConfirmedBookingDate(): Promise<string | null> {
  const [row] = await db
    .select({ d: sql<string | null>`min(${bookings.bookingDate})` })
    .from(bookings)
    .where(or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed')));
  return row?.d ?? null;
}

const FIRST_ANNUAL_FY_END = '2026-05-31';

export async function getAnnualFiscalYearSummaries(todayStr: string) {
  if (todayStr < OCCUPANCY_ANNUAL_TABLE_LIVE_DATE) {
    return { rows: [] as Array<Record<string, unknown>> };
  }

  const minDate = await getMinConfirmedBookingDate();
  const currentFyStart = getFiscalYearStartYearUTC(new Date(todayStr + 'T12:00:00Z'));
  const earliestFyStart = minDate
    ? getFiscalYearStartYearUTC(new Date(minDate + 'T12:00:00Z'))
    : currentFyStart;

  const [roomKen, roomPim, roomComb] = await Promise.all([
    getActiveRoomCount('Kensington'),
    getActiveRoomCount('Pimlico'),
    getActiveRoomCount('combined'),
  ]);

  const rows: Array<{
    fyLabel: string;
    fyStartYear: number;
    fromDate: string;
    toDate: string;
    kensingtonPercent: number;
    pimlicoPercent: number;
    combinedPercent: number;
  }> = [];

  for (let fy = earliestFyStart; fy <= currentFyStart; fy++) {
    const { from, to } = getFiscalYearBoundsUTC(fy);
    if (to >= todayStr) continue;
    if (to < FIRST_ANNUAL_FY_END) continue;

    const [ken, pim, comb] = await Promise.all([
      computeOccupancy(from, to, 'Kensington', { roomCount: roomKen }),
      computeOccupancy(from, to, 'Pimlico', { roomCount: roomPim }),
      computeOccupancy(from, to, 'combined', { roomCount: roomComb }),
    ]);

    rows.push({
      fyLabel: `${fy}–${String(fy + 1).slice(-2)}`,
      fyStartYear: fy,
      fromDate: from,
      toDate: to,
      kensingtonPercent: ken.occupancyPercent,
      pimlicoPercent: pim.occupancyPercent,
      combinedPercent: comb.occupancyPercent,
    });
  }

  return { rows };
}

export function resolveOccupancyRange(
  preset: OccupancyRangePreset,
  todayStr: string,
  minBookingDate: string | null
): { from: string; to: string } {
  const today = new Date(todayStr + 'T12:00:00Z');
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();

  const todayFormatted = formatDateUTC(y, m, d);

  if (preset === 'last_month') {
    const firstThis = new Date(Date.UTC(y, m, 1));
    const lastPrev = new Date(Date.UTC(y, m, 0));
    const py = lastPrev.getUTCFullYear();
    const pm = lastPrev.getUTCMonth();
    const from = formatDateUTC(py, pm, 1);
    const to = formatDateUTC(py, pm, lastPrev.getUTCDate());
    return { from, to };
  }

  if (preset === 'last_3_months') {
    const start = new Date(Date.UTC(y, m - 2, 1));
    const sy = start.getUTCFullYear();
    const sm = start.getUTCMonth();
    return { from: formatDateUTC(sy, sm, 1), to: todayFormatted };
  }

  if (preset === 'fy_to_date') {
    const fyStartYear = getFiscalYearStartYearUTC(today);
    const from = getFiscalYearBoundsUTC(fyStartYear).from;
    return { from, to: todayFormatted };
  }

  if (preset === 'two_fy_window') {
    const fyStartYear = getFiscalYearStartYearUTC(today) - 1;
    const from = getFiscalYearBoundsUTC(fyStartYear).from;
    return { from, to: todayFormatted };
  }

  const from = minBookingDate ?? getFiscalYearBoundsUTC(getFiscalYearStartYearUTC(today)).from;
  return { from, to: todayFormatted };
}

function monthIter(fromDate: string, toDate: string): Array<{ from: string; to: string; key: string; label: string }> {
  const months: Array<{ from: string; to: string; key: string; label: string }> = [];
  const end = new Date(toDate + 'T12:00:00Z');
  const startAnchor = new Date(fromDate + 'T12:00:00Z');
  let cur = new Date(Date.UTC(startAnchor.getUTCFullYear(), startAnchor.getUTCMonth(), 1));

  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const monthStart = formatDateUTC(y, m, 1);
    const monthEnd = formatDateUTC(y, m, lastDay);
    const clipFrom = monthStart < fromDate ? fromDate : monthStart;
    const clipTo = monthEnd > toDate ? toDate : monthEnd;
    if (clipFrom <= clipTo) {
      months.push({
        from: clipFrom,
        to: clipTo,
        key: `${y}-${pad2(m + 1)}`,
        label: `${MONTH_NAMES[m]} ${y}`,
      });
    }
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return months;
}

function fiscalYearsOverlapping(fromDate: string, toDate: string): number[] {
  const startFY = getFiscalYearStartYearUTC(new Date(fromDate + 'T12:00:00Z'));
  const endFY = getFiscalYearStartYearUTC(new Date(toDate + 'T12:00:00Z'));
  const years: number[] = [];
  for (let fy = startFY; fy <= endFY; fy++) years.push(fy);
  return years;
}

export async function getOccupancyTimeSeries(
  preset: OccupancyRangePreset,
  todayStr: string,
  scale: 'monthly' | 'annual'
) {
  const minBooking = await getMinConfirmedBookingDate();
  const { from, to } = resolveOccupancyRange(preset, todayStr, minBooking);

  const [roomKen, roomPim, roomComb] = await Promise.all([
    getActiveRoomCount('Kensington'),
    getActiveRoomCount('Pimlico'),
    getActiveRoomCount('combined'),
  ]);
  const roomOpts = {
    Kensington: { roomCount: roomKen } as const,
    Pimlico: { roomCount: roomPim } as const,
    combined: { roomCount: roomComb } as const,
  };

  if (scale === 'monthly') {
    const months = monthIter(from, to);
    const points = await Promise.all(
      months.map(async (mo) => {
        const [ken, pim, comb] = await Promise.all([
          computeOccupancy(mo.from, mo.to, 'Kensington', roomOpts.Kensington),
          computeOccupancy(mo.from, mo.to, 'Pimlico', roomOpts.Pimlico),
          computeOccupancy(mo.from, mo.to, 'combined', roomOpts.combined),
        ]);
        return {
          periodKey: mo.key,
          periodLabel: mo.label,
          kensingtonPercent: ken.occupancyPercent,
          pimlicoPercent: pim.occupancyPercent,
          combinedPercent: comb.occupancyPercent,
        };
      })
    );
    return { range: { from, to, preset }, scale, points };
  }

  const fyYears = fiscalYearsOverlapping(from, to);
  const points = await Promise.all(
    fyYears.map(async (fy) => {
      const bounds = getFiscalYearBoundsUTC(fy);
      const clipFrom = bounds.from < from ? from : bounds.from;
      const clipTo = bounds.to > to ? to : bounds.to;
      const [ken, pim, comb] = await Promise.all([
        computeOccupancy(clipFrom, clipTo, 'Kensington', roomOpts.Kensington),
        computeOccupancy(clipFrom, clipTo, 'Pimlico', roomOpts.Pimlico),
        computeOccupancy(clipFrom, clipTo, 'combined', roomOpts.combined),
      ]);
      return {
        periodKey: `fy-${fy}`,
        periodLabel: `${fy}–${String(fy + 1).slice(-2)}`,
        kensingtonPercent: ken.occupancyPercent,
        pimlicoPercent: pim.occupancyPercent,
        combinedPercent: comb.occupancyPercent,
      };
    })
  );
  return { range: { from, to, preset }, scale, points };
}

export interface HeatmapRoomColumn {
  roomId: string;
  roomName: string;
  locationName: string;
  displayLabel: string;
}

function addBookingOverlapToHour(
  acc: Map<string, number>,
  roomId: string,
  startTime: string,
  endTime: string
) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let startM = sh * 60 + (sm || 0);
  let endM = eh * 60 + (em || 0);
  if (endM <= startM) endM += 24 * 60;

  for (let h = HEATMAP_START_HOUR; h < HEATMAP_END_HOUR_EXCLUSIVE; h++) {
    const slotStart = h * 60;
    const slotEnd = (h + 1) * 60;
    const overlap = Math.max(0, Math.min(endM, slotEnd) - Math.max(startM, slotStart));
    if (overlap > 0) {
      const key = `${roomId}:${h}`;
      acc.set(key, (acc.get(key) ?? 0) + overlap / 60);
    }
  }
}

export async function getOccupancyHeatmap(preset: OccupancyRangePreset, todayStr: string) {
  const minBooking = await getMinConfirmedBookingDate();
  const { from, to } = resolveOccupancyRange(preset, todayStr, minBooking);
  const days = countDaysInclusive(from, to);

  const roomList = await db
    .select({
      roomId: rooms.id,
      roomName: rooms.name,
      locationName: locations.name,
      roomNumber: rooms.roomNumber,
    })
    .from(rooms)
    .innerJoin(locations, eq(rooms.locationId, locations.id))
    .where(eq(rooms.active, true))
    .orderBy(asc(locations.name), asc(rooms.roomNumber));

  const columns: HeatmapRoomColumn[] = roomList.map((r) => ({
    roomId: r.roomId,
    roomName: r.roomName,
    locationName: r.locationName,
    displayLabel:
      r.locationName === 'Kensington'
        ? `Ken · ${r.roomName}`
        : `Pim · ${r.roomName}`,
  }));

  const bookingRows = await db
    .select({
      roomId: bookings.roomId,
      bookingDate: bookings.bookingDate,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
    })
    .from(bookings)
    .where(
      and(
        or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'completed')),
        gte(bookings.bookingDate, from),
        lte(bookings.bookingDate, to)
      )
    );

  const hourBooked = new Map<string, number>();
  for (const b of bookingRows) {
    addBookingOverlapToHour(
      hourBooked,
      b.roomId,
      String(b.startTime),
      String(b.endTime)
    );
  }

  const hours: number[] = [];
  for (let h = HEATMAP_START_HOUR; h < HEATMAP_END_HOUR_EXCLUSIVE; h++) hours.push(h);

  const cells: Array<{
    roomId: string;
    hour: number;
    occupancyPercent: number;
    bookedHours: number;
    capacityHours: number;
  }> = [];

  for (const col of columns) {
    for (const h of hours) {
      const booked = hourBooked.get(`${col.roomId}:${h}`) ?? 0;
      const capacity = days * 1;
      const occupancyPercent =
        capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100 * 100) / 100) : 0;
      cells.push({
        roomId: col.roomId,
        hour: h,
        occupancyPercent,
        bookedHours: Math.round(booked * 100) / 100,
        capacityHours: capacity,
      });
    }
  }

  return {
    range: { from, to, preset },
    hours,
    hourLabels: hours.map((h) => `${String(h).padStart(2, '0')}:00`),
    columns,
    cells,
  };
}
