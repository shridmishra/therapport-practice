import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { AccessDenied } from '@/components/AccessDenied';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Icon } from '@/components/ui/Icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { adminApi } from '@/services/api';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import axios from 'axios';
import { AdminOccupancySection } from './AdminOccupancySection';

function getDefaultDateRange(): { fromDate: string; toDate: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const from = new Date(y, m, 1);
  const to = new Date(y, m + 1, 0);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const formatLocal = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    fromDate: formatLocal(from),
    toDate: formatLocal(to),
  };
}

export const AdminDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [practitionerCount, setPractitionerCount] = useState<number | null>(null);
  const [adHocCount, setAdHocCount] = useState<number | null>(null);
  const [permanentCount, setPermanentCount] = useState<number | null>(null);
  const [occupancy, setOccupancy] = useState<{
    fromDate: string;
    toDate: string;
    totalSlotHours: number;
    bookedHours: number;
    occupancyPercent: number;
  } | null>(null);
  const [revenueCurrentMonthGbp, setRevenueCurrentMonthGbp] = useState<number | null>(null);
  const [occupancyFromDate, setOccupancyFromDate] = useState(() => getDefaultDateRange().fromDate);
  const [occupancyToDate, setOccupancyToDate] = useState(() => getDefaultDateRange().toDate);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [missingInfo, setMissingInfo] = useState<
    Array<{ id: string; name: string; missing: string[] }>
  >([]);
  const [missingInfoLoading, setMissingInfoLoading] = useState(true);
  const [missingInfoError, setMissingInfoError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [pimlicoCurrent, setPimlicoCurrent] = useState<
    Array<{ userId: string; firstName: string; lastName: string; photoUrl?: string }>
  >([]);
  const [kensingtonCurrent, setKensingtonCurrent] = useState<
    Array<{ userId: string; firstName: string; lastName: string; photoUrl?: string; isDummy: boolean }>
  >([]);
  const [kioskLoading, setKioskLoading] = useState(false);
  const [kioskError, setKioskError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setStatsError(null);
    try {
      const response = await adminApi.getAdminStats({
        fromDate: occupancyFromDate,
        toDate: occupancyToDate,
      });
      if (response.data.success && response.data.data) {
        const { data } = response.data;
        setPractitionerCount(data.practitionerCount);
        setAdHocCount(data.adHocCount);
        setPermanentCount(data.permanentCount);
        setOccupancy(data.occupancy ?? null);
        setRevenueCurrentMonthGbp(data.revenueCurrentMonthGbp ?? null);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Failed to fetch practitioner count:', {
          message: error.message,
          status: error.response?.status,
          error: error.response?.data?.error,
        });
      } else {
        console.error('Failed to fetch practitioner count:', {
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      setStatsError('Failed to load statistics. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [occupancyFromDate, occupancyToDate]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchKioskCurrent = useCallback(async () => {
    setKioskLoading(true);
    setKioskError(null);
    try {
      const response = await adminApi.getKioskCurrent();
      if (response.data.success && response.data.data) {
        const { pimlico, kensington } = response.data.data;
        setPimlicoCurrent(
          pimlico.map((p) => ({
            userId: p.userId,
            firstName: p.firstName,
            lastName: p.lastName,
            photoUrl: p.photoUrl,
          }))
        );
        setKensingtonCurrent(
          kensington.map((p) => ({
            userId: p.userId,
            firstName: p.firstName,
            lastName: p.lastName,
            photoUrl: p.photoUrl,
            isDummy: p.isDummy,
          }))
        );
      }
    } catch (error) {
      console.error('Failed to fetch kiosk current state', error);
      setKioskError('Failed to load kiosk presence. Please try again.');
    } finally {
      setKioskLoading(false);
    }
  }, []);

  const fetchMissingInfo = useCallback(async () => {
    // Cancel previous request if exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setMissingInfoLoading(true);
    setMissingInfoError(null);

    try {
      const response = await adminApi.getPractitionersWithMissingInfo(page, 10, controller.signal);
      if (response.data.success && response.data.data) {
        const { data, pagination } = response.data.data;
        setMissingInfo(data);
        setTotalPages(pagination.totalPages);
      }
    } catch (error) {
      if (axios.isCancel(error)) {
        return;
      }
      console.error('Failed to fetch missing info:', error);
      setMissingInfoError('Failed to load missing information list.');
    } finally {
      if (abortControllerRef.current === controller) {
        // Only stop loading if this is the latest request
        setMissingInfoLoading(false);
      }
    }
  }, [page]);

  useEffect(() => {
    if (user?.role === 'admin') {
      fetchStats();
      fetchKioskCurrent();
    }
  }, [user?.role, fetchStats, fetchKioskCurrent]);

  // Effect for missing info
  useEffect(() => {
    if (user?.role === 'admin') {
      fetchMissingInfo();
    }
    return () => {
      // Cleanup on unmount or dependency change
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [user?.role, fetchMissingInfo]);

  if (user?.role !== 'admin') {
    return <AccessDenied />;
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Admin Dashboard</h1>
          <p className="text-slate-500 dark:text-slate-400">Manage members and memberships</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Members</CardTitle>
              <Icon name="people" className="h-4 w-4 text-slate-500" />
            </CardHeader>
            <CardContent>
              {statsError ? (
                <div className="space-y-2">
                  <div className="text-sm text-red-600 dark:text-red-400">{statsError}</div>
                  <Button variant="outline" size="sm" onClick={fetchStats}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="text-2xl font-bold">{loading ? '...' : practitionerCount ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Ad-Hoc</CardTitle>
              <Icon name="trending_up" className="h-4 w-4 text-slate-500" />
            </CardHeader>
            <CardContent>
              {statsError ? (
                <div className="text-2xl font-bold text-slate-400">—</div>
              ) : (
                <div className="text-2xl font-bold">{loading ? '...' : adHocCount ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Permanent</CardTitle>
              <Icon name="shield" className="h-4 w-4 text-slate-500" />
            </CardHeader>
            <CardContent>
              {statsError ? (
                <div className="text-2xl font-bold text-slate-400">—</div>
              ) : (
                <div className="text-2xl font-bold">{loading ? '...' : permanentCount ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Revenue (this month)</CardTitle>
              <Icon name="payments" className="h-4 w-4 text-slate-500" />
            </CardHeader>
            <CardContent>
              {statsError ? (
                <div className="text-2xl font-bold text-slate-400">—</div>
              ) : (
                <div className="text-2xl font-bold">
                  {loading
                    ? '...'
                    : revenueCurrentMonthGbp != null
                    ? `£${revenueCurrentMonthGbp.toFixed(2)}`
                    : '—'}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Occupancy</CardTitle>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Booked vs total slot hours (08:00–22:00) in selected range
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="occupancy-from">From</Label>
                  <Input
                    id="occupancy-from"
                    type="date"
                    max={occupancyToDate}
                    value={occupancyFromDate}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOccupancyFromDate(v > occupancyToDate ? occupancyToDate : v);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="occupancy-to">To</Label>
                  <Input
                    id="occupancy-to"
                    type="date"
                    min={occupancyFromDate}
                    value={occupancyToDate}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOccupancyToDate(v < occupancyFromDate ? occupancyFromDate : v);
                    }}
                  />
                </div>
              </div>
              {statsError ? (
                <div className="text-slate-400">—</div>
              ) : loading ? (
                <div className="text-2xl font-bold">...</div>
              ) : occupancy ? (
                <div>
                  <div className="text-2xl font-bold">{occupancy.occupancyPercent.toFixed(1)}%</div>
                  <div className="text-xs text-slate-500">
                    {occupancy.bookedHours.toFixed(1)}h booked / {occupancy.totalSlotHours}h
                    capacity
                  </div>
                </div>
              ) : (
                <div className="text-slate-400">—</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
              <Icon name="settings" className="h-4 w-4 text-slate-500" />
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => navigate('/admin/practitioners')}
              >
                <Icon name="people" size={18} className="mr-2" />
                Manage Members
              </Button>
            </CardContent>
          </Card>
        </div>

        <AdminOccupancySection />

        {/* Who is in now – Pimlico & Kensington */}
        <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span>Who is in now</span>
                <Button variant="outline" size="sm" onClick={fetchKioskCurrent} disabled={kioskLoading}>
                  <Icon name="refresh" className="h-4 w-4 mr-2" />
                  Refresh
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {kioskError ? (
                <div className="text-sm text-red-600 dark:text-red-400">{kioskError}</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Pimlico box */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      <a
                        href={`${typeof window !== 'undefined' ? window.location.origin : ''}/kiosk/pimlico`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Pimlico
                      </a>
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {kioskLoading ? (
                        <Skeleton className="h-14 w-full" />
                      ) : pimlicoCurrent.length === 0 ? (
                        <p className="text-xs text-slate-500">No one currently signed in.</p>
                      ) : (
                        pimlicoCurrent.map((p) => (
                          <div
                            key={p.userId}
                            className="flex items-center gap-2 px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-xs"
                          >
                            <Avatar className="h-6 w-6 rounded-full">
                              <AvatarImage src={p.photoUrl} alt="" />
                              <AvatarFallback className="rounded-full bg-slate-200 dark:bg-slate-700 text-[11px] font-semibold">
                                {(p.firstName.charAt(0) + p.lastName.charAt(0)).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <span>{p.firstName} {p.lastName}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <a
                      href={`${typeof window !== 'undefined' ? window.location.origin : ''}/kiosk/pimlico`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline mt-1 inline-block"
                    >
                      Open kiosk
                    </a>
                  </div>

                  {/* Kensington box */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      <a
                        href={`${typeof window !== 'undefined' ? window.location.origin : ''}/kiosk/kensington`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Kensington
                      </a>
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {kioskLoading ? (
                        <Skeleton className="h-14 w-full" />
                      ) : kensingtonCurrent.length === 0 ? (
                        <p className="text-xs text-slate-500">No one currently signed in.</p>
                      ) : (
                        kensingtonCurrent.map((p) => (
                          <div
                            key={p.userId}
                            className="flex items-center gap-2 px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-xs"
                            title={p.isDummy ? 'Dummy always-in user' : undefined}
                          >
                            <Avatar className="h-6 w-6 rounded-full">
                              <AvatarImage src={p.photoUrl} alt="" />
                              <AvatarFallback className="rounded-full bg-slate-200 dark:bg-slate-700 text-[11px] font-semibold">
                                {(p.firstName.charAt(0) + p.lastName.charAt(0)).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <span>
                              {p.firstName} {p.lastName}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                    <a
                      href={`${typeof window !== 'undefined' ? window.location.origin : ''}/kiosk/kensington`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline mt-1 inline-block"
                    >
                      Open kiosk
                    </a>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        {/* Missing Information Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-bold flex items-center gap-2">
              <Icon name="warning" className="text-orange-500" />
              Missing Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Missing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {missingInfoLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-4 w-[150px]" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-[200px]" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : missingInfoError ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center py-8">
                      <div className="text-red-500 mb-2">{missingInfoError}</div>
                      <Button variant="outline" size="sm" onClick={() => fetchMissingInfo()}>
                        Retry
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : missingInfo.length > 0 ? (
                  missingInfo.map((practitioner) => (
                    <TableRow key={practitioner.id}>
                      <TableCell className="font-medium">{practitioner.name}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {practitioner.missing.map((item, index) => (
                            <span
                              key={index}
                              className={`text-sm ${
                                item.includes('Missing') || item.includes('Incomplete')
                                  ? 'text-red-500 font-medium'
                                  : item.includes('Expired')
                                  ? 'text-orange-500 font-medium'
                                  : 'text-red-500 font-medium' // Default to missing style
                              }`}
                            >
                              • {item}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center py-8 text-slate-500">
                      No practitioners with missing information found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-end space-x-2 py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1 || missingInfoLoading}
                >
                  Previous
                </Button>
                <div className="text-sm font-medium">
                  Page {page} of {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages || missingInfoLoading}
                >
                  Next
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};
