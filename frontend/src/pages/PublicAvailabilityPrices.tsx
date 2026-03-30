import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { publicApi, type PublicRecurringAvailabilityItem } from '@/services/api';

type LocationName = 'Pimlico' | 'Kensington';

type PermanentRate = {
  roomGroup: string;
  dayType: 'weekday' | 'weekend';
  timeBand: 'morning' | 'afternoon' | 'all_day';
  monthlyFeeGbp: number;
};

type AdHocHourlyRate = {
  dayType: 'weekday' | 'weekend';
  timeBand: 'morning' | 'afternoon' | 'all_day';
  rateGbp: number;
};

const ROOM_GROUP_LABEL: Record<string, string> = {
  room_a: 'Room A',
  rooms_bcd: 'Rooms BCD',
  rooms_1_3_4_5: 'Rooms 1, 3, 4 & 5',
  room_2_6: 'Room 2 & 6',
  rooms_1_6: 'Rooms 1–6',
};

/** Column order for pivoted monthly tables */
const WEEKDAY_GROUP_ORDER: Record<LocationName, string[]> = {
  Pimlico: ['room_a', 'rooms_bcd'],
  Kensington: ['rooms_1_3_4_5', 'room_2_6'],
};

const WEEKEND_GROUP_ORDER: Record<LocationName, string[]> = {
  Pimlico: ['room_a', 'rooms_bcd'],
  Kensington: ['rooms_1_6'],
};

const FULL_WEEK: Array<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
> = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const DAY_LABEL: Record<(typeof FULL_WEEK)[number], string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

const SLOT_LABEL: Record<'morning' | 'afternoon', string> = {
  morning: '8am to 3pm',
  afternoon: '3pm to 10pm',
};

const TIME_BAND_ROWS: Array<'morning' | 'afternoon' | 'all_day'> = ['morning', 'afternoon', 'all_day'];

const TIME_BAND_PRINT: Record<'morning' | 'afternoon' | 'all_day', string> = {
  morning: '8am – 3pm',
  afternoon: '3pm – 10pm',
  all_day: '8am – 10pm',
};

const LOCATION_META: Record<
  LocationName,
  {
    line: string;
    roomsHeading: string;
    weekdayHeader: string;
    weekendHeader: string;
    /** Tailwind bg classes for weekday MF column groups (repeat per column) */
    mfColumnBg: string[];
    weColumnBg: string;
  }
> = {
  Pimlico: {
    line: 'Therapport Limited @ 6a Bessborough Place',
    roomsHeading: 'ROOMS',
    weekdayHeader: 'Monday – Friday',
    weekendHeader: 'Weekend',
    mfColumnBg: ['bg-[#DCF5DD]', 'bg-[#DCF5DD]'],
    weColumnBg: 'bg-neutral-200/80',
  },
  Kensington: {
    line: 'Therapport Limited @ 125 Gloucester Road',
    roomsHeading: 'ROOMS AND SLOTS',
    weekdayHeader: 'Monday – Friday',
    weekendHeader: 'Weekend',
    mfColumnBg: ['bg-[#FFF9E6]', 'bg-[#E8F1F8]'],
    weColumnBg: 'bg-neutral-200/80',
  },
};

const AD_HOC_COPY: Record<LocationName, string> = {
  Pimlico:
    'Ad hoc bookings are available on a subscription basis. Your membership is credited to your account for room bookings. Additional hours cost:',
  Kensington:
    'Ad hoc memberships are priced monthly and credited to your account for room bookings. The credit typically covers between roughly five and eight hours of room use per month, depending on when you book. Additional hours cost:',
};

function formatGbp(n: number): string {
  return `£${n.toFixed(2)}`;
}

function setNoIndexMeta(): () => void {
  let tag = document.querySelector('meta[name="robots"]');
  const previousContent = tag?.getAttribute('content');
  const created = !tag;
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', 'robots');
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', 'noindex, nofollow, noarchive');
  return () => {
    if (created) {
      tag?.remove();
      return;
    }
    if (previousContent == null) {
      tag?.removeAttribute('content');
    } else {
      tag?.setAttribute('content', previousContent);
    }
  };
}

