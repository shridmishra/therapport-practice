import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { AccessDenied } from '@/components/AccessDenied';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type AdminPricesPayload } from '@/services/api';

type EditableRate = {
  key: string;
  label: string;
  value: number;
};

function toFixed2(value: number): number {
  return Number(Number.isFinite(value) ? value.toFixed(2) : '0');
}

export const AdminPrices: React.FC = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [prices, setPrices] = useState<AdminPricesPayload | null>(null);

  const fetchPrices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getPrices();
      if (response.data.success && response.data.data) {
        setPrices(response.data.data);
      } else {
        setError('Failed to load prices');
      }
    } catch {
      setError('Failed to load prices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') {
      fetchPrices();
    }
  }, [fetchPrices, user?.role]);

  const hourlyEditorRows = useMemo<EditableRate[]>(() => {
    if (!prices) return [];
    return prices.hourlyRates.map((r) => ({
      key: `${r.locationName}:${r.dayType}:${r.timeBand}`,
      label: `${r.locationName} - ${r.dayType} - ${r.timeBand}`,
      value: r.rateGbp,
    }));
  }, [prices]);

  const permanentEditorRows = useMemo<EditableRate[]>(() => {
    if (!prices) return [];
    return prices.permanentSlotRates.map((r) => ({
      key: `${r.locationName}:${r.roomGroup}:${r.dayType}:${r.timeBand}`,
      label: `${r.locationName} - ${r.roomGroup} - ${r.dayType} - ${r.timeBand}`,
      value: r.monthlyFeeGbp,
    }));
  }, [prices]);

  if (user?.role !== 'admin') {
    return <AccessDenied />;
  }

  const updateHourly = (key: string, nextValue: number) => {
    setPrices((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        hourlyRates: prev.hourlyRates.map((r) =>
          `${r.locationName}:${r.dayType}:${r.timeBand}` === key
            ? { ...r, rateGbp: toFixed2(nextValue) }
            : r
        ),
      };
    });
  };

  const updatePermanent = (key: string, nextValue: number) => {
    setPrices((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        permanentSlotRates: prev.permanentSlotRates.map((r) =>
          `${r.locationName}:${r.roomGroup}:${r.dayType}:${r.timeBand}` === key
            ? { ...r, monthlyFeeGbp: toFixed2(nextValue) }
            : r
        ),
      };
    });
  };

  const save = async () => {
    if (!prices) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await adminApi.updatePrices({
        monthlySubscriptionGbp: prices.monthlySubscriptionGbp,
        adHocSubscriptionGbp: prices.adHocSubscriptionGbp,
        hourlyRates: prices.hourlyRates.map((r) => ({
          locationName: r.locationName,
          dayType: r.dayType,
          timeBand: r.timeBand,
          rateGbp: toFixed2(r.rateGbp),
        })),
        permanentSlotRates: prices.permanentSlotRates.map((r) => ({
          locationName: r.locationName,
          roomGroup: r.roomGroup,
          dayType: r.dayType,
          timeBand: r.timeBand,
          monthlyFeeGbp: toFixed2(r.monthlyFeeGbp),
        })),
      });
      if (response.data.success && response.data.data) {
        setPrices(response.data.data);
        setSuccess('Prices updated successfully.');
      } else {
        setError(response.data.error ?? 'Failed to update prices');
      }
    } catch {
      setError('Failed to update prices');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Admin Prices</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Update subscription, hourly and permanent slot prices.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchPrices} disabled={loading || saving}>
              Reload
            </Button>
            <Button onClick={save} disabled={loading || saving || !prices}>
              {saving ? 'Saving...' : 'Save prices'}
            </Button>
          </div>
        </div>

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        {success ? <p className="text-sm text-green-600 dark:text-green-400">{success}</p> : null}

        <Card>
          <CardHeader>
            <CardTitle>Subscriptions</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-sm text-slate-600 dark:text-slate-400">Monthly subscription (GBP)</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={prices?.monthlySubscriptionGbp ?? 0}
                onChange={(e) =>
                  setPrices((prev) =>
                    prev ? { ...prev, monthlySubscriptionGbp: toFixed2(Number(e.target.value)) } : prev
                  )
                }
                disabled={loading || saving || !prices}
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm text-slate-600 dark:text-slate-400">Ad-hoc one-off (GBP)</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={prices?.adHocSubscriptionGbp ?? 0}
                onChange={(e) =>
                  setPrices((prev) =>
                    prev ? { ...prev, adHocSubscriptionGbp: toFixed2(Number(e.target.value)) } : prev
                  )
                }
                disabled={loading || saving || !prices}
              />
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hourly Booking Prices</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {hourlyEditorRows.map((row) => (
              <label key={row.key} className="space-y-1">
                <span className="text-sm text-slate-600 dark:text-slate-400">{row.label}</span>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={row.value}
                  onChange={(e) => updateHourly(row.key, Number(e.target.value))}
                  disabled={loading || saving || !prices}
                />
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permanent Slot Prices</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {permanentEditorRows.map((row) => (
              <label key={row.key} className="space-y-1">
                <span className="text-sm text-slate-600 dark:text-slate-400">{row.label}</span>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={row.value}
                  onChange={(e) => updatePermanent(row.key, Number(e.target.value))}
                  disabled={loading || saving || !prices}
                />
              </label>
            ))}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

