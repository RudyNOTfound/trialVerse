import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { patientsApi } from '@/api/patients';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect, SearchBox } from '@/components/common/FilterBar';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { RowActions } from '@/components/common/RowActions';
import { useAuth } from '@/contexts/AuthContext';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/utils/format';
import type { PatientStatus } from '@/types/api';
import type { Patient } from '@/types/api';
import { DeletePatientDialog } from './DeletePatientDialog';
import { PatientFormDialog } from './PatientFormDialog';

export default function PatientsPage() {
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Patient | undefined>();
  const [deleting, setDeleting] = useState<Patient | null>(null);
  const debounced = useDebounce(search);
  const filters = { page, pageSize: 15, search: debounced, status: (status || undefined) as PatientStatus | undefined, sort: 'lastName' as const, order: 'asc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['patients', filters], queryFn: () => patientsApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Patients" description="Registered participants across all trials."
        actions={hasRole('admin', 'coordinator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New patient</Button>} />
      <FilterBar>
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name or subject code" />
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['active', 'withdrawn', 'inactive']} allLabel="All statuses" label="Filter by status" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()}
        rowKey={(p) => p.id} onRowClick={(p) => nav(`/app/patients/${p.id}`)}
        emptyTitle="No patients found" emptyDescription={debounced || status ? 'Try changing your filters.' : 'Create the first patient to get started.'}
        columns={[
          { header: 'Subject', cell: (p) => <span className="font-mono text-xs text-slate-600">{p.subjectCode}</span> },
          { header: 'Name', cell: (p) => <span className="font-medium text-ink">{p.firstName} {p.lastName}</span> },
          { header: 'Date of birth', cell: (p) => formatDate(p.dateOfBirth), hideOnMobile: true },
          { header: 'Sex', cell: (p) => <span className="capitalize">{p.sex}</span>, hideOnMobile: true },
          { header: 'Contact', cell: (p) => <span className="text-muted">{p.email ?? p.phone ?? '—'}</span>, hideOnMobile: true },
          { header: 'Status', cell: (p) => <StatusBadge value={p.status} /> },
          { header: '', className: 'w-10 text-right', cell: (p) => (
            <RowActions label={`Actions for ${p.firstName} ${p.lastName}`} actions={[
              { label: 'View', icon: <Eye className="h-4 w-4" />, onSelect: () => nav(`/app/patients/${p.id}`) },
              { label: 'Edit', icon: <Pencil className="h-4 w-4" />, hidden: !hasRole('admin', 'coordinator'), onSelect: () => setEditing(p) },
              { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: !hasRole('admin'), onSelect: () => setDeleting(p) },
            ]} />
          ) },
        ]} />
      <PatientFormDialog open={!!editing} patient={editing} onOpenChange={(o) => !o && setEditing(undefined)} />
      <DeletePatientDialog patient={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
      <PatientFormDialog open={creating} onOpenChange={setCreating} onCreated={(p) => nav(`/app/patients/${p.id}`)} />
    </>
  );
}
