import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AxiosError } from 'axios';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Icon } from '@/components/ui/Icon';
import { PaymentModal } from '@/components/payment/PaymentModal';
import {
  practitionerApi,
  type BookingItem,
  type RoomItem,
  type CreditSummary,
  type CreateBookingPaymentRequiredError,
} from '@/services/api';
import { toZonedTime } from 'date-fns-tz';
import { canCancelBooking } from '@/lib/booking-utils';
import { formatDateUK } from '@/lib/utils';

type LocationName = 'Pimlico' | 'Kensington';

const LOCATIONS: LocationName[] = ['Pimlico', 'Kensington'];
/** 30-minute options from 08:00 to 22:00 (start times). */
const TIME_OPTIONS_30MIN = (() => {
  const options: { value: string; label: string }[] = [];
  for (let h = 8; h <= 22; h++) {
    options.push({
      value: `${h.toString().padStart(2, '0')}:00`,
      label: `${h.toString().padStart(2, '0')}:00`,
    });
    if (h < 22)
      options.push({
        value: `${h.toString().padStart(2, '0')}:30`,
        label: `${h.toString().padStart(2, '0')}:30`,
      });
  }
  return options;
})();

type CalendarBooking = {
  roomId: string;
  startTime: string;
  endTime: string;
  bookerName?: string;
  userId?: string;
};

/** Maps "HH:mm" to row index 0–28 (08:00 = 0, 22:00 = 28). */
function timeStringToRowIndex(time: string): number {
  const hh = parseInt(time.slice(0, 2), 10);
  const mm = parseInt(time.slice(3, 5), 10);
  return (hh - 8) * 2 + mm / 30;
}