function pickHourly(
  rates: AdHocHourlyRate[] | undefined,
  dayType: 'weekday' | 'weekend',
  band: 'morning' | 'afternoon'
): number | null {
  if (!rates?.length) return null;
  const weekendFlat = rates.find((r) => r.dayType === 'weekend' && r.timeBand === 'all_day');
  if (dayType === 'weekend' && weekendFlat) return weekendFlat.rateGbp;
  return rates.find((r) => r.dayType === dayType && r.timeBand === band)?.rateGbp ?? null;
}

function isPublicRoomRow(x: unknown): x is { id: string; name: string; roomNumber: number } {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.roomNumber === 'number'
  );
}

function isPublicPricesPayload(
  d: unknown
): d is {
  membership: { monthlySubscriptionGbp: number; adHocSubscriptionGbp: number };
  permanentSlotRates: PermanentRate[];
  adHocHourlyRates: AdHocHourlyRate[];
} {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  const m = o.membership;
  if (typeof m !== 'object' || m === null) return false;
  const mem = m as Record<string, unknown>;
  if (typeof mem.monthlySubscriptionGbp !== 'number' || typeof mem.adHocSubscriptionGbp !== 'number') {
    return false;
  }
  if (!Array.isArray(o.permanentSlotRates) || !Array.isArray(o.adHocHourlyRates)) return false;
  return true;
}

function isAvailabilityPayload(x: unknown): x is PublicRecurringAvailabilityItem[] {
  if (!Array.isArray(x)) return false;
  return x.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const o = item as Record<string, unknown>;
    const room = o.room;
    if (typeof room !== 'object' || room === null) return false;
    const r = room as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.roomNumber !== 'number') {
      return false;
    }
    const wd = o.weekday;
    const tb = o.timeBand;
    if (wd !== null && typeof wd !== 'string') return false;
    if (tb !== null && typeof tb !== 'string') return false;
    return typeof o.practitionerName === 'string';
  });
}

function SectionTitle({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="mt-10 mb-4">
      <h2 className="text-base font-bold uppercase tracking-wide text-neutral-900">
        {n} {children}
      </h2>
      <div className="mt-1 h-px w-full max-w-2xl bg-neutral-800/70" />
    </div>
  );
}

