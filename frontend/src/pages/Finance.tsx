import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
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
import { practitionerApi, InvoiceItem } from '@/services/api';

function formatAmount(pence: number, currency: string): string {
  if (currency === 'gbp') return `£${(pence / 100).toFixed(2)}`;
  return `${(pence / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function formatInvoiceDate(created: number): string {
  return new Date(created * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

interface BreakdownItem {
  type: 'credits' | 'stripe' | 'voucher';
  amount: number;
  description: string;
  hours?: number;
}

interface TransactionHistoryEntry {
  date: string;
  description: string;
  amount: number;
  type: 'credit_grant' | 'booking' | 'voucher_allocation' | 'stripe_payment';
  bookingId?: string;
  breakdown?: BreakdownItem[];
}

export const Finance: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transactionHistory, setTransactionHistory] = useState<TransactionHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  
  // Get month from URL params or default to current month
  const getCurrentMonth = () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  };
  
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const monthParam = searchParams.get('month');
    return monthParam || getCurrentMonth();
  });

  const fetchInvoices = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await practitionerApi.getInvoices(signal);
      if (signal?.aborted) return;
      if (res.data.success && Array.isArray(res.data.invoices)) {
        setInvoices(res.data.invoices);
      } else {
        setInvoices([]);
      }
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
      )
        return;
      setInvoices([]);
      setError('Failed to load invoices');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const fetchTransactionHistory = useCallback(async (month: string, signal?: AbortSignal) => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await practitionerApi.getTransactionHistory(month, signal);
      if (signal?.aborted) return;
      if (res.data.success && Array.isArray(res.data.data)) {
        setTransactionHistory(res.data.data);
      } else {
        setTransactionHistory([]);
      }
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError'))
      )
        return;
      setTransactionHistory([]);
      setHistoryError('Failed to load transaction history');
    } finally {
      if (!signal?.aborted) setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    fetchInvoices(c.signal);
    return () => c.abort();
  }, [fetchInvoices]);

  // Fetch transaction history when month changes
  useEffect(() => {
    const c = new AbortController();
    fetchTransactionHistory(selectedMonth, c.signal);
    return () => c.abort();
  }, [selectedMonth, fetchTransactionHistory]);

  // Update URL params when month changes
  useEffect(() => {
    if (selectedMonth) {
      setSearchParams({ month: selectedMonth }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth]); // setSearchParams is stable in react-router-dom v6

  // Format date as DD.MM.YYYY
  const formatTransactionDate = (dateStr: string): string => {
    // Validate date format (YYYY-MM-DD) before splitting
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // Fallback: return the original string if it's not in the expected format
      return dateStr;
    }
    const [year, month, day] = dateStr.split('-');
    return `${day}.${month}.${year}`;
  };

  // Format amount with proper sign
  const formatTransactionAmount = (amount: number): string => {
    if (amount === 0) return '£0.00';
    if (amount > 0) return `+£${amount.toFixed(2)}`;
    return `-£${Math.abs(amount).toFixed(2)}`;
  };

  // Format month label from selectedMonth (e.g., "February 2026")
  const formatMonthLabel = (): string => {
    const [year, month] = selectedMonth.split('-');
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Finance</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            View your transaction history and download invoices from Stripe.
          </p>
        </div>

        {/* Transaction History */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Icon name="receipt" className="text-primary" />
                Transaction History
              </CardTitle>
              <div className="flex items-center gap-2">
                <label htmlFor="transaction-month-selector" className="text-sm text-slate-600 dark:text-slate-400">
                  Month:
                </label>
                <input
                  id="transaction-month-selector"
                  type="month"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingHistory ? (
              <p className="text-sm text-slate-500">Loading transaction history…</p>
            ) : historyError ? (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {historyError}
              </p>
            ) : transactionHistory.length === 0 ? (
              <p className="text-sm text-slate-500">No transactions for this month.</p>
            ) : (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                    {formatMonthLabel()}
                  </h3>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Transaction details</TableHead>
                          <TableHead className="text-right">Amount in GBP</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {transactionHistory.map((transaction, idx) => {
                          const hasBreakdown = transaction.type === 'booking' && transaction.breakdown && transaction.breakdown.length > 0;
                          
                          return (
                            <React.Fragment key={`${transaction.date}-${transaction.description}-${transaction.amount}-${idx}`}>
                              {/* Main transaction row */}
                              <TableRow>
                                <TableCell className="font-medium">
                                  {formatTransactionDate(transaction.date)}
                                </TableCell>
                                <TableCell>
                                  {transaction.type === 'booking' ? (
                                    <span className="font-medium">{transaction.description}</span>
                                  ) : (
                                    transaction.description
                                  )}
                                </TableCell>
                                <TableCell
                                  className={`text-right font-medium ${
                                    transaction.amount > 0
                                      ? 'text-green-600 dark:text-green-400'
                                      : transaction.amount < 0
                                      ? 'text-red-600 dark:text-red-400'
                                      : 'text-slate-500 dark:text-slate-400'
                                  }`}
                                >
                                  {transaction.type === 'booking' && hasBreakdown ? (
                                    // For bookings with breakdown, show total as negative (cost)
                                    formatTransactionAmount(-transaction.amount)
                                  ) : (
                                    formatTransactionAmount(transaction.amount)
                                  )}
                                </TableCell>
                              </TableRow>
                              
                              {/* Sub-rows for breakdown */}
                              {hasBreakdown && transaction.breakdown!.map((item, breakdownIdx) => (
                                <TableRow key={`breakdown-${idx}-${breakdownIdx}`} className="bg-slate-50/50 dark:bg-slate-900/50">
                                  <TableCell></TableCell>
                                  <TableCell className="pl-8 text-sm text-slate-600 dark:text-slate-400">
                                    {item.type === 'voucher' && item.hours ? (
                                      `${item.description}: ${item.hours.toFixed(1)} hour${item.hours !== 1 ? 's' : ''}`
                                    ) : (
                                      `${item.description}`
                                    )}
                                  </TableCell>
                                  <TableCell
                                    className={`text-right text-sm ${
                                      item.type === 'stripe'
                                        ? 'text-green-600 dark:text-green-400'
                                        : item.type === 'credits'
                                        ? 'text-slate-600 dark:text-slate-400'
                                        : 'text-slate-500 dark:text-slate-400'
                                    }`}
                                  >
                                    {item.type === 'voucher' ? (
                                      '—'
                                    ) : (
                                      // Show positive amounts for breakdown items (credits used, Stripe paid)
                                      `£${item.amount.toFixed(2)}`
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </React.Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Icon name="receipt_long" className="text-primary" />
              Invoice history
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-slate-500">Loading invoices…</p>
            ) : error ? (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-slate-500">No invoices yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Download</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">
                          {inv.number ?? inv.id}
                        </TableCell>
                        <TableCell>{formatInvoiceDate(inv.created)}</TableCell>
                        <TableCell>{formatAmount(inv.amount_paid, inv.currency)}</TableCell>
                        <TableCell>
                          <span
                            className={
                              inv.status === 'paid'
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-slate-600 dark:text-slate-400'
                            }
                          >
                            {inv.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {inv.invoice_pdf ? (
                            <a
                              href={inv.invoice_pdf}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-sm"
                            >
                              PDF
                            </a>
                          ) : (
                            <span className="text-slate-400 text-sm">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
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
