import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { reimbursementsApi } from '@/api/reimbursements';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate, formatMoney } from '@/utils/format';
import type { PaymentStatus, ReimbursementCategory, ReimbursementStatus } from '@/types/api';
import { ReimbursementDetailDialog } from './ReimbursementDetailDialog';
import { ReimbursementFormDialog } from './ReimbursementFormDialog';

export default function ReimbursementsPage() {
  const { hasRole } = useAuth();
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filters = { page, pageSize: 15, status: (status || undefined) as ReimbursementStatus | undefined, paymentStatus: (payment || undefined) as PaymentStatus | undefined, category: (category || undefined) as ReimbursementCategory | undefined };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reimbursements', filters], queryFn: () => reimbursementsApi.list(filters), placeholderData: (p) => p });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <>
      <PageHeader title="Reimbursements" description="Participant expense claims linked to visits."
        actions={hasRole('admin', 'coordinator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New claim</Button>} />
      <FilterBar>
        <FilterSelect value={status} onChange={reset(setStatus)} options={['pending', 'approved', 'rejected', 'cancelled']} allLabel="All statuses" label="Filter by status" />
        <FilterSelect value={payment} onChange={reset(setPayment)} options={['none', 'unpaid', 'processing', 'paid', 'failed']} allLabel="All payment states" label="Filter by payment status" />
        <FilterSelect value={category} onChange={reset(setCategory)} options={['travel', 'meals', 'accommodation', 'parking', 'other']} allLabel="All categories" label="Filter by category" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(r) => r.id} onRowClick={(r) => setSelected(r.id)}
        emptyTitle="No reimbursements found"
        columns={[
          { header: 'Patient', cell: (r) => <span className="font-medium">{r.patientName ?? '—'}</span> },
          { header: 'Category', cell: (r) => <span className="capitalize">{r.category}</span> },
          { header: 'Amount', cell: (r) => <span className="font-medium tabular-nums">{formatMoney(r.amountCents, r.currency)}</span> },
          { header: 'Trial', cell: (r) => r.trialCode ?? '—', hideOnMobile: true },
          { header: 'Submitted', cell: (r) => formatDate(r.createdAt), hideOnMobile: true },
          { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
          { header: 'Payment', cell: (r) => <StatusBadge value={r.paymentStatus} />, hideOnMobile: true },
        ]} />
      <ReimbursementDetailDialog id={selected} onClose={() => setSelected(null)} />
      <ReimbursementFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
