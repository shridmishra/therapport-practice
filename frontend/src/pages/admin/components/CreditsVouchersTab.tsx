import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CreditSummary, VoucherSummary } from '@/services/api';

export interface CreditsVouchersTabProps {
  credit: CreditSummary | null;
  voucher: VoucherSummary | null;
  loading: boolean;
  allocating: boolean;
  onAllocate: (data: {
    hoursAllocated: number;
    expiryDate: string;
    reason?: string;
  }) => Promise<void>;
}

export const CreditsVouchersTab: React.FC<CreditsVouchersTabProps> = ({
  credit,
  voucher,
  loading,
  allocating,
  onAllocate,
}) => {
  const [hours, setHours] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const h = parseFloat(hours);
    if (Number.isNaN(h) || h <= 0 || !expiryDate.trim()) return;
    await onAllocate({
      hoursAllocated: h,
      expiryDate: expiryDate.trim(),
      reason: reason.trim() || undefined,
    });
    setHours('');
    setReason('');
  };

  return (
    <div className="space-y-6 pt-4">
      {loading ? (
        <div className="text-slate-500">Loading credits and vouchers...</div>
      ) : (
        <>
          <div>
            <h4 className="text-sm font-medium mb-2">Remaining credit</h4>
            {credit?.membershipType === 'permanent' ? (
              <p className="text-slate-500 text-sm">
                Permanent members are billed outside the app.
              </p>
            ) : credit?.byMonth && credit.byMonth.length > 0 ? (
              <div className="space-y-2">
                {credit.byMonth.map((monthCredit) => {
                  // Format month from YYYY-MM to "MMM YYYY" (e.g., "2026-02" -> "Feb 2026")
                  // Validate month format before parsing to prevent Invalid Date
                  const monthFormatRegex = /^\d{4}-\d{2}$/;
                  if (!monthFormatRegex.test(monthCredit.month)) {
                    // Fallback to raw string if format is invalid
                    return (
                      <div key={monthCredit.month} className="flex items-center gap-3 py-1">
                        <span className="text-sm font-medium">{monthCredit.month}</span>
                        <span className="text-lg font-bold">£{monthCredit.remainingCredit.toFixed(2)}</span>
                      </div>
                    );
                  }
                  const [year, month] = monthCredit.month.split('-');
                  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
                  const monthName = date.toLocaleDateString('en-GB', {
                    month: 'short',
                    year: 'numeric',
                  });
                  return (
                    <div key={monthCredit.month} className="flex items-center gap-3 py-1">
                      <span className="text-sm font-medium">{monthName}</span>
                      <span className="text-lg font-bold">£{monthCredit.remainingCredit.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            ) : credit?.currentMonth ? (
              <div className="text-2xl font-bold">
                £{credit.currentMonth.remainingCredit.toFixed(2)}
              </div>
            ) : (
              <p className="text-slate-500 text-sm">No membership or ad-hoc credit.</p>
            )}
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Free booking vouchers</h4>
            {voucher && voucher.vouchers.length > 0 ? (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hours allocated</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Remaining</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {voucher.vouchers.map((v) => (
                      <TableRow key={v.id}>
                        <TableCell>{v.hoursAllocated}</TableCell>
                        <TableCell>{v.hoursUsed}</TableCell>
                        <TableCell>{v.remainingHours}</TableCell>
                        <TableCell>{v.expiryDate}</TableCell>
                        <TableCell className="text-slate-500">{v.reason ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="px-4 py-2 text-sm text-slate-500 border-t">
                  Total remaining: {voucher.remainingHours.toFixed(1)}h
                  {voucher.earliestExpiry && ` (earliest expiry: ${voucher.earliestExpiry})`}
                </div>
              </div>
            ) : (
              <p className="text-slate-500 text-sm">No active vouchers.</p>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 border-t pt-4">
            <h4 className="text-sm font-medium">Allocate free booking hours</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label htmlFor="voucher-hours">Hours</Label>
                <Input
                  id="voucher-hours"
                  type="number"
                  min="0.5"
                  step="0.5"
                  placeholder="e.g. 2"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="voucher-expiry">Expiry date</Label>
                <Input
                  id="voucher-expiry"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="voucher-reason">Reason (optional)</Label>
                <Input
                  id="voucher-reason"
                  type="text"
                  placeholder="e.g. Promotional"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={allocating || !hours || !expiryDate}>
              {allocating ? 'Allocating...' : 'Allocate hours'}
            </Button>
          </form>
        </>
      )}
    </div>
  );
};
