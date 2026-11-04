import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { trialsApi } from '@/api/trials';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect, SearchBox } from '@/components/common/FilterBar';
import { RowActions } from '@/components/common/RowActions';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/utils/format';
import type { Trial, TrialStatus } from '@/types/api';
import { DeleteTrialDialog } from './DeleteTrialDialog';
import { TrialFormDialog } from './TrialFormDialog';

export default function TrialsPage({ base = '/app/trials', readOnly = false }: { base?: string; readOnly?: boolean }) {
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Trial | undefined>();
  const [deleting, setDeleting] = useState<Trial | null>(null);
  const debounced = useDebounce(search);
  const filters = { page, pageSize: 15, search: debounced, status: (status || undefined) as TrialStatus | undefined };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['trials', filters], queryFn: () => trialsApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Clinical trials" description="Studies, phases and participating sites."
        actions={!readOnly && hasRole('admin', 'coordinator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New trial</Button>} />
      <FilterBar>
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search code or title" />
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['draft', 'active', 'suspended', 'completed', 'terminated']} allLabel="All statuses" label="Filter by status" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(t) => t.id} onRowClick={(t) => nav(`${base}/${t.id}`)}
        emptyTitle="No trials found"
        columns={[
          { header: 'Code', cell: (t) => <span className="font-mono text-xs font-medium text-slate-700">{t.code}</span> },
          { header: 'Title', cell: (t) => <span className="font-medium text-ink">{t.title}</span> },
          { header: 'Sponsor', cell: (t) => t.sponsor, hideOnMobile: true },
          { header: 'Phase', cell: (t) => `Phase ${t.phase}`, hideOnMobile: true },
          { header: 'Start', cell: (t) => formatDate(t.startDate), hideOnMobile: true },
          { header: 'Status', cell: (t) => <StatusBadge value={t.status} /> },
          { header: '', className: 'w-10 text-right', cell: (t) => (
            <RowActions label={`Actions for ${t.code}`} actions={[
              { label: 'View', icon: <Eye className="h-4 w-4" />, onSelect: () => nav(`${base}/${t.id}`) },
              { label: 'Edit', icon: <Pencil className="h-4 w-4" />, hidden: readOnly || !hasRole('admin', 'coordinator'), onSelect: () => setEditing(t) },
              { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: readOnly || !hasRole('admin'), onSelect: () => setDeleting(t) },
            ]} />
          ) },
        ]} />
      {!readOnly && <TrialFormDialog open={creating} onOpenChange={setCreating} onCreated={(t) => nav(`${base}/${t.id}`)} />}
      {!readOnly && <TrialFormDialog open={!!editing} trial={editing} onOpenChange={(o) => !o && setEditing(undefined)} />}
      {!readOnly && <DeleteTrialDialog trial={deleting} onOpenChange={(o) => !o && setDeleting(null)} />}
    </>
  );
}
