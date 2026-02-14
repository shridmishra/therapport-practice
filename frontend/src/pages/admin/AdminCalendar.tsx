import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { AccessDenied } from '@/components/AccessDenied';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatDateUK } from '@/lib/utils';
import { PaymentModal } from '@/components/payment/PaymentModal';
import {
  useRooms,
  useCalendar,
  usePractitioners,
  useBookingHandlers,
  type LocationName,
  type CalendarBooking,
} from './AdminCalendar.hooks';

const LOCATIONS: LocationName[] = ['Pimlico', 'Kensington'];

const TIME_OPTIONS_30MIN = (() => {
  const options: { value: string; label: string }[] = [];
  for (let h = 8; h <= 21; h++) {
    options.push({
      value: `${h.toString().padStart(2, '0')}:00`,
      label: `${h.toString().padStart(2, '0')}:00`,
    });
    if (h <= 21)
      options.push({
        value: `${h.toString().padStart(2, '0')}:30`,
        label: `${h.toString().padStart(2, '0')}:30`,
      });
  }
  return options;
})();

function timeStringToRowIndex(time: string): number {
  const hh = parseInt(time.slice(0, 2), 10);
  const mm = parseInt(time.slice(3, 5), 10);
  return (hh - 8) * 2 + mm / 30;
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

function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA');
}

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

const ALL_BOOKING_TYPES = [
  { value: 'ad_hoc' as const, label: 'Ad hoc' },
  { value: 'permanent_recurring' as const, label: 'Recurring' },
  { value: 'free' as const, label: 'Free' },
];

export const AdminCalendar: React.FC = () => {
  const { user } = useAuth();
  const [location, setLocation] = useState<LocationName>('Pimlico');
  const [date, setDate] = useState(todayDateString());
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [bookingType, setBookingType] = useState<
    'ad_hoc' | 'permanent_recurring' | 'free'
  >('ad_hoc');
  const [targetUserId, setTargetUserId] = useState<string>('');

  const { rooms, selectedRoomId, setSelectedRoomId, loadingRooms } = useRooms(location);
  const { calendarRooms, calendarBookings, loadingCalendar, fetchCalendar } = useCalendar(
    location,
    date
  );
  const { practitioners, loadingPractitioners } = usePractitioners(
    bookingType === 'free' || bookingType === 'ad_hoc'
  );
  const {
    quotePrice,
    loadingQuote,
    submitting,
    createError,
    setCreateError,
    createSuccess,
    setCreateSuccess,
    cancelError,
    cancellingId,
    handleCreateBooking,
    handleCancelBooking,
    modifyBooking,
    setModifyBooking,
    modifySubmitting,
    modifyError,
    handleUpdateBooking,
    paymentModalOpen,
    setPaymentModalOpen,
    paymentClientSecret,
    setPaymentClientSecret,
    paymentAmountPence,
    setPaymentAmountPence,
  } = useBookingHandlers({
    selectedRoomId,
    date,
    startTime,
    endTime,
    bookingType,
    targetUserId,
    fetchCalendar,
  });

  if (user?.role !== 'admin') return <AccessDenied />;

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Admin Calendar</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            View room usage, create bookings on behalf of practitioners, and modify or cancel
            bookings.
          </p>
        </div>

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
                  min={todayDateString()}
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
                    {Array.from({ length: 28 }, (_, i) => {
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
                            const booking = getBookingStartingAtRow(calendarBookings, room.id, i);
                            if (booking) {
                              const rowSpan = getRowSpanForBooking(booking);
                              return (
                                <td
                                  key={room.id}
                                  rowSpan={rowSpan}
                                  className="border border-slate-200 dark:border-slate-700 bg-primary/20 dark:bg-primary/30 border-primary/40 p-1 align-top"
                                >
                                  <div className="flex flex-col gap-1">
                                    {booking.bookerName && (
                                      <span className="text-xs font-medium">
                                        {booking.bookerName}
                                      </span>
                                    )}
                                    {booking.id && (() => {
                                      const bookingId = booking.id;
                                      return (
                                        <div className="flex flex-wrap gap-1 mt-1">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-6 text-xs"
                                            onClick={() =>
                                              setModifyBooking({
                                                id: bookingId,
                                                roomId: booking.roomId,
                                                bookingDate: date,
                                                startTime: booking.startTime,
                                                endTime: booking.endTime,
                                              })
                                            }
                                          >
                                            Modify
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            className="h-6 text-xs"
                                            disabled={cancellingId === bookingId}
                                            onClick={() => handleCancelBooking(bookingId)}
                                          >
                                            {cancellingId === bookingId ? 'Cancelling…' : 'Cancel'}
                                          </Button>
                                        </div>
                                      );
                                    })()}
                                  </div>
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Create booking</CardTitle>
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
                <span className="text-slate-600 dark:text-slate-400">Type</span>
                <select
                  value={bookingType}
                  onChange={(e) => {
                    setBookingType(e.target.value as typeof bookingType);
                    setTargetUserId('');
                  }}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  {ALL_BOOKING_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {(bookingType === 'free' || bookingType === 'ad_hoc') && (
                <label className="flex flex-col gap-1 text-sm min-w-[200px]">
                  <span className="text-slate-600 dark:text-slate-400">Practitioner</span>
                  <select
                    value={targetUserId}
                    onChange={(e) => setTargetUserId(e.target.value)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                    disabled={loadingPractitioners}
                  >
                    <option value="">Select practitioner</option>
                    {practitioners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600 dark:text-slate-400">Start</span>
                <select
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  {TIME_OPTIONS_30MIN.map((o) => (
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
                  {TIME_OPTIONS_30MIN.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
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
            {cancelError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {cancelError}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!modifyBooking} onOpenChange={(open) => !open && setModifyBooking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modify booking</DialogTitle>
          </DialogHeader>
          {modifyBooking && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Room</Label>
                <select
                  value={modifyBooking.roomId}
                  onChange={(e) =>
                    setModifyBooking((p) => (p ? { ...p, roomId: e.target.value } : null))
                  }
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  {calendarRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label>Date</Label>
                <input
                  type="date"
                  value={modifyBooking.bookingDate}
                  min={todayDateString()}
                  max={maxBookingDateString()}
                  onChange={(e) =>
                    setModifyBooking((p) => (p ? { ...p, bookingDate: e.target.value } : null))
                  }
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-2">
                  <Label>Start</Label>
                  <select
                    value={modifyBooking.startTime}
                    onChange={(e) =>
                      setModifyBooking((p) => (p ? { ...p, startTime: e.target.value } : null))
                    }
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  >
                    {TIME_OPTIONS_30MIN.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>End</Label>
                  <select
                    value={modifyBooking.endTime}
                    onChange={(e) =>
                      setModifyBooking((p) => (p ? { ...p, endTime: e.target.value } : null))
                    }
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  >
                    {TIME_OPTIONS_30MIN.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {modifyError && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {modifyError}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setModifyBooking(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateBooking} disabled={modifySubmitting || !modifyBooking}>
              {modifySubmitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={(open) => {
          setPaymentModalOpen(open);
          if (!open) {
            setPaymentClientSecret(null);
            setPaymentAmountPence(undefined);
          }
        }}
        clientSecret={paymentClientSecret}
        amountPence={paymentAmountPence}
        onSuccess={() => {
          setPaymentModalOpen(false);
          setPaymentClientSecret(null);
          setPaymentAmountPence(undefined);
          setCreateSuccess('Booking created.');
          setCreateError(null);
          fetchCalendar();
        }}
      />
    </MainLayout>
  );
};