/** Generate a consistent color for a userId */
function getColorForUserId(userId: string | undefined): string {
  if (!userId) return 'bg-primary/20 dark:bg-primary/30 border-primary/40 dark:border-primary/60';
  
  // Generate a hash from userId to get consistent colors
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Use predefined color palette for better visibility
  const colors = [
    'bg-blue-200 dark:bg-blue-800 border-blue-400 dark:border-blue-600',
    'bg-green-200 dark:bg-green-800 border-green-400 dark:border-green-600',
    'bg-yellow-200 dark:bg-yellow-800 border-yellow-400 dark:border-yellow-600',
    'bg-purple-200 dark:bg-purple-800 border-purple-400 dark:border-purple-600',
    'bg-pink-200 dark:bg-pink-800 border-pink-400 dark:border-pink-600',
    'bg-indigo-200 dark:bg-indigo-800 border-indigo-400 dark:border-indigo-600',
    'bg-red-200 dark:bg-red-800 border-red-400 dark:border-red-600',
    'bg-orange-200 dark:bg-orange-800 border-orange-400 dark:border-orange-600',
    'bg-teal-200 dark:bg-teal-800 border-teal-400 dark:border-teal-600',
    'bg-cyan-200 dark:bg-cyan-800 border-cyan-400 dark:border-cyan-600',
  ];
  
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

function getRowSpanForBooking(booking: { startTime: string; endTime: string }): number {
  const start = timeStringToRowIndex(booking.startTime);
  const end = timeStringToRowIndex(booking.endTime);
  return Math.max(1, Math.ceil(end - start));
}

function getBookingStartingAtRow(
  bookings: CalendarBooking[],
  roomId: string,
  rowIndex: number
): CalendarBooking | undefined {
  return bookings.find((b) => {
    if (b.roomId !== roomId) return false;
    return Math.floor(timeStringToRowIndex(b.startTime)) === rowIndex;
  });
}

function isRoomCoveredByRowSpan(
  bookings: CalendarBooking[],
  roomId: string,
  rowIndex: number
): boolean {
  return bookings.some((b) => {
    if (b.roomId !== roomId) return false;
    const startRow = Math.floor(timeStringToRowIndex(b.startTime));
    const endRow = Math.ceil(timeStringToRowIndex(b.endTime));
    return startRow < rowIndex && rowIndex < endRow;
  });
}

/** Today's date in local timezone (YYYY-MM-DD). UK/local. */
function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Today's date in Europe/London (YYYY-MM-DD). Matches backend for past-time checks. */
function todayLondonDateString(): string {
  const z = toZonedTime(new Date(), 'Europe/London');
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, '0');
  const d = String(z.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Minimum start time (HH:mm) for today in Europe/London, rounded up to next 30-min slot. */
function minStartTimeTodayLondon(): string {
  const z = toZonedTime(new Date(), 'Europe/London');
  const h = z.getHours();
  const m = z.getMinutes();
  const minM = m === 0 ? 0 : m <= 30 ? 30 : 0;
  const minH = m <= 30 ? h : h + 1;
  return `${String(minH).padStart(2, '0')}:${String(minM).padStart(2, '0')}`;
}

/** Max booking date: 1 month from today in local timezone (YYYY-MM-DD). Clamps day to last day of target month to avoid overflow (e.g. Jan 31 → Feb 28). */
function maxBookingDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const targetYear = m === 11 ? y + 1 : y;
  const targetMonthIndex = m === 11 ? 0 : m + 1;
  const lastDay = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
  const day = Math.min(d.getDate(), lastDay);
  const target = new Date(targetYear, targetMonthIndex, day);
  return target.toLocaleDateString('en-CA');
}

/** Booking types available to practitioners; admins can also use 'free' and 'internal'. */
const PRACTITIONER_BOOKING_TYPES = [
  { value: 'ad_hoc' as const, label: 'Ad hoc' },
  { value: 'permanent_recurring' as const, label: 'Recurring' },
];
const ALL_BOOKING_TYPES = [
  ...PRACTITIONER_BOOKING_TYPES,
  { value: 'free' as const, label: 'Free' },
  { value: 'internal' as const, label: 'Internal' },
];

function formatMonthKeyToLabel(month: string): string {
  // month is expected to be "YYYY-MM"
  const [year, monthStr] = month.split('-');
  const monthIndex = Number(monthStr) - 1;
  const date = new Date(Number(year), Number.isNaN(monthIndex) ? 0 : monthIndex, 1);
  return date.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
}

export const Bookings: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const postSuccessControllerRef = useRef<AbortController | null>(null);

  const [location, setLocation] = useState<LocationName>('Pimlico');
  const [date, setDate] = useState(todayDateString());
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [bookings, setBookings] = useState<BookingItem[]>([]);
  const [credit, setCredit] = useState<CreditSummary | null>(null);
  const [calendarRooms, setCalendarRooms] = useState<Array<{ id: string; name: string }>>([]);
  const [calendarBookings, setCalendarBookings] = useState<
    Array<{ roomId: string; startTime: string; endTime: string; bookerName?: string; userId?: string }>
  >([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [loadingCredit, setLoadingCredit] = useState(false);
  const [quotePrice, setQuotePrice] = useState<number | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentClientSecret, setPaymentClientSecret] = useState<string | null>(null);
  const [paymentAmountPence, setPaymentAmountPence] = useState<number | undefined>(undefined);
  // Form state
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [bookingType, setBookingType] = useState<
    'ad_hoc' | 'permanent_recurring' | 'free' | 'internal'
  >('ad_hoc');

  const fetchRooms = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingRooms(true);
      try {
        const res = await practitionerApi.getRooms(location, signal);
        if (signal?.aborted) return;
        if (res.data.success && res.data.rooms) {
          setRooms(res.data.rooms);
          setSelectedRoomId(res.data.rooms[0]?.id ?? null);
        }
      } catch (err) {
        if (
          signal?.aborted ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
        )
          return;
        setRooms([]);
        setSelectedRoomId(null);
      } finally {
        if (!signal?.aborted) setLoadingRooms(false);
      }
    },
    [location]
  );

  const fetchCalendar = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingCalendar(true);
      try {
        const res = await practitionerApi.getCalendar(location, date, signal);
        if (signal?.aborted) return;
        if (res.data.success) {
          setCalendarRooms(res.data.rooms ?? []);
          setCalendarBookings(res.data.bookings ?? []);
        } else {
          setCalendarRooms([]);
          setCalendarBookings([]);
        }
      } catch (err) {
        if (
          signal?.aborted ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
        )
          return;
        setCalendarRooms([]);
        setCalendarBookings([]);
      } finally {
        if (!signal?.aborted) setLoadingCalendar(false);
      }
    },
    [location, date]
  );

  const fetchBookings = useCallback(async (signal?: AbortSignal) => {
    setLoadingBookings(true);
    try {
      const res = await practitionerApi.getBookings({}, signal);
      if (signal?.aborted) return;
      if (res.data.success && res.data.bookings) {
        setBookings(res.data.bookings);
      } else {
        setBookings([]);
      }
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
      )
        return;
      setBookings([]);
    } finally {
      if (!signal?.aborted) setLoadingBookings(false);
    }
  }, []);

  const fetchCredit = useCallback(async (signal?: AbortSignal) => {
    setLoadingCredit(true);
    try {
      const res = await practitionerApi.getCredits(signal);
      if (signal?.aborted) return;
      if (res.data.success && res.data.credit) {
        setCredit(res.data.credit);
      } else {
        setCredit(null);
      }
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
      )
        return;
      setCredit(null);
    } finally {
      if (!signal?.aborted) setLoadingCredit(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchRooms(controller.signal);
    return () => controller.abort();
  }, [fetchRooms]);

  useEffect(() => {
    const controller = new AbortController();
    fetchCalendar(controller.signal);
    return () => controller.abort();
  }, [fetchCalendar]);

  useEffect(() => {
    if (!selectedRoomId || endTime <= startTime) {
      setQuotePrice(null);
      return;
    }
    const controller = new AbortController();
    setLoadingQuote(true);
    practitionerApi
      .getBookingQuote(selectedRoomId, date, startTime, endTime, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.data.success && typeof res.data.totalPrice === 'number') {
          setQuotePrice(res.data.totalPrice);
        } else {
          setQuotePrice(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setQuotePrice(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingQuote(false);
      });
    return () => controller.abort();
  }, [selectedRoomId, date, startTime, endTime]);

  useEffect(() => {
    const controller = new AbortController();
    fetchBookings(controller.signal);
    return () => controller.abort();
  }, [fetchBookings]);

  useEffect(() => {
    const controller = new AbortController();
    fetchCredit(controller.signal);
    return () => controller.abort();
  }, [fetchCredit]);

  useEffect(() => {
    return () => {
      postSuccessControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (window.location.hash === '#my-bookings') {
      const el = document.getElementById('my-bookings');
      el?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  const bookingTypesForUser =
    user?.role === 'admin' ? ALL_BOOKING_TYPES : PRACTITIONER_BOOKING_TYPES;

  useEffect(() => {
    if (user?.role !== 'admin' && (bookingType === 'free' || bookingType === 'internal')) {
      setBookingType('ad_hoc');
    }
  }, [user?.role, bookingType]);

  const handleCreateBooking = async () => {
    if (!selectedRoomId) {
      setCreateError('Please select a room.');
      return;
    }
    if (endTime <= startTime) {
      setCreateError('End time must be after start time.');
      return;
    }
    if (date === todayLondonDateString() && startTime < minStartTimeTodayLondon()) {
      setCreateError('Cannot book a time that has already passed.');
      return;
    }
    setCreateError(null);
    setCreateSuccess(null);
    setSubmitting(true);
    try {
      const res = await practitionerApi.createBooking({
        roomId: selectedRoomId,
        date,
        startTime,
        endTime,
        bookingType: user?.role === 'admin' ? bookingType : 'ad_hoc',
      });
      const data = res.data;
      if (data.success && 'booking' in data) {
        setCreateSuccess('Booking created.');
        const c = new AbortController();
        postSuccessControllerRef.current = c;
        fetchBookings(c.signal);
        fetchCalendar(c.signal);
        fetchCredit(c.signal);
      } else if (!data.success && 'error' in data) {
        setCreateError(data.error ?? 'Failed to create booking');
      } else {
        setCreateError('Failed to create booking');
      }
    } catch (err: unknown) {
      // Use AxiosError for type narrowing and verify HTTP status code
      if (err instanceof AxiosError && err.response) {
        const status = err.response.status;
        const data = err.response.data as CreateBookingPaymentRequiredError | { error?: string } | undefined;

        // Handle payment required case (backend returns 402 with paymentRequired: true)
        if (status === 402 && data && 'paymentRequired' in data && data.paymentRequired) {
          const paymentData = data as CreateBookingPaymentRequiredError;
          if (paymentData.clientSecret && paymentData.amountPence != null) {
            setCreateError(null);
            setPaymentClientSecret(paymentData.clientSecret);
            setPaymentAmountPence(paymentData.amountPence);
            setPaymentModalOpen(true);
            return;
          }
        }

        // Handle regular error case
        const errorMsg = (data && 'error' in data ? data.error : undefined) ?? 'Failed to create booking';
        setCreateError(errorMsg);
      } else {
        setCreateError('Failed to create booking');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelBooking = async (id: string) => {
    if (!window.confirm('Are you sure you want to cancel this booking?')) return;
    setCancellingId(id);
    setCancelError(null);
    try {
      await practitionerApi.cancelBooking(id);
      setCancelError(null);
      const c = new AbortController();
      postSuccessControllerRef.current = c;
      fetchBookings(c.signal);
      fetchCalendar(c.signal);
      fetchCredit(c.signal);
    } catch (err) {
      console.error('Cancel booking failed', err);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : null;
      setCancelError(msg ?? 'Cancellation failed. Please try again.');
    } finally {
      setCancellingId(null);
    }
  };

  const today = useMemo(() => todayDateString(), []);
  const todayLondon = useMemo(() => todayLondonDateString(), []);
  const isDateToday = date === todayLondon;
  const minStartToday = minStartTimeTodayLondon();
  const startTimeOptions = isDateToday
    ? TIME_OPTIONS_30MIN.filter((o) => o.value >= minStartToday)
    : TIME_OPTIONS_30MIN;
  const endTimeOptions = isDateToday
    ? TIME_OPTIONS_30MIN.filter((o) => o.value > startTime && o.value >= minStartToday)
    : TIME_OPTIONS_30MIN.filter((o) => o.value > startTime);

  // When date is today, reset start/end if they fall in the past; avoid loops and never set endTime === startTime
  useEffect(() => {
    if (!isDateToday) return;
    const minStart = minStartTimeTodayLondon();
    if (startTime < minStart) {
      const first = TIME_OPTIONS_30MIN.find((o) => o.value >= minStart);
      if (!first) return;
      const nextAfterFirst = TIME_OPTIONS_30MIN.find((o) => o.value > first.value);
      const desiredStart = first.value;
      const desiredEnd = nextAfterFirst?.value;
      if (desiredStart !== startTime) setStartTime(desiredStart);
      if (desiredEnd && desiredEnd > desiredStart && desiredEnd !== endTime) {
        setEndTime(desiredEnd);
      }
      return;
    }
    if (endTime <= startTime || endTime < minStart) {
      const nextAfterStart = TIME_OPTIONS_30MIN.find((o) => o.value > startTime);
      const desiredEnd = nextAfterStart?.value;
      if (desiredEnd && desiredEnd > startTime && desiredEnd !== endTime) {
        setEndTime(desiredEnd);
      }
    }
  }, [date, isDateToday, startTime, endTime]);

  const confirmedUpcoming = bookings.filter(
    (b) => b.status === 'confirmed' && b.bookingDate >= today
  );

  const monthlyCreditBreakdown = useMemo(
    () =>
      credit?.byMonth
        ? [...credit.byMonth].sort((a, b) => a.month.localeCompare(b.month))
        : [],
    [credit?.byMonth]
  );

  const handlePaymentModalOpenChange = (open: boolean) => {
    setPaymentModalOpen(open);
    if (!open) {
      setPaymentClientSecret(null);
      setPaymentAmountPence(undefined);
    }
  };

  const handlePaymentSuccess = () => {
    setPaymentModalOpen(false);
    setPaymentClientSecret(null);
    setPaymentAmountPence(undefined);
    setCreateSuccess('Booking created.');
    setCreateError(null);
    const c = new AbortController();
    postSuccessControllerRef.current = c;
    fetchBookings(c.signal);
    fetchCalendar(c.signal);
    fetchCredit(c.signal);
  };

  return (
    <MainLayout>
      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={handlePaymentModalOpenChange}
        clientSecret={paymentClientSecret}
        amountPence={paymentAmountPence}
        onSuccess={handlePaymentSuccess}
        title="Pay the difference to complete your booking"
      />
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Bookings</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            View the calendar, create bookings, and manage your schedule.
          </p>
        </div>

        {/* Credit summary */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Icon name="account_balance_wallet" className="text-primary" />
              Credit balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingCredit ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : credit?.membershipType === 'permanent' ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-500">Permanent membership — no credit balance.</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-primary mt-2"
                  onClick={() => navigate('/finance')}
                >
                  View Transaction History
                </Button>
              </div>
            ) : monthlyCreditBreakdown.length > 0 ? (
              <div className="space-y-2">
                <ul className="space-y-1">
                  {monthlyCreditBreakdown.map(({ month, remainingCredit }) => (
                    <li key={month} className="flex items-center gap-2">
                      <span className="text-sm text-slate-600 dark:text-slate-300">
                        {formatMonthKeyToLabel(month)}
                      </span>
                      <span className="text-sm font-bold text-slate-900 dark:text-white tabular-nums">
                        £{remainingCredit.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-primary mt-2"
                  onClick={() => navigate('/finance')}
                >
                  View Transaction History
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-600 dark:text-slate-300">
                    {credit?.currentMonth?.monthYear
                      ? formatMonthKeyToLabel(credit.currentMonth.monthYear.slice(0, 7))
                      : formatMonthKeyToLabel(new Date().toISOString().slice(0, 7))}
                  </span>
                  <span className="text-sm font-bold text-slate-900 dark:text-white tabular-nums">
                    £{credit?.currentMonth?.remainingCredit != null 
                      ? credit.currentMonth.remainingCredit.toFixed(2) 
                      : '0.00'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-primary mt-2"
                  onClick={() => navigate('/finance')}
                >
                  View Transaction History
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Calendar: location, date, day grid with rooms as columns */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Calendar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex gap-2">
                {LOCATIONS.map((loc) => (
                  <Button
                    key={loc}
                    variant={location === loc ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setLocation(loc)}
                  >
                    {loc}
                  </Button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-slate-600 dark:text-slate-400">Date</span>
                <input
                  type="date"
                  value={date}
                  min={today}
                  max={maxBookingDateString()}
                  onChange={(e) => setDate(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                />
              </label>
            </div>
            {loadingCalendar ? (
              <p className="text-sm text-slate-500">Loading calendar…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[400px] text-sm" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th className="border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 p-1.5 text-left text-xs font-medium text-slate-600 dark:text-slate-400 w-[60px]">
                        Time
                      </th>
                      {calendarRooms.map((r) => (
                        <th
                          key={r.id}
                          className="border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 p-1.5 text-center text-xs font-medium text-slate-700 dark:text-slate-300"
                          style={{ width: `${100 / calendarRooms.length}%` }}
                        >
                          {r.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 29 }, (_, i) => {
                      const h = 8 + Math.floor(i / 2);
                      const m = (i % 2) * 30;
                      const timeLabel = `${h.toString().padStart(2, '0')}:${m
                        .toString()
                        .padStart(2, '0')}`;
                      return (
                        <tr key={i}>
                          <td className="border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 text-xs text-slate-500 dark:text-slate-400 align-top">
                            {timeLabel}
                          </td>
                          {calendarRooms.map((room) => {
                            if (isRoomCoveredByRowSpan(calendarBookings, room.id, i)) return null;
                            const bookingStartingHere = getBookingStartingAtRow(
                              calendarBookings,
                              room.id,
                              i
                            );
                            if (bookingStartingHere) {
                              const rowSpan = getRowSpanForBooking(bookingStartingHere);
                              return (
                                <td
                                  key={room.id}
                                  rowSpan={rowSpan}
                                  className={`border ${getColorForUserId(bookingStartingHere.userId)} p-1 align-top`}
                                >
                                  <span className="text-xs font-medium truncate block text-slate-900 dark:text-slate-100">
                                    {bookingStartingHere.bookerName || 'Booking'}
                                  </span>
                                </td>
                              );
                            }
                            return (
                              <td
                                key={room.id}
                                className="border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 min-h-[14px]"
                              />
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Create booking form */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">New booking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Booking for {formatDateUK(date)} in {location}
            </p>
            {loadingRooms ? (
              <p className="text-sm text-slate-500">Loading rooms…</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <span className="text-sm text-slate-600 dark:text-slate-400">Room:</span>
                {rooms.map((r) => (
                  <Button
                    key={r.id}
                    variant={selectedRoomId === r.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedRoomId(r.id)}
                  >
                    {r.name}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-4 items-end">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600 dark:text-slate-400">Start</span>
                <select
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  {startTimeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600 dark:text-slate-400">End</span>
                <select
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  {endTimeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {user?.role === 'admin' && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Type</span>
                  <select
                    value={bookingType}
                    onChange={(e) => setBookingType(e.target.value as typeof bookingType)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  >
                    {bookingTypesForUser.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Price:{' '}
                  {loadingQuote ? '—' : quotePrice != null ? `£${quotePrice.toFixed(2)}` : '—'}
                </span>
                <Button onClick={handleCreateBooking} disabled={submitting || !selectedRoomId}>
                  {submitting ? 'Creating…' : 'Create booking'}
                </Button>
              </div>
            </div>
            {createError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {createError}
              </p>
            )}
            {createSuccess && (
              <output
                className="block text-sm text-green-600 dark:text-green-400"
                aria-live="polite"
              >
                {createSuccess}
              </output>
            )}
          </CardContent>
        </Card>

        {/* My bookings list */}
        <Card id="my-bookings">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">My bookings</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
              Cancellation with less than 24 hours notice is not permitted.
            </p>
            {cancelError && (
              <p className="text-sm text-red-600 dark:text-red-400 mb-4" role="alert">
                {cancelError}
              </p>
            )}
            {loadingBookings ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : confirmedUpcoming.length === 0 ? (
              <p className="text-sm text-slate-500">No upcoming confirmed bookings.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[550px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {confirmedUpcoming.map((b) => {
                      const isCancelable = canCancelBooking(b.bookingDate, b.startTime);
                      return (
                        <TableRow key={b.id}>
                          <TableCell>{formatDateUK(b.bookingDate)}</TableCell>
                          <TableCell>
                            {b.roomName} ({b.locationName})
                          </TableCell>
                          <TableCell>
                            {b.startTime.slice(0, 5)} – {b.endTime.slice(0, 5)}
                          </TableCell>
                          <TableCell>£{b.totalPrice.toFixed(2)}</TableCell>
                          <TableCell>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCancelBooking(b.id)}
                              disabled={cancellingId === b.id || !isCancelable}
                              className="text-red-600 hover:text-red-700"
                              title={
                                !isCancelable
                                  ? 'Cancellation with less than 24 hours notice is not permitted'
                                  : undefined
                              }
                            >
                              {cancellingId === b.id ? 'Cancelling…' : 'Cancel'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};
