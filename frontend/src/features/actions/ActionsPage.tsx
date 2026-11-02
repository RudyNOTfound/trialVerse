import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Plus, AlertCircle } from 'lucide-react';
import { actionsApi } from '@/api/actions';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RowActions } from '@/components/common/RowActions';
import { useToast } from '@/components/ui/toast';
import { useStaffDirectory } from '@/hooks/useStaffDirectory';
import { ActionFormDialog } from './ActionFormDialog';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate, formatDateTime, humanize } from '@/utils/format';
import { ACTION_NEXT } from '@/utils/transitions';
import type { ActionItem, ActionStatus, Priority } from '@/types/api';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];

export default function ActionsPage() {
  const { user, hasRole } = useAuth();
  const staff = useStaffDirectory();
  const [assignee, setAssignee] = useState('');
  const [editing, setEditing] = useState<ActionItem | undefined>();
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const filters = { page, pageSize: 15, status: (status || undefined) as ActionStatus | 'overdue' | undefined, priority: (priority || undefined) as Priority | undefined, assigneeId: assignee || undefined, sort: 'dueDate' as const, order: 'asc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['actions', filters], queryFn: () => actionsApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Actions" description="Follow-ups and tasks for your sites."
        actions={hasRole('admin', 'coordinator', 'investigator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New action</Button>} />
      <FilterBar>
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['pending', 'in_progress', 'completed', 'cancelled', 'overdue']} allLabel="All statuses" label="Filter by status" />
        <FilterSelect value={assignee} onChange={(v) => { setAssignee(v); setPage(1); }} options={(staff.data ?? []).map((u) => ({ value: u.id, label: u.id === user?.id ? `${u.fullName} (me)` : u.fullName }))} allLabel="All assignees" label="Filter by assignee" />
        <FilterSelect value={priority} onChange={(v) => { setPriority(v); setPage(1); }} options={PRIORITIES} allLabel="All priorities" label="Filter by priority" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(a) => a.id} onRowClick={(a) => setSelected(a.id)}
        emptyTitle="No actions found" emptyDescription="Create an action to track a follow-up."
        columns={[
          { header: 'Title', cell: (a) => <span className="font-medium text-ink">{a.title}</span> },
          { header: 'Priority', cell: (a) => <StatusBadge value={a.priority} /> },
          { header: 'Patient', cell: (a) => (a.patientId ? a.patientName ?? '—' : '—'), hideOnMobile: true },
          { header: 'Due', cell: (a) => <span className={a.isOverdue ? 'flex items-center gap-1 font-medium text-red-600' : ''}>{a.isOverdue && <AlertCircle className="h-3.5 w-3.5" />}{formatDate(a.dueDate)}</span> },
          { header: 'Assignee', cell: (a) => (a.assigneeId ? a.assigneeName ?? 'Unknown' : <span className="text-muted">Unassigned</span>), hideOnMobile: true },
          { header: 'Status', cell: (a) => <StatusBadge value={a.effectiveStatus} /> },
          { header: '', className: 'w-10 text-right', cell: (a) => (
            <RowActions label={`Actions for ${a.title}`} actions={[
              { label: 'View', icon: <Eye className="h-4 w-4" />, onSelect: () => setSelected(a.id) },
              // The API only lets the creator, assignee or an admin edit, and only while the action is open.
              { label: 'Edit', icon: <Pencil className="h-4 w-4" />, hidden: !(hasRole('admin') || a.createdBy === user?.id || a.assigneeId === user?.id) || a.status === 'completed' || a.status === 'cancelled', onSelect: () => setEditing(a) },
            ]} />
          ) },
        ]} />
      <ActionFormDialog open={creating} onOpenChange={setCreating} />
      <ActionFormDialog open={!!editing} action={editing} onOpenChange={(o) => !o && setEditing(undefined)} />
      <ActionDetailDialog id={selected} onClose={() => setSelected(null)} onEdit={(a) => { setSelected(null); setEditing(a); }} />
    </>
  );
}

function ActionDetailDialog({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (a: ActionItem) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, hasRole } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const a = useQuery({ queryKey: ['action', id], queryFn: () => actionsApi.get(id!), enabled: !!id });
  const history = useQuery({ queryKey: ['action-history', id], queryFn: () => actionsApi.history(id!), enabled: !!id });
  const change = useMutation({
    mutationFn: (status: ActionStatus) => actionsApi.setStatus(id!, status),
    onSuccess: () => { setError(null); toast.success('Status updated'); for (const k of ['action', 'action-history', 'actions', 'overview']) qc.invalidateQueries({ queryKey: [k] }); },
    onError: setError,
  });
  const d: ActionItem | undefined = a.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) { setError(null); onClose(); } }}>
      <DialogContent title={d?.title ?? 'Action'} className="max-w-xl">
        {a.isLoading ? <Skeleton className="h-40" /> : a.error || !d ? <ErrorState error={a.error} onRetry={() => a.refetch()} /> : (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2"><StatusBadge value={d.effectiveStatus} /><StatusBadge value={d.priority} /></div>
            {d.description && <p className="text-sm text-slate-700">{d.description}</p>}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted">Due</dt><dd className="font-medium">{formatDate(d.dueDate)}</dd></div>
              <div><dt className="text-xs text-muted">Assignee</dt><dd className="font-medium">{d.assigneeId ? d.assigneeName ?? 'Unknown' : 'Unassigned'}</dd></div>
              <div><dt className="text-xs text-muted">Patient</dt><dd className="font-medium">{d.patientId ? d.patientName ?? '—' : '—'}</dd></div>
              <div><dt className="text-xs text-muted">Created</dt><dd className="font-medium">{formatDateTime(d.createdAt)}</dd></div>
            </dl>
            {(hasRole('admin') || d.createdBy === user?.id || d.assigneeId === user?.id) && d.status !== 'completed' && d.status !== 'cancelled' && <Button size="sm" variant="outline" onClick={() => onEdit(d)}><Pencil className="h-4 w-4" />Edit details</Button>}
            {ACTION_NEXT[d.status].length > 0 && (
              <div className="flex flex-wrap gap-2">
                {ACTION_NEXT[d.status].map((s) => <Button key={s} size="sm" variant={s === 'completed' ? 'primary' : s === 'cancelled' ? 'danger-outline' : 'outline'} loading={change.isPending && change.variables === s} onClick={() => change.mutate(s)}>{d.status === 'completed' && s === 'in_progress' ? 'Reopen' : humanize(s)}</Button>)}
              </div>
            )}
            <InlineError error={error} />
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</p>
              <ol className="space-y-2 border-l border-line pl-4">
                {(history.data ?? []).map((h) => (
                  <li key={h.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />{h.fromStatus ? `${humanize(h.fromStatus)} → ` : ''}{humanize(h.toStatus)}
                    <span className="block text-xs text-muted">{formatDateTime(h.createdAt)} · {h.actorName ?? 'System'}{h.note ? ` · ${h.note}` : ''}</span></li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
