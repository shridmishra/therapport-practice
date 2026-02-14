import { useState, useEffect, useCallback } from 'react';
import { AxiosError } from 'axios';
import {
  practitionerApi,
  adminApi,
  type RoomItem,
  type CreateBookingPaymentRequiredError,
} from '@/services/api';

export type LocationName = 'Pimlico' | 'Kensington';

export type CalendarBooking = {
  id?: string;
  roomId: string;
  startTime: string;
  endTime: string;
  bookerName?: string;
};

export type PractitionerOption = { id: string; label: string };

export type ModifyBookingState = {
  id: string;
  roomId: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
} | null;

export function useRooms(location: LocationName) {
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [loadingRooms, setLoadingRooms] = useState(false);

  const fetchRooms = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingRooms(true);
      try {
        const res = await practitionerApi.getRooms(location, signal);
        if (signal?.aborted) return;
        if (res.data.success && res.data.rooms) {
          setRooms(res.data.rooms);
          setSelectedRoomId((prev) =>
            res.data.rooms?.some((r) => r.id === prev) ? prev : res.data.rooms?.[0]?.id ?? null
          );
        }
      } catch {
        setRooms([]);
        setSelectedRoomId(null);
      } finally {
        if (!signal?.aborted) setLoadingRooms(false);
      }
    },
    [location]
  );

  useEffect(() => {
    const c = new AbortController();
    fetchRooms(c.signal);
    return () => c.abort();
  }, [fetchRooms]);

  return { rooms, selectedRoomId, setSelectedRoomId, loadingRooms, fetchRooms };
}

export function useCalendar(location: LocationName, date: string) {
  const [calendarRooms, setCalendarRooms] = useState<Array<{ id: string; name: string }>>([]);
  const [calendarBookings, setCalendarBookings] = useState<CalendarBooking[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);

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
      } catch {
        setCalendarRooms([]);
        setCalendarBookings([]);
      } finally {
        if (!signal?.aborted) setLoadingCalendar(false);
      }
    },
    [location, date]
  );

  useEffect(() => {
    const c = new AbortController();
    fetchCalendar(c.signal);
    return () => c.abort();
  }, [fetchCalendar]);

  return { calendarRooms, calendarBookings, loadingCalendar, fetchCalendar };
}

export function usePractitioners(shouldFetch: boolean) {
  const [practitioners, setPractitioners] = useState<PractitionerOption[]>([]);
  const [loadingPractitioners, setLoadingPractitioners] = useState(false);

  const fetchPractitioners = useCallback(async () => {
    setLoadingPractitioners(true);
    try {
      const res = await adminApi.getPractitioners('', 1, 500);
      const data = res.data as {
        success?: boolean;
        data?: Array<{ id: string; firstName?: string; lastName?: string; email: string }>;
      };
      if (data.success && Array.isArray(data.data)) {
        setPractitioners(
          data.data.map((p) => ({
            id: p.id,
            label: [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email || p.id,
          }))
        );
      } else {
        setPractitioners([]);
      }
    } catch {
      setPractitioners([]);
    } finally {
      setLoadingPractitioners(false);
    }
  }, []);

  useEffect(() => {
    if (shouldFetch) {
      fetchPractitioners();
    }
  }, [shouldFetch, fetchPractitioners]);

  return { practitioners, loadingPractitioners, fetchPractitioners };
}

export type UseBookingHandlersParams = {
  selectedRoomId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  bookingType: 'ad_hoc' | 'permanent_recurring' | 'free';
  targetUserId: string;
  fetchCalendar: (signal?: AbortSignal) => Promise<void>;
};

export function useBookingHandlers(params: UseBookingHandlersParams) {
  const { selectedRoomId, date, startTime, endTime, bookingType, targetUserId, fetchCalendar } =
    params;

  const [quotePrice, setQuotePrice] = useState<number | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [modifyBooking, setModifyBooking] = useState<ModifyBookingState>(null);
  const [modifySubmitting, setModifySubmitting] = useState(false);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentClientSecret, setPaymentClientSecret] = useState<string | null>(null);
  const [paymentAmountPence, setPaymentAmountPence] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!selectedRoomId || endTime <= startTime) {
      setQuotePrice(null);
      return;
    }
    const c = new AbortController();
    setLoadingQuote(true);
    practitionerApi
      .getBookingQuote(selectedRoomId, date, startTime, endTime, c.signal)
      .then((res) => {
        if (c.signal.aborted) return;
        if (res.data.success && typeof res.data.totalPrice === 'number') {
          setQuotePrice(res.data.totalPrice);
        } else {
          setQuotePrice(null);
        }
      })
      .catch(() => {
        if (!c.signal.aborted) setQuotePrice(null);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoadingQuote(false);
      });
    return () => c.abort();
  }, [selectedRoomId, date, startTime, endTime]);

  const handleCreateBooking = useCallback(async () => {
    if (!selectedRoomId) {
      setCreateError('Please select a room.');
      return;
    }
    if (endTime <= startTime) {
      setCreateError('End time must be after start time.');
      return;
    }
    if ((bookingType === 'free' || bookingType === 'ad_hoc') && !targetUserId) {
      setCreateError('Please select a practitioner.');
      return;
    }
    setCreateError(null);
    setCreateSuccess(null);
    setSubmitting(true);
    try {
      const payload: Parameters<typeof practitionerApi.createBooking>[0] = {
        roomId: selectedRoomId,
        date,
        startTime,
        endTime,
        bookingType,
      };
      if ((bookingType === 'free' || bookingType === 'ad_hoc') && targetUserId) {
        payload.targetUserId = targetUserId;
      }
      const res = await practitionerApi.createBooking(payload);
      const data = res.data;
      if (data.success && 'booking' in data) {
        setCreateSuccess('Booking created.');
        fetchCalendar();
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
  }, [selectedRoomId, date, startTime, endTime, bookingType, targetUserId, fetchCalendar]);

  const handleCancelBooking = useCallback(
    async (id: string) => {
      setCancelError(null);
      setCancellingId(id);
      try {
        await practitionerApi.cancelBooking(id);
        await fetchCalendar();
      } catch (err: unknown) {
        const msg =
          err && typeof err === 'object' && 'response' in err
            ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
            : null;
        setCancelError(msg ?? 'Failed to cancel booking');
      } finally {
        setCancellingId(null);
      }
    },
    [fetchCalendar]
  );

  const handleUpdateBooking = useCallback(async () => {
    if (!modifyBooking) return;
    setModifyError(null);
    setModifySubmitting(true);
    try {
      await practitionerApi.updateBooking(modifyBooking.id, {
        roomId: modifyBooking.roomId,
        bookingDate: modifyBooking.bookingDate,
        startTime: modifyBooking.startTime,
        endTime: modifyBooking.endTime,
      });
      setModifyBooking(null);
      await fetchCalendar();
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : null;
      setModifyError(msg ?? 'Failed to update booking');
    } finally {
      setModifySubmitting(false);
    }
  }, [modifyBooking, fetchCalendar]);

  return {
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
  };
}
