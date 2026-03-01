import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { AccessDenied } from '@/components/AccessDenied';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/ui/Icon';
import { adminApi } from '@/services/api';

type LocationFilter = 'Pimlico' | 'Kensington';
type SortBy = 'name' | 'time';
type SortOrder = 'asc' | 'desc';

interface KioskLogRow {
  id: string;
  name: string;
  time: string;
  status: 'In' | 'Out';
}

export const AdminKioskLogs: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<LocationFilter>('Kensington');
  const [logs, setLogs] = useState<KioskLogRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('time');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const fetchLogs = async (loc: LocationFilter, pageNumber: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getKioskLogs({
        location: loc,
        page: pageNumber,
        pageSize: 50,
        search: search || undefined,
        sortBy,
        sortOrder,
      });
      if (res.data.success && res.data.data) {
        setLogs(res.data.data.data);
        setPage(res.data.data.pagination.page);
        setTotalPages(res.data.data.pagination.totalPages);
      }
    } catch (err) {
      console.error('Failed to fetch kiosk logs', err);
      setError('Failed to load kiosk logs. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'admin') {
      fetchLogs(activeTab, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role, activeTab, sortBy, sortOrder]);

  const handleSort = (column: SortBy) => {
    if (sortBy === column) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortOrder(column === 'time' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  const refetchWithPage = (pageNumber: number) => {
    fetchLogs(activeTab, pageNumber);
  };

  if (user?.role !== 'admin') {
    return <AccessDenied />;
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Kiosk In/Out Logs</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            View sign-in and sign-out history for Pimlico and Kensington.
          </p>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant={activeTab === 'Kensington' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setActiveTab('Kensington');
                  fetchLogs('Kensington', 1);
                }}
              >
                Kensington In/Out
              </Button>
              <Button
                variant={activeTab === 'Pimlico' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setActiveTab('Pimlico');
                  fetchLogs('Pimlico', 1);
                }}
              >
                Pimlico In/Out
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search by name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchLogs(activeTab, 1)}
                disabled={loading}
              >
                Search
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-3 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => handleSort('name')}
                        className="flex items-center gap-1 font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                      >
                        Name
                        {sortBy === 'name' && (
                          <Icon
                            name={sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                            size={14}
                          />
                        )}
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => handleSort('time')}
                        className="flex items-center gap-1 font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-primary rounded"
                      >
                        Time
                        {sortBy === 'time' && (
                          <Icon
                            name={sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                            size={14}
                          />
                        )}
                      </button>
                    </TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-slate-500">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : logs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-slate-500">
                        No logs found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{log.name}</TableCell>
                        <TableCell>
                          {new Date(log.time).toLocaleString('en-GB', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </TableCell>
                        <TableCell>{log.status}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-end gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchWithPage(Math.max(1, page - 1))}
                  disabled={page === 1 || loading}
                >
                  Previous
                </Button>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchWithPage(Math.min(totalPages, page + 1))}
                  disabled={page === totalPages || loading}
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
