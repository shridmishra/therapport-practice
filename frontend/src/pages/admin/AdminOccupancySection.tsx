import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select } from '@/components/ui/select-native';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/services/api';
import axios from 'axios';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const RANGE_OPTIONS = [
  { value: 'last_month', label: 'Last month' },
  { value: 'last_3_months', label: 'Last 3 months' },
  { value: 'fy_to_date', label: 'This year (since 1 June)' },
  { value: 'two_fy_window', label: 'Last two years (since 1 Jun −1 year)' },
  { value: 'all_time', label: 'All time' },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

function heatmapCellColor(percent: number): string {
  const t = Math.min(100, Math.max(0, percent)) / 100;
  const h = 55 + t * 145;
  const s = 90 - t * 50;
  const l = 90 - t * 55;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function formatPresetLabel(preset: string): string {
  return RANGE_OPTIONS.find((o) => o.value === preset)?.label ?? preset;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isAbortError(e: unknown): boolean {
  if (axios.isCancel(e)) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code === 'ERR_CANCELED'
  );
}

function validateFyMonthsPayload(d: unknown): string | null {
  if (!isRecord(d)) return 'Invalid response';
  if (typeof d.fyStartYear !== 'number' || typeof d.fyLabel !== 'string') return 'Invalid response';
  if (!Array.isArray(d.months)) return 'Invalid response';
  for (const m of d.months) {
    if (!isRecord(m)) return 'Invalid response';
    if (typeof m.monthKey !== 'string' || typeof m.monthLabel !== 'string') return 'Invalid response';
    if (
      typeof m.kensingtonPercent !== 'number' ||
      typeof m.pimlicoPercent !== 'number' ||
      typeof m.combinedPercent !== 'number'
    ) {
      return 'Invalid response';
    }
  }
  return null;
}

function validateAnnualPayload(d: unknown): string | null {
  if (!isRecord(d)) return 'Invalid response';
  if (!Array.isArray(d.rows)) return 'Invalid response';
  for (const r of d.rows) {
    if (!isRecord(r)) return 'Invalid response';
    if (typeof r.fyLabel !== 'string') return 'Invalid response';
    if (
      typeof r.kensingtonPercent !== 'number' ||
      typeof r.pimlicoPercent !== 'number' ||
      typeof r.combinedPercent !== 'number'
    ) {
      return 'Invalid response';
    }
  }
  return null;
}

function validateTimeSeriesPayload(d: unknown): string | null {
  if (!isRecord(d)) return 'Invalid response';
  if (!isRecord(d.range)) return 'Invalid response';
  if (typeof d.range.from !== 'string' || typeof d.range.to !== 'string') return 'Invalid response';
  if (!Array.isArray(d.points)) return 'Invalid response';
  for (const p of d.points) {
    if (!isRecord(p)) return 'Invalid response';
    if (typeof p.periodLabel !== 'string') return 'Invalid response';
    if (
      typeof p.kensingtonPercent !== 'number' ||
      typeof p.pimlicoPercent !== 'number' ||
      typeof p.combinedPercent !== 'number'
    ) {
      return 'Invalid response';
    }
  }
  return null;
}

function validateHeatmapPayload(d: unknown): string | null {
  if (!isRecord(d)) return 'Invalid response';
  if (!isRecord(d.range)) return 'Invalid response';
  if (typeof d.range.from !== 'string' || typeof d.range.to !== 'string' || typeof d.range.preset !== 'string') {
    return 'Invalid response';
  }
  if (!Array.isArray(d.hours) || !d.hours.every((h) => typeof h === 'number')) return 'Invalid response';
  if (!Array.isArray(d.hourLabels) || !d.hourLabels.every((h) => typeof h === 'string')) {
    return 'Invalid response';
  }
  if (!Array.isArray(d.columns)) return 'Invalid response';
  for (const c of d.columns) {
    if (!isRecord(c)) return 'Invalid response';
    if (typeof c.roomId !== 'string' || typeof c.roomName !== 'string') return 'Invalid response';
    if (typeof c.locationName !== 'string' || typeof c.displayLabel !== 'string') return 'Invalid response';
  }
  if (!Array.isArray(d.cells)) return 'Invalid response';
  for (const c of d.cells) {
    if (!isRecord(c)) return 'Invalid response';
    if (typeof c.roomId !== 'string' || typeof c.hour !== 'number') return 'Invalid response';
    if (
      typeof c.occupancyPercent !== 'number' ||
      typeof c.bookedHours !== 'number' ||
      typeof c.capacityHours !== 'number'
    ) {
      return 'Invalid response';
    }
  }
  return null;
}

function chartTooltipFormat(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value.toFixed(1)}%`;
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    const n = typeof first === 'number' ? first : Number(first);
    if (Number.isFinite(n)) return `${n.toFixed(1)}%`;
  }
  const num = Number(value);
  if (Number.isFinite(num)) return `${num.toFixed(1)}%`;
  if (value === undefined || value === null) return '—';
  return String(value);
}

type HeatmapCellData = {
  roomId: string;
  hour: number;
  occupancyPercent: number;
  bookedHours: number;
  capacityHours: number;
};

export const AdminOccupancySection: React.FC = () => {
  const [fyYearInput, setFyYearInput] = useState('');
  const [fyMonthsLoading, setFyMonthsLoading] = useState(true);
  const [fyMonthsError, setFyMonthsError] = useState<string | null>(null);
  const [fyMonthsData, setFyMonthsData] = useState<{
    fyStartYear: number;
    fyLabel: string;
    months: Array<{
      monthKey: string;
      monthLabel: string;
      kensingtonPercent: number;
      pimlicoPercent: number;
      combinedPercent: number;
    }>;
  } | null>(null);

  const [annualLoading, setAnnualLoading] = useState(true);
  const [annualError, setAnnualError] = useState<string | null>(null);
  const [annualRows, setAnnualRows] = useState<
    Array<{
      fyLabel: string;
      kensingtonPercent: number;
      pimlicoPercent: number;
      combinedPercent: number;
    }>
  >([]);

  const [chartRange, setChartRange] = useState<RangeValue>('last_3_months');
  const [chartScale, setChartScale] = useState<'monthly' | 'annual'>('monthly');
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartPoints, setChartPoints] = useState<
    Array<{
      periodLabel: string;
      kensingtonPercent: number;
      pimlicoPercent: number;
      combinedPercent: number;
    }>
  >([]);
  const [chartMeta, setChartMeta] = useState<{ from: string; to: string } | null>(null);

  const [heatmapRange, setHeatmapRange] = useState<RangeValue>('last_3_months');
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [heatmapData, setHeatmapData] = useState<{
    range: { from: string; to: string; preset: string };
    hours: number[];
    hourLabels: string[];
    columns: Array<{
      roomId: string;
      roomName: string;
      displayLabel: string;
      locationName: string;
    }>;
    cells: HeatmapCellData[];
  } | null>(null);

  const fetchFyMonths = useCallback(async (fyStartYear?: number, signal?: AbortSignal) => {
    setFyMonthsLoading(true);
    setFyMonthsError(null);
    try {
      const res = await adminApi.getOccupancyFyMonths(
        fyStartYear !== undefined ? { fyStartYear } : undefined,
        signal
      );
      if (signal?.aborted) return;
      if (res.data.success && res.data.data) {
        const invalid = validateFyMonthsPayload(res.data.data);
        if (invalid) {
          setFyMonthsError('Invalid response from server.');
          return;
        }
        setFyMonthsData(res.data.data);
        setFyYearInput(String(res.data.data.fyStartYear));
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      setFyMonthsError('Failed to load fiscal year months.');
    } finally {
      if (!signal?.aborted) setFyMonthsLoading(false);
    }
  }, []);

  const fetchAnnual = useCallback(async (signal?: AbortSignal) => {
    setAnnualLoading(true);
    setAnnualError(null);
    try {
      const res = await adminApi.getOccupancyAnnual(signal);
      if (signal?.aborted) return;
      if (res.data.success && res.data.data) {
        const invalid = validateAnnualPayload(res.data.data);
        if (invalid) {
          setAnnualError('Invalid response from server.');
          return;
        }
        setAnnualRows(res.data.data.rows);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      setAnnualError('Failed to load annual occupancy.');
    } finally {
      if (!signal?.aborted) setAnnualLoading(false);
    }
  }, []);

  const fetchChart = useCallback(async (signal?: AbortSignal) => {
    setChartLoading(true);
    setChartError(null);
    try {
      const res = await adminApi.getOccupancyTimeSeries(
        {
          range: chartRange,
          scale: chartScale,
        },
        signal
      );
      if (signal?.aborted) return;
      if (res.data.success && res.data.data) {
        const invalid = validateTimeSeriesPayload(res.data.data);
        if (invalid) {
          setChartError('Invalid response from server.');
          return;
        }
        setChartPoints(res.data.data.points);
        setChartMeta({
          from: res.data.data.range.from,
          to: res.data.data.range.to,
        });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      setChartError('Failed to load occupancy chart.');
    } finally {
      if (!signal?.aborted) setChartLoading(false);
    }
  }, [chartRange, chartScale]);

  const fetchHeatmap = useCallback(async (signal?: AbortSignal) => {
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const res = await adminApi.getOccupancyHeatmap({ range: heatmapRange }, signal);
      if (signal?.aborted) return;
      if (res.data.success && res.data.data) {
        const invalid = validateHeatmapPayload(res.data.data);
        if (invalid) {
          setHeatmapError('Invalid response from server.');
          return;
        }
        setHeatmapData(res.data.data);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      setHeatmapError('Failed to load heatmap.');
    } finally {
      if (!signal?.aborted) setHeatmapLoading(false);
    }
  }, [heatmapRange]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchFyMonths(undefined, controller.signal);
    void fetchAnnual(controller.signal);
    return () => controller.abort();
  }, [fetchFyMonths, fetchAnnual]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchChart(controller.signal);
    return () => controller.abort();
  }, [fetchChart]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchHeatmap(controller.signal);
    return () => controller.abort();
  }, [fetchHeatmap]);

  const cellByRoomHour = useMemo(() => {
    const m = new Map<string, HeatmapCellData>();
    if (!heatmapData) return m;
    for (const c of heatmapData.cells) {
      m.set(`${c.roomId}:${c.hour}`, c);
    }
    return m;
  }, [heatmapData]);

  const groupedColumns = useMemo(() => {
    if (!heatmapData) return [];
    const pim = heatmapData.columns.filter((c) => c.locationName === 'Pimlico');
    const ken = heatmapData.columns.filter((c) => c.locationName === 'Kensington');
    return [
      { title: 'Kensington', cols: ken },
      { title: 'Pimlico', cols: pim },
    ].filter((g) => g.cols.length > 0);
  }, [heatmapData]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
          Occupancy analytics
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Booked hours vs capacity (08:00–22:00, all confirmed/completed bookings). Fiscal year runs
          June–May (UTC).
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Fiscal year by month</CardTitle>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                June → May: occupancy % for each month
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="fy-start-year">FY start year (June)</Label>
                <Input
                  id="fy-start-year"
                  type="text"
                  inputMode="numeric"
                  className="w-28"
                  placeholder="e.g. 2025"
                  value={fyYearInput}
                  onChange={(e) => setFyYearInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mb-0.5"
                onClick={() => {
                  const y = parseInt(fyYearInput, 10);
                  if (y >= 2000 && y <= 2100) void fetchFyMonths(y);
                }}
              >
                Load
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {fyMonthsError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{fyMonthsError}</p>
            ) : fyMonthsLoading || !fyMonthsData ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <>
                <p className="text-sm font-medium mb-2">{fyMonthsData.fyLabel}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Kensington</TableHead>
                      <TableHead className="text-right">Pimlico</TableHead>
                      <TableHead className="text-right">Combined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fyMonthsData.months.map((row) => (
                      <TableRow key={row.monthKey}>
                        <TableCell>{row.monthLabel}</TableCell>
                        <TableCell className="text-right">
                          {row.kensingtonPercent.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right">
                          {row.pimlicoPercent.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right">
                          {row.combinedPercent.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Average annual occupancy</CardTitle>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Full June–May fiscal years (completed). Rows appear from 1 June 2026 for FY ending May
              2026.
            </p>
          </CardHeader>
          <CardContent>
            {annualError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{annualError}</p>
            ) : annualLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : annualRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                No completed fiscal years in this report yet. After 1 June 2026, FY 2025–26 (and
                later years) will appear here.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Year</TableHead>
                    <TableHead className="text-right">Kensington</TableHead>
                    <TableHead className="text-right">Pimlico</TableHead>
                    <TableHead className="text-right">Combined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {annualRows.map((row) => (
                    <TableRow key={row.fyLabel}>
                      <TableCell>{row.fyLabel}</TableCell>
                      <TableCell className="text-right">
                        {row.kensingtonPercent.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right">
                        {row.pimlicoPercent.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right">
                        {row.combinedPercent.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Occupancy over time</CardTitle>
          <div className="flex flex-wrap gap-4 mt-2">
            <div className="space-y-1">
              <Label htmlFor="occ-chart-range">Range</Label>
              <Select
                id="occ-chart-range"
                value={chartRange}
                onChange={(e) => setChartRange(e.target.value as RangeValue)}
                className="w-[min(100%,280px)]"
              >
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="occ-chart-scale">Scale</Label>
              <Select
                id="occ-chart-scale"
                value={chartScale}
                onChange={(e) => setChartScale(e.target.value as 'monthly' | 'annual')}
                className="w-40"
              >
                <option value="monthly">Monthly</option>
                <option value="annual">Annual (FY buckets)</option>
              </Select>
            </div>
          </div>
          {chartMeta && (
            <p className="text-xs text-slate-500 mt-2">
              Data window: {chartMeta.from} → {chartMeta.to}
            </p>
          )}
        </CardHeader>
        <CardContent className="h-[340px]">
          {chartError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{chartError}</p>
          ) : chartLoading ? (
            <Skeleton className="h-full w-full min-h-[280px]" />
          ) : chartPoints.length === 0 ? (
            <p className="text-sm text-slate-500">No data in this range.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartPoints} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                <XAxis dataKey="periodLabel" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${v}%`}
                  width={44}
                />
                <RechartsTooltip
                  formatter={(value: unknown) => chartTooltipFormat(value)}
                  labelClassName="text-slate-900 dark:text-slate-100"
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid rgb(226 232 240)',
                    background: 'white',
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="kensingtonPercent"
                  name="Kensington"
                  stroke="#0d9488"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="pimlicoPercent"
                  name="Pimlico"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="combinedPercent"
                  name="Combined"
                  stroke="#0f172a"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Room × hour occupancy</CardTitle>
          <div className="flex flex-wrap items-end gap-4 mt-2">
            <div className="space-y-1">
              <Label htmlFor="occ-heatmap-range">Time range</Label>
              <Select
                id="occ-heatmap-range"
                value={heatmapRange}
                onChange={(e) => setHeatmapRange(e.target.value as RangeValue)}
                className="w-[min(100%,280px)]"
              >
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            {heatmapData && (
              <p className="text-xs text-slate-500 pb-2">
                {heatmapData.range.from} → {heatmapData.range.to} ·{' '}
                {formatPresetLabel(heatmapData.range.preset)}
              </p>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {heatmapError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{heatmapError}</p>
          ) : heatmapLoading || !heatmapData ? (
            <Skeleton className="h-64 w-full min-w-[600px]" />
          ) : (
            <div className="min-w-[640px] space-y-3">
              <div className="flex border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden text-xs">
                <div className="w-14 shrink-0 bg-slate-50 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700">
                  <div className="h-8 border-b border-slate-200 dark:border-slate-700" />
                  {heatmapData.hourLabels.map((label) => (
                    <div
                      key={label}
                      className="h-7 flex items-center justify-end pr-2 text-slate-600 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800"
                    >
                      {label}
                    </div>
                  ))}
                </div>
                <div className="flex flex-1">
                  {groupedColumns.map((group) => (
                    <div key={group.title} className="flex flex-col flex-1 min-w-0 border-r border-slate-200 dark:border-slate-700 last:border-r-0">
                      <div className="h-8 flex border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
                        {group.cols.map((col) => (
                          <div
                            key={col.roomId}
                            className="flex-1 min-w-[52px] px-1 flex items-center justify-center text-center font-medium text-slate-700 dark:text-slate-300 border-l border-slate-200 dark:border-slate-700 first:border-l-0"
                          >
                            <span className="truncate" title={col.displayLabel}>
                              {col.roomName}
                            </span>
                          </div>
                        ))}
                      </div>
                      {heatmapData.hours.map((h, hi) => (
                        <div key={h} className="flex border-b border-slate-100 dark:border-slate-800 h-7">
                          {group.cols.map((col) => {
                            const c = cellByRoomHour.get(`${col.roomId}:${h}`);
                            const pct = c?.occupancyPercent ?? 0;
                            const label = heatmapData.hourLabels[hi] ?? `${h}:00`;
                            const nextLabel =
                              heatmapData.hourLabels[hi + 1] ??
                              `${Math.min(23, h + 1).toString().padStart(2, '0')}:00`;
                            return (
                              <div
                                key={col.roomId + h}
                                className="flex-1 min-w-[52px] border-l border-slate-100 dark:border-slate-800 first:border-l-0 p-0.5"
                                title={
                                  c
                                    ? `${col.displayLabel}\n${label}–${nextLabel}\nAvg. occupancy ${pct.toFixed(1)}%\n${c.bookedHours.toFixed(2)}h booked / ${c.capacityHours}h capacity\nBased on: ${formatPresetLabel(heatmapData.range.preset)}`
                                    : `${col.displayLabel} · ${label}–${nextLabel}`
                                }
                                style={{ backgroundColor: heatmapCellColor(pct) }}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>0%</span>
                <div
                  className="h-3 flex-1 max-w-md rounded-full border border-slate-200 dark:border-slate-700"
                  style={{
                    background:
                      'linear-gradient(90deg, hsl(55,90%,90%), hsl(120,50%,55%), hsl(200,40%,25%))',
                  }}
                />
                <span>100%</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
