import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
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
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/Icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import api, { practitionerApi } from '@/services/api';
import { useNavigate } from 'react-router-dom';
import { canCancelBooking } from '@/lib/booking-utils';
import type { DocumentData } from '@/types/documents';
import axios from 'axios';

type DocumentState = { status: 'loading' } | { status: 'loaded'; data: DocumentData | null };

interface DashboardData {
  freeBookingHours: {
    remaining: number;
    totalAllocated: number;
    totalUsed: number;
    latestExpiry: string | null;
  };
  credit: {
    currentMonth: {
      monthYear: string;
      totalGranted: number;
      totalUsed: number;
      remainingCredit: number;
    } | null;
    nextMonth: {
      monthYear: string;
      nextMonthAllocation: number;
    } | null;
    byMonth?: Array<{
      month: string;
      remainingCredit: number;
    }>;
    membershipType: 'permanent' | 'ad_hoc' | null;
  };
  upcomingBookings: Array<{
    id: string;
    roomName: string;
    locationName: string;
    bookingDate: string;
    startTime: string;
    endTime: string;
    totalPrice: number;
    status: string;
  }>;
}

export const Dashboard: React.FC = () => {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [insuranceDocument, setInsuranceDocument] = useState<DocumentState>({ status: 'loading' });
  const [clinicalDocument, setClinicalDocument] = useState<DocumentState>({ status: 'loading' });
  const [subscriptionCanBook, setSubscriptionCanBook] = useState<boolean | null>(null);
  const [subscriptionMembershipType, setSubscriptionMembershipType] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const retryControllerRef = useRef<AbortController | null>(null);
  const cancelBookingControllerRef = useRef<AbortController | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const getInitials = (firstName?: string, lastName?: string) => {
    const first = firstName?.charAt(0) || '';
    const last = lastName?.charAt(0) || '';
    return `${first}${last}`.toUpperCase() || 'U';
  };

  const currentDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const fetchDashboardData = useCallback(async (signal?: AbortSignal) => {
    try {
      if (!isMountedRef.current) return;
      setLoading(true);
      setError(null);
      const response = await api.get<{ success: boolean; data: DashboardData }>(
        '/practitioner/dashboard',
        {
          signal,
        }
      );
      if (!signal?.aborted && isMountedRef.current && response.data.success && response.data.data) {
        setDashboardData(response.data.data);
      }
    } catch (err: unknown) {
      // Don't set error if request was aborted or component unmounted
      if (!signal?.aborted && isMountedRef.current) {
        let errorMsg = 'Failed to load dashboard data';
        if (
          typeof err === 'object' &&
          err !== null &&
          'response' in err &&
          typeof (err as { response?: unknown }).response === 'object' &&
          (err as { response?: unknown }).response !== null
        ) {
          const response = (err as { response: { data?: { error?: unknown } } }).response;
          if (
            'data' in response &&
            typeof response.data === 'object' &&
            response.data !== null &&
            'error' in response.data &&
            typeof response.data.error === 'string'
          ) {
            errorMsg = response.data.error;
          }
        }
        setError(errorMsg);
      }
    } finally {
      if (!signal?.aborted && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    isMountedRef.current = true;
    const controller = new AbortController();
    fetchDashboardData(controller.signal);

    return () => {
      isMountedRef.current = false;
      controller.abort();
      // Abort any in-flight retry request
      if (retryControllerRef.current) {
        retryControllerRef.current.abort();
        retryControllerRef.current = null;
      }
      // Abort any in-flight cancel-booking refresh
      if (cancelBookingControllerRef.current) {
        cancelBookingControllerRef.current.abort();
        cancelBookingControllerRef.current = null;
      }
    };
  }, [user, fetchDashboardData]);

  // Fetch subscription status for ad-hoc banner (only show for ad-hoc without active subscription)
  useEffect(() => {
    if (!user) return;

    const controller = new AbortController();
    practitionerApi
      .getSubscriptionStatus(controller.signal)
      .then((res) => {
        if (res.data.success && res.data.canBook !== undefined) {
          setSubscriptionCanBook(res.data.canBook);
          setSubscriptionMembershipType(res.data.membership?.type ?? null);
        }
      })
      .catch(() => {
        setSubscriptionCanBook(null);
        setSubscriptionMembershipType(null);
      });
    return () => controller.abort();
  }, [user?.id, refreshTrigger]);

  // Fetch document status
  useEffect(() => {
    if (!user) return;

    // Extract only the needed property to avoid unnecessary re-fetches
    const marketingAddon = user.membership?.marketingAddon ?? false;

    // Reset state immediately when user changes
    setInsuranceDocument({ status: 'loading' });
    setClinicalDocument({ status: 'loading' });

    const controller = new AbortController();
    const { signal } = controller;

    const fetchDocuments = async () => {
      // Prepare fetch promises for parallel execution
      const fetchPromises: Promise<void>[] = [];

      // Always fetch insurance document
      const insurancePromise = (async () => {
        try {
          const insuranceResponse = await practitionerApi.getInsuranceDocument(signal);
          if (!signal.aborted && insuranceResponse.data.success && insuranceResponse.data.data) {
            setInsuranceDocument({ status: 'loaded', data: insuranceResponse.data.data });
          } else if (!signal.aborted) {
            setInsuranceDocument({ status: 'loaded', data: null });
          }
        } catch (error) {
          if (signal.aborted) return;

          if (axios.isAxiosError(error)) {
            // 404 is expected if no document exists
            if (error.response?.status === 404) {
              setInsuranceDocument({ status: 'loaded', data: null });
            } else {
              console.error('Failed to fetch insurance document:', {
                message: error.message,
                status: error.response?.status,
                error: error.response?.data?.error,
              });
              setInsuranceDocument({ status: 'loaded', data: null });
            }
          } else {
            // Handle non-Axios errors
            console.error('Failed to fetch insurance document:', {
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            setInsuranceDocument({ status: 'loaded', data: null });
          }
        }
      })();
      fetchPromises.push(insurancePromise);

      // Fetch clinical document only if user has marketing add-on
      if (marketingAddon) {
        const clinicalPromise = (async () => {
          try {
            const clinicalResponse = await practitionerApi.getClinicalDocument(signal);
            if (!signal.aborted && clinicalResponse.data.success && clinicalResponse.data.data) {
              setClinicalDocument({ status: 'loaded', data: clinicalResponse.data.data });
            } else if (!signal.aborted) {
              setClinicalDocument({ status: 'loaded', data: null });
            }
          } catch (error) {
            if (signal.aborted) return;

            if (axios.isAxiosError(error)) {
              // 404 is expected if no document exists
              if (error.response?.status === 404) {
                setClinicalDocument({ status: 'loaded', data: null });
              } else {
                console.error('Failed to fetch clinical document:', {
                  message: error.message,
                  status: error.response?.status,
                  error: error.response?.data?.error,
                });
                setClinicalDocument({ status: 'loaded', data: null });
              }
            } else {
              // Handle non-Axios errors
              console.error('Failed to fetch clinical document:', {
                message: error instanceof Error ? error.message : 'Unknown error',
              });
              setClinicalDocument({ status: 'loaded', data: null });
            }
          }
        })();
        fetchPromises.push(clinicalPromise);
      } else if (!signal.aborted) {
        // If user doesn't have marketing add-on, mark clinical document as loaded with null
        setClinicalDocument({ status: 'loaded', data: null });
      }

      // Wait for all fetches to complete (or settle) in parallel
      await Promise.allSettled(fetchPromises);
    };

    fetchDocuments();

    return () => {
      controller.abort();
    };
  }, [user?.id, user?.membership?.marketingAddon, refreshTrigger]);

  // Auto-refresh data when tab becomes visible
  const isRefreshingRef = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && user && !isRefreshingRef.current) {
        isRefreshingRef.current = true;
        try {
          // Refresh user data (to catch membership/addon changes)
          await refreshUser();
          // Trigger document refetch
          setRefreshTrigger((prev) => prev + 1);
          // Note: fetchDashboardData will be triggered by user state change in effect at line 126
        } finally {
          isRefreshingRef.current = false;
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, refreshUser]);

  // Initial refresh on mount to ensure fresh data (e.g. navigation from Profile)
  const hasInitialRefreshed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (user && !hasInitialRefreshed.current) {
      hasInitialRefreshed.current = true;
      refreshUser()
        .then(() => {
          if (!cancelled) {
            setRefreshTrigger((prev) => prev + 1);
          }
        })
        .catch((error) => {
          console.error('Failed to refresh user on mount:', error);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [user, refreshUser]);

  const formatMonthYear = (monthYear: string): string => {
    // Validate input: non-empty string matching YYYY-MM or YYYY-MM-DD format
    if (
      !monthYear ||
      typeof monthYear !== 'string' ||
      !/^\d{4}-\d{2}(?:-\d{2})?$/.test(monthYear)
    ) {
      return '';
    }

    // Extract only year and month parts (first 7 characters: YYYY-MM)
    const yearMonthStr = monthYear.substring(0, 7);
    const [yearStr, monthStr] = yearMonthStr.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    // Verify parsed numbers are finite
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      return '';
    }

    // Validate date is valid (not NaN)
    const date = new Date(year, month - 1, 1);
    if (isNaN(date.getTime())) {
      return '';
    }

    return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  const formatExpiryDate = (dateStr: string | null): string => {
    if (!dateStr) return '';

    try {
      const date = new Date(dateStr);
      // Check if date is valid
      if (isNaN(date.getTime())) {
        return '';
      }
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  };

  const formatTime = (timeStr: string): string => {
    // Guard against falsy or non-string inputs
    if (!timeStr || typeof timeStr !== 'string') {
      return '';
    }

    // Split and trim the input
    const parts = timeStr.split(':').map((part) => part.trim());

    // Ensure we have at least hours, default minutes to "00" if missing
    if (parts.length === 0) {
      return '';
    }

    const hoursStr = parts[0] || '';
    const minutesStr = parts[1] || '00';

    // Validate parseInt results
    const hour = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);

    if (isNaN(hour) || isNaN(minutes)) {
      return '';
    }

    // Validate ranges: hour must be 0-23, minutes must be 0-59
    if (hour < 0 || hour > 23 || minutes < 0 || minutes > 59) {
      return '';
    }

    // Compute AM/PM and displayHour using validated numeric values
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  const formatBookingDate = (dateStr: string): string => {
    const date = new Date(dateStr);

    // Validate date is valid
    if (isNaN(date.getTime())) {
      return '';
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bookingDate = new Date(date);
    bookingDate.setHours(0, 0, 0, 0);

    if (bookingDate.getTime() === today.getTime()) {
      return 'Today';
    }
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (bookingDate.getTime() === tomorrow.getTime()) {
      return 'Tomorrow';
    }
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const formatDocumentExpiryDate = (expiryDate: string): string => {
    const date = new Date(expiryDate);
    if (isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const getDocumentBadgeVariant = (
    documentState: DocumentState
  ): 'success' | 'destructive' | 'warning' => {
    if (documentState.status === 'loading') return 'warning';
    if (!documentState.data) return 'destructive';
    if (documentState.data.isExpired ?? false) return 'destructive';
    if (documentState.data.isExpiringSoon ?? false) return 'warning';
    return 'success';
  };

  const getDocumentBadgeText = (documentState: DocumentState): string => {
    if (documentState.status === 'loading') return 'Loading...';
    if (!documentState.data) return 'Not uploaded';
    if (documentState.data.isExpired ?? false) return 'Expired';
    if (documentState.data.isExpiringSoon ?? false) {
      const daysUntilExpiry = documentState.data.daysUntilExpiry;
      if (typeof daysUntilExpiry === 'number' && daysUntilExpiry >= 0) {
        return `Expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`;
      }
      return 'Expiring soon';
    }
    return `Valid until ${formatDocumentExpiryDate(documentState.data.expiryDate)}`;
  };

  const getDocumentIcon = (documentState: DocumentState): string => {
    if (documentState.status === 'loading') return 'hourglass_empty';
    if (!documentState.data) return 'error';
    if (documentState.data.isExpired) return 'error';
    if (documentState.data.isExpiringSoon) return 'warning';
    return 'verified';
  };

  const getDocumentIconColor = (documentState: DocumentState): string => {
    if (documentState.status === 'loading') return 'text-slate-500';
    if (!documentState.data) return 'text-red-500';
    if (documentState.data.isExpired) return 'text-red-500';
    if (documentState.data.isExpiringSoon) return 'text-orange-500';
    return 'text-green-500';
  };

  const handleCancelBooking = async (bookingId: string) => {
    if (!window.confirm('Are you sure you want to cancel this booking?')) return;
    setCancellingId(bookingId);
    setCancelError(null);
    cancelBookingControllerRef.current = new AbortController();
    try {
      await practitionerApi.cancelBooking(bookingId);
      await fetchDashboardData(cancelBookingControllerRef.current.signal);
    } catch (err) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : null;
      setCancelError(msg ?? 'Cancellation failed. Please try again.');
    } finally {
      setCancellingId(null);
      cancelBookingControllerRef.current?.abort();
      cancelBookingControllerRef.current = null;
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-slate-500 dark:text-slate-400">Loading dashboard...</p>
        </div>
      </MainLayout>
    );
  }

  const handleRetry = () => {
    // Abort any previous retry request
    if (retryControllerRef.current) {
      retryControllerRef.current.abort();
    }
    // Create a new AbortController for this retry
    const controller = new AbortController();
    retryControllerRef.current = controller;
    fetchDashboardData(controller.signal);
  };

  if (error) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <p className="text-red-500">{error}</p>
          <Button onClick={handleRetry} disabled={loading} variant="outline">
            {loading ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-8">
        {/* Page Heading */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-slate-900 dark:text-white text-3xl md:text-4xl font-black leading-tight tracking-tight">
              Welcome back, {user?.firstName}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-base font-normal">
              Here is your overview for{' '}
              <span className="text-slate-800 dark:text-slate-200 font-medium">{currentDate}</span>.
            </p>
          </div>
          <Button onClick={() => navigate('/bookings')}>
            <Icon name="add" size={20} className="mr-2" />
            Book a Room
          </Button>
        </div>

        {/* Ad-hoc without active subscription: prompt to complete subscription */}
        {subscriptionMembershipType === 'ad_hoc' && subscriptionCanBook === false && (
          <div
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-xl bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30"
            role="status"
          >
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Complete your subscription to make bookings.
            </p>
            <Button onClick={() => navigate('/subscription')} size="sm">
              Go to Subscription
            </Button>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Credit Balance */}
          <Card className="relative overflow-hidden group min-h-40">
            <div className="absolute right-0 top-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
              <Icon name="account_balance_wallet" className="text-6xl text-primary" />
            </div>
            <CardContent className="p-6 flex flex-col justify-between h-full relative z-10">
              <p className="text-slate-500 dark:text-slate-400 font-medium">Credit Balance</p>
              {dashboardData?.credit.membershipType === 'permanent' ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm text-slate-500 dark:text-slate-400">Permanent membership</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs text-primary self-start"
                    onClick={() => navigate('/finance')}
                  >
                    View Transaction History
                  </Button>
                </div>
              ) : dashboardData?.credit.byMonth && dashboardData.credit.byMonth.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {dashboardData.credit.byMonth.map((month: { month: string; remainingCredit: number }) => {
                    const monthLabel = formatMonthYear(month.month);
                    return (
                      <div key={month.month} className="flex items-center justify-between">
                        <span className="text-slate-900 dark:text-white text-lg font-bold">
                          {monthLabel}
                        </span>
                        <span className="text-slate-900 dark:text-white text-lg font-bold">
                          £{month.remainingCredit.toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs text-primary self-start"
                    onClick={() => navigate('/finance')}
                  >
                    View Transaction History
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-900 dark:text-white text-lg font-bold">
                      {dashboardData?.credit.currentMonth?.monthYear 
                        ? formatMonthYear(dashboardData.credit.currentMonth.monthYear)
                        : formatMonthYear(new Date().toISOString().slice(0, 7) + '-01')}
                    </span>
                    <span className="text-slate-900 dark:text-white text-lg font-bold">
                      £{dashboardData?.credit.currentMonth?.remainingCredit != null 
                        ? dashboardData.credit.currentMonth.remainingCredit.toFixed(2) 
                        : '0.00'}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs text-primary self-start"
                    onClick={() => navigate('/finance')}
                  >
                    View Transaction History
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Free Booking Hours */}
          <Card className="relative overflow-hidden group h-40">
            <div className="absolute right-0 top-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
              <Icon name="timer" className="text-6xl text-orange-500" />
            </div>
            <CardContent className="p-6 flex flex-col justify-between h-full relative z-10">
              <p className="text-slate-500 dark:text-slate-400 font-medium">Free Booking Hours</p>
              <div className="flex items-baseline gap-1">
                <span className="text-slate-900 dark:text-white text-4xl font-black tracking-tight">
                  {dashboardData?.freeBookingHours.remaining.toFixed(1) || '0.0'}
                </span>
                <span className="text-slate-500 font-bold">Hours</span>
              </div>
              {dashboardData?.freeBookingHours.latestExpiry ? (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-medium">
                  Expires: {formatExpiryDate(dashboardData.freeBookingHours.latestExpiry)}
                </p>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-medium">
                  No active vouchers
                </p>
              )}
            </CardContent>
          </Card>

          {/* Kiosk Status */}
          <Card className="col-span-1 md:col-span-2 lg:col-span-1">
            <CardContent className="p-5 flex flex-row items-center gap-4">
              <div className="relative">
                <Avatar className="h-28 w-28 border-2 border-green-500">
                  <AvatarImage src="" alt="Kiosk check-in photo" />
                  <AvatarFallback className="bg-primary/10 text-primary text-2xl font-bold">
                    {getInitials(user?.firstName, user?.lastName)}
                  </AvatarFallback>
                </Avatar>
                <div className="absolute -bottom-2 -right-2 bg-green-500 text-white p-1 rounded-full border-2 border-white dark:border-surface-dark">
                  <Icon name="check" size={16} />
                </div>
              </div>
              <div className="flex flex-col flex-1 gap-1">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-slate-900 dark:text-white font-bold text-lg">Signed In</p>
                    <p className="text-slate-500 dark:text-slate-400 text-sm">Pimlico Tablet</p>
                    <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">
                      Check-in: 09:00 AM
                    </p>
                  </div>
                </div>
                <Button variant="destructive" size="sm" className="mt-2 w-full">
                  <Icon name="logout" size={18} className="mr-2" />
                  Sign Out
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Columns */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Left Column (Data Tables) */}
          <div className="xl:col-span-2 flex flex-col gap-6">
            {/* Upcoming Bookings */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 dark:border-slate-800">
                <CardTitle className="flex items-center gap-2">
                  <Icon name="event_available" className="text-primary" />
                  Upcoming Bookings
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-sm font-bold text-primary"
                  onClick={() => navigate('/bookings#my-bookings')}
                >
                  View All
                </Button>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                {cancelError && (
                  <p className="px-6 py-2 text-sm text-red-600 dark:text-red-400" role="alert">
                    {cancelError}
                  </p>
                )}
                <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Room</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead className="text-right">Cancel</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dashboardData?.upcomingBookings &&
                    dashboardData.upcomingBookings.length > 0 ? (
                      dashboardData.upcomingBookings.map((booking) => {
                        const isCancelable = canCancelBooking(
                          booking.bookingDate,
                          booking.startTime
                        );
                        return (
                          <TableRow key={booking.id}>
                            <TableCell className="font-medium">
                              {booking.roomName} ({booking.locationName})
                            </TableCell>
                            <TableCell>{formatBookingDate(booking.bookingDate)}</TableCell>
                            <TableCell>{formatTime(booking.startTime)}</TableCell>
                            <TableCell>{formatTime(booking.endTime)}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCancelBooking(booking.id)}
                                disabled={cancellingId === booking.id || !isCancelable}
                                title={
                                  !isCancelable
                                    ? 'Cancellation with less than 24 hours notice is not permitted'
                                    : undefined
                                }
                              >
                                {cancellingId === booking.id ? (
                                  'Cancelling…'
                                ) : (
                                  <Icon name="cancel" size={18} />
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-slate-500 dark:text-slate-400 py-8"
                        >
                          No upcoming bookings
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

          </div>

          {/* Right Column (Documents Widget) */}
          <div className="xl:col-span-1">
            <Card>
              <CardHeader className="border-b border-slate-100 dark:border-slate-800">
                <CardTitle className="flex items-center gap-2">
                  <Icon name="description" className="text-primary" />
                  Documents
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {/* Insurance Document */}
                  <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Icon
                        name={getDocumentIcon(insuranceDocument)}
                        className={getDocumentIconColor(insuranceDocument)}
                      />
                      <span className="text-sm font-medium text-slate-900 dark:text-white">
                        Insurance
                      </span>
                    </div>
                    <Badge
                      variant={getDocumentBadgeVariant(insuranceDocument)}
                      className="text-center"
                    >
                      {getDocumentBadgeText(insuranceDocument)}
                    </Badge>
                  </div>

                  {/* Clinical Registration Document (only if marketing add-on) */}
                  {user?.membership?.marketingAddon && (
                    <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <div className="flex items-center gap-3">
                        <Icon
                          name={getDocumentIcon(clinicalDocument)}
                          className={getDocumentIconColor(clinicalDocument)}
                        />
                        <span className="text-sm font-medium text-slate-900 dark:text-white">
                          Registration
                        </span>
                      </div>
                      <Badge
                        variant={getDocumentBadgeVariant(clinicalDocument)}
                        className="text-center"
                      >
                        {getDocumentBadgeText(clinicalDocument)}
                      </Badge>
                    </div>
                  )}

                  <Button variant="outline" className="w-full" onClick={() => navigate('/profile')}>
                    <Icon name="upload" size={18} className="mr-2" />
                    Upload Documents
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </MainLayout>
  );
};