export const PublicAvailabilityPrices: React.FC<{ location: LocationName }> = ({ location }) => {
  const meta = LOCATION_META[location];
  const [rooms, setRooms] = useState<Array<{ id: string; name: string; roomNumber: number }>>([]);
  const [availability, setAvailability] = useState<PublicRecurringAvailabilityItem[]>([]);
  const [prices, setPrices] = useState<{
    membership: { monthlySubscriptionGbp: number; adHocSubscriptionGbp: number };
    permanentSlotRates: PermanentRate[];
    adHocHourlyRates: AdHocHourlyRate[];
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const restoreRobotsMeta = setNoIndexMeta();
    const controller = new AbortController();
    setLoadError(false);
    setIsLoading(true);
    Promise.all([
      publicApi.getRooms(location, controller.signal),
      publicApi.getAvailability(location, controller.signal),
      publicApi.getPrices(location, controller.signal),
    ])
      .then(([r, a, p]) => {
        if (
          r.data &&
          typeof r.data === 'object' &&
          'success' in r.data &&
          r.data.success === true &&
          Array.isArray(r.data.data) &&
          r.data.data.every(isPublicRoomRow)
        ) {
          setRooms(r.data.data.slice().sort((x, y) => x.roomNumber - y.roomNumber));
        }
        if (
          a.data &&
          typeof a.data === 'object' &&
          'success' in a.data &&
          a.data.success === true &&
          Array.isArray(a.data.data) &&
          isAvailabilityPayload(a.data.data)
        ) {
          setAvailability(a.data.data);
        }
        if (
          p.data &&
          typeof p.data === 'object' &&
          'success' in p.data &&
          p.data.success === true &&
          p.data.data != null &&
          isPublicPricesPayload(p.data.data)
        ) {
          setPrices(p.data.data);
        }
      })
      .catch((err: unknown) => {
        if (axios.isCancel(err)) return;
        setLoadError(true);
        setRooms([]);
        setAvailability([]);
        setPrices(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      restoreRobotsMeta();
    };
  }, [location]);

  const slotMap = useMemo(() => {
    const map = new Map<string, string[]>();
    availability.forEach((item) => {
      if (!item.weekday || !item.timeBand) return;
      const key = `${item.room.id}|${item.weekday}|${item.timeBand}`;
      const current = map.get(key) || [];
      current.push(item.practitionerName);
      map.set(key, current);
    });
    return map;
  }, [availability]);

  const monthlyMatrix = useMemo(() => {
    if (!prices?.permanentSlotRates.length) return null;
    const rates = prices.permanentSlotRates;
    const wfOrder = WEEKDAY_GROUP_ORDER[location];
    const weOrder = WEEKEND_GROUP_ORDER[location];
    const wfSet = new Set(
      rates.filter((x) => x.dayType === 'weekday').map((x) => x.roomGroup)
    );
    const weSet = new Set(
      rates.filter((x) => x.dayType === 'weekend').map((x) => x.roomGroup)
    );
    const wfGroups = wfOrder.filter((g) => wfSet.has(g));
    const weGroups = weOrder.filter((g) => weSet.has(g));
    const rowBands = TIME_BAND_ROWS.filter((band) =>
      rates.some((r) => r.timeBand === band)
    );
    return { wfGroups, weGroups, rowBands, rates };
  }, [prices, location]);

  const getMonthly = (dayType: 'weekday' | 'weekend', group: string, band: string) =>
    monthlyMatrix?.rates.find(
      (x) => x.dayType === dayType && x.roomGroup === group && x.timeBand === band
    )?.monthlyFeeGbp;

  const isWeekday = (d: (typeof FULL_WEEK)[number]) =>
    d !== 'saturday' && d !== 'sunday';

  return (
    <div className="min-h-screen bg-white text-neutral-900 antialiased">
      <div className="mx-auto max-w-4xl px-6 py-10 md:px-10 md:py-14">
        <header className="mb-8 text-center">
          <p className="font-serif text-lg italic text-neutral-800 md:text-xl">{meta.line}</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-neutral-950 md:text-3xl">
            Price list
          </h1>
          <p className="mt-4">
            <Link
              to="/signup"
              className="inline-block border border-neutral-800 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
            >
              Sign up for memberships
            </Link>
          </p>
        </header>

        {loadError && (
          <p className="mb-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            Could not load this page. Check your connection and try again.
          </p>
        )}

        {isLoading && !loadError && (
          <p className="mb-6 text-sm text-neutral-600">Loading price list…</p>
        )}

        <SectionTitle n="1">{meta.roomsHeading}</SectionTitle>
        <p className="mb-3 text-sm font-semibold text-neutral-800">Monthly fee (payable before the 1st of each month)</p>

        {isLoading && !monthlyMatrix && !loadError && (
          <p className="mb-3 text-sm text-neutral-500">Loading membership fees…</p>
        )}

        {monthlyMatrix && (
          <div className="overflow-x-auto rounded border border-neutral-300">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th
                    rowSpan={2}
                    className="border-r border-neutral-300 bg-white px-2 py-2 text-left font-semibold text-neutral-900"
                  >
                    Slot
                  </th>
                  <th
                    colSpan={monthlyMatrix.wfGroups.length}
                    className="border-r border-neutral-300 bg-[#C8E6C9]/60 px-2 py-2 text-center text-xs font-bold uppercase text-neutral-900"
                  >
                    {meta.weekdayHeader}
                  </th>
                  <th
                    colSpan={monthlyMatrix.weGroups.length}
                    className={`px-2 py-2 text-center text-xs font-bold uppercase text-neutral-900 ${meta.weColumnBg}`}
                  >
                    {meta.weekendHeader}
                  </th>
                </tr>
                <tr className="border-b border-neutral-300">
                  {monthlyMatrix.wfGroups.map((g, i) => (
                    <th
                      key={g}
                      className={`border-r border-neutral-300 px-2 py-2 text-center text-xs font-semibold ${meta.mfColumnBg[i % meta.mfColumnBg.length] ?? 'bg-neutral-100'}`}
                    >
                      {ROOM_GROUP_LABEL[g] ?? g}
                    </th>
                  ))}
                  {monthlyMatrix.weGroups.map((g) => (
                    <th
                      key={g}
                      className={`border-r border-neutral-300 px-2 py-2 text-center text-xs font-semibold last:border-r-0 ${meta.weColumnBg}`}
                    >
                      ({ROOM_GROUP_LABEL[g] ?? g})
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthlyMatrix.rowBands.map((band) => (
                  <tr key={band} className="border-b border-neutral-200 last:border-b-0">
                    <td className="border-r border-neutral-300 bg-white px-2 py-2 font-medium text-neutral-900">
                      {TIME_BAND_PRINT[band]}
                    </td>
                    {monthlyMatrix.wfGroups.map((g, i) => {
                      const v = getMonthly('weekday', g, band);
                      return (
                        <td
                          key={`${g}-${band}`}
                          className={`border-r border-neutral-300 px-2 py-2 text-center tabular-nums ${meta.mfColumnBg[i % meta.mfColumnBg.length] ?? ''}`}
                        >
                          {v != null ? formatGbp(v) : '—'}
                        </td>
                      );
                    })}
                    {monthlyMatrix.weGroups.map((g) => {
                      const v = getMonthly('weekend', g, band);
                      return (
                        <td
                          key={`we-${g}-${band}`}
                          className={`border-r border-neutral-300 px-2 py-2 text-center tabular-nums last:border-r-0 ${meta.weColumnBg}`}
                        >
                          {v != null ? formatGbp(v) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-sm text-neutral-700">
          All rooms are hired on <strong>six-monthly contracts</strong> that can be terminated earlier
          with <strong>one month&apos;s notice</strong>.
        </p>

        <SectionTitle n="2">Availability</SectionTitle>
        <p className="mb-3 text-sm text-neutral-600">
          Permanent slots below repeat each week. Empty weekday cells are available; weekend cells show
          &quot;Free&quot; when open.
        </p>

        <div className="overflow-x-auto rounded border border-neutral-300">
          <table className="w-full min-w-[720px] border-collapse text-xs md:text-sm">
            <thead>
              <tr>
                <th className="border border-neutral-300 bg-neutral-100 px-1 py-2 text-left font-semibold md:px-2">
                  Room
                </th>
                <th className="border border-neutral-300 bg-neutral-100 px-1 py-2 text-left font-semibold md:px-2">
                  Slot
                </th>
                {FULL_WEEK.map((d) => (
                  <th
                    key={d}
                    className={`border border-neutral-300 px-1 py-2 text-center font-semibold md:px-2 ${
                      isWeekday(d) ? 'bg-[#C8E6C9]/50' : 'bg-white'
                    }`}
                  >
                    {DAY_LABEL[d].slice(0, 3)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td className="border border-neutral-300 px-2 py-4 text-neutral-600" colSpan={9}>
                    Loading…
                  </td>
                </tr>
              ) : rooms.length === 0 ? (
                <tr>
                  <td className="border border-neutral-300 px-2 py-4 text-neutral-600" colSpan={9}>
                    No rooms configured for this location.
                  </td>
                </tr>
              ) : (
                rooms.flatMap((room) =>
                  (['morning', 'afternoon'] as const).map((band, rowIdx) => {
                    const rowTint =
                      location === 'Kensington'
                        ? band === 'morning'
                          ? 'bg-[#FFF9E6]/90'
                          : 'bg-[#E3F2FD]/90'
                        : 'bg-white';
                    return (
                      <tr key={`${room.id}-${band}`}>
                        {rowIdx === 0 ? (
                          <td
                            rowSpan={2}
                            className="border border-neutral-300 bg-neutral-50 px-2 py-2 align-middle font-medium"
                          >
                            {room.name}
                          </td>
                        ) : null}
                        <td className={`border border-neutral-300 px-2 py-2 ${rowTint}`}>
                          {SLOT_LABEL[band]}
                        </td>
                        {FULL_WEEK.map((day) => {
                          const names = slotMap.get(`${room.id}|${day}|${band}`) || [];
                          const booked = names.length > 0;
                          const weekend = !isWeekday(day);
                          const cellBg = weekend
                            ? 'bg-white'
                            : booked
                              ? 'bg-[#C8E6C9]/35'
                              : 'bg-[#C8E6C9]/55';
                          return (
                            <td
                              key={`${room.id}-${band}-${day}`}
                              className={`border border-neutral-300 px-1 py-2 text-center align-middle ${cellBg} ${location === 'Kensington' ? rowTint : ''}`}
                            >
                              {booked ? (
                                <span className="text-[0.8rem] font-medium leading-tight md:text-sm">
                                  {names.join(', ')}
                                </span>
                              ) : weekend ? (
                                <span className="text-neutral-500">Free</span>
                              ) : (
                                <span className="text-neutral-400"> </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )
              )}
            </tbody>
          </table>
        </div>

        <SectionTitle n="3">Ad hoc rental</SectionTitle>
        <p className="max-w-prose text-sm leading-relaxed text-neutral-800">
          {AD_HOC_COPY[location]}{' '}
          {prices && (
            <>
              Membership: <strong>{formatGbp(prices.membership.adHocSubscriptionGbp)}</strong> per
              month.
            </>
          )}
        </p>

        {prices && prices.adHocHourlyRates?.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded border border-neutral-300">
            <table className="w-full min-w-[360px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border border-neutral-300 bg-neutral-100 px-2 py-2 text-left">
                    Time
                  </th>
                  <th className="border border-neutral-300 bg-[#C8E6C9]/60 px-2 py-2 text-center">
                    Mon–Fri (per hour)
                  </th>
                  <th className="border border-neutral-300 bg-neutral-200/80 px-2 py-2 text-center">
                    Weekend (per hour)
                  </th>
                </tr>
              </thead>
              <tbody>
                {(['morning', 'afternoon'] as const).map((band) => {
                  const wd = pickHourly(prices.adHocHourlyRates, 'weekday', band);
                  const we = pickHourly(prices.adHocHourlyRates, 'weekend', band);
                  return (
                    <tr key={band}>
                      <td className="border border-neutral-300 px-2 py-2 font-medium">
                        {TIME_BAND_PRINT[band]}
                      </td>
                      <td className="border border-neutral-300 bg-[#C8E6C9]/25 px-2 py-2 text-center tabular-nums">
                        {wd != null ? formatGbp(wd) : '—'}
                      </td>
                      <td className="border border-neutral-300 bg-neutral-100/80 px-2 py-2 text-center tabular-nums">
                        {we != null ? formatGbp(we) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {location === 'Kensington' && (
          <>
            <SectionTitle n="4">Comparison between ad hoc rental and slots</SectionTitle>
            <div className="overflow-x-auto rounded border border-neutral-300">
              <table className="w-full min-w-[480px] border-collapse text-sm">
                <thead>
                  <tr className="bg-neutral-100">
                    <th className="border border-neutral-300 px-2 py-2 text-left font-semibold">
                      Feature
                    </th>
                    <th className="border border-neutral-300 px-2 py-2 text-left font-semibold">
                      Permanent slot
                    </th>
                    <th className="border border-neutral-300 px-2 py-2 text-left font-semibold">
                      Ad hoc
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Structure', 'A regular slot each week', 'Flexible booking'],
                    [
                      'Typical hours included',
                      'About six hours per week (one shift)',
                      'Roughly five to eight hours per month (credit)',
                    ],
                    ['Additional hours', 'Book via the online app', 'Book via the online app'],
                    [
                      'Website profile add-on',
                      'From £12.99 / £15.99 per month',
                      'From £12.99 / £15.99 per month',
                    ],
                    [
                      'Use of practice address (e.g. insurers, directories)',
                      'Yes — with a permanent slot',
                      'No',
                    ],
                    ['Business cards in the waiting area', 'Yes (website practitioners)', 'No'],
                    [
                      'Room price range (indicative)',
                      'See monthly table above',
                      prices ? formatGbp(prices.membership.adHocSubscriptionGbp) + ' membership' : '—',
                    ],
                  ].map(([a, b, c]) => (
                    <tr key={a}>
                      <td className="border border-neutral-300 bg-[#FFF9E6]/40 px-2 py-2 font-medium">
                        {a}
                      </td>
                      <td className="border border-neutral-300 px-2 py-2">{b}</td>
                      <td className="border border-neutral-300 px-2 py-2">{c}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <SectionTitle n="5">Marketing (not available for ad hoc bookers)</SectionTitle>
            <p className="max-w-prose text-sm leading-relaxed text-neutral-800">
              Profile listings and display space may be available for practitioners on permanent slots.
              Please enquire for current options and pricing.
            </p>
          </>
        )}

        <SectionTitle n={location === 'Kensington' ? '6' : '4'}>Signups</SectionTitle>
        <p className="text-sm text-neutral-800">
          Please email{' '}
          <a className="font-semibold underline hover:text-neutral-600" href="mailto:info@therapport.co.uk">
            info@therapport.co.uk
          </a>{' '}
          to confirm your request, or use the sign-up link above.
        </p>
      </div>
    </div>
  );
};
