import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, AlertCircle } from 'lucide-react';
import { actionsApi } from '@/api/actions';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDate, formatDateTime, humanize } from '@/utils/format';
import { ACTION_NEXT } from '@/utils/transitions';
import type { ActionItem, ActionStatus, Priority } from '@/types/api';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];

export default function ActionsPage() {
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const filters = { page, pageSize: 15, status: (status || undefined) as ActionStatus | 'overdue' | undefined, priority: (priority || undefined) as Priority | undefined, sort: 'dueDate' as const, order: 'asc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['actions', filters], queryFn: () => actionsApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Actions" description="Follow-ups and tasks for your sites."
        actions={hasRole('admin', 'coordinator', 'investigator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New action</Button>} />
      <FilterBar>
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['pending', 'in_progress', 'completed', 'cancelled', 'overdue']} allLabel="All statuses" label="Filter by status" />
        <FilterSelect value={priority} onChange={(v) => { setPriority(v); setPage(1); }} options={PRIORITIES} allLabel="All priorities" label="Filter by priority" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading || dir.loading} error={error} onRetry={() => refetch()} rowKey={(a) => a.id} onRowClick={(a) => setSelected(a.id)}
        emptyTitle="No actions found" emptyDescription="Create an action to track a follow-up."
        columns={[
          { header: 'Title', cell: (a) => <span className="font-medium text-ink">{a.title}</span> },
          { header: 'Priority', cell: (a) => <StatusBadge value={a.priority} /> },
          { header: 'Patient', cell: (a) => (a.patientId ? dir.patientName(a.patientId) : '—'), hideOnMobile: true },
          { header: 'Due', cell: (a) => <span className={a.isOverdue ? 'flex items-center gap-1 font-medium text-red-600' : ''}>{a.isOverdue && <AlertCircle className="h-3.5 w-3.5" />}{formatDate(a.dueDate)}</span> },
          { header: 'Status', cell: (a) => <StatusBadge value={a.effectiveStatus} /> },
        ]} />
      <ActionFormDialog open={creating} onOpenChange={setCreating} />
      <ActionDetailDialog id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

const schema = z.object({
  title: z.string().trim().min(3, 'At least 3 characters').max(200),
  description: z.string().max(5000),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  dueDate: z.string(),
  patientId: z.string(),
  assignToMe: z.boolean(),
});
type Values = z.infer<typeof schema>;

function ActionFormDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const dir = useDirectory();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { title: '', description: '', priority: 'medium', dueDate: '', patientId: '', assignToMe: true } });
  const m = useMutation({
    mutationFn: (v: Values) => actionsApi.create({
      title: v.title, description: v.description || undefined, priority: v.priority,
      dueDate: v.dueDate ? new Date(`${v.dueDate}T23:59:00`).toISOString() : undefined,
      patientId: v.patientId || undefined, assigneeId: v.assignToMe ? user?.id : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['actions'] }); qc.invalidateQueries({ queryKey: ['overview'] }); reset(); onOpenChange(false); },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="New action">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Title" error={errors.title?.message}><Input {...register('title')} /></Field>
          <Field label="Description (optional)" error={errors.description?.message}><Textarea {...register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" error={errors.priority?.message}><Select {...register('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
            <Field label="Due date (optional)" error={errors.dueDate?.message}><Input type="date" {...register('dueDate')} /></Field>
          </div>
          <Field label="Related patient (optional)"><Select {...register('patientId')}><option value="">None</option>{dir.patients.map((p) => <option key={p.id} value={p.id}>{p.subjectCode} · {p.firstName} {p.lastName}</option>)}</Select></Field>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4 rounded border-line" {...register('assignToMe')} />Assign to me</label>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Create action</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ActionDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [error, setError] = useState<unknown>(null);
  const a = useQuery({ queryKey: ['action', id], queryFn: () => actionsApi.get(id!), enabled: !!id });
  const history = useQuery({ queryKey: ['action-history', id], queryFn: () => actionsApi.history(id!), enabled: !!id });
  const change = useMutation({
    mutationFn: (status: ActionStatus) => actionsApi.setStatus(id!, status),
    onSuccess: () => { setError(null); for (const k of ['action', 'action-history', 'actions', 'overview']) qc.invalidateQueries({ queryKey: [k] }); },
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
              <div><dt className="text-xs text-muted">Assignee</dt><dd className="font-medium">{d.assigneeId ? dir.userName(d.assigneeId) : 'Unassigned'}</dd></div>
              <div><dt className="text-xs text-muted">Patient</dt><dd className="font-medium">{d.patientId ? dir.patientName(d.patientId) : '—'}</dd></div>
              <div><dt className="text-xs text-muted">Created</dt><dd className="font-medium">{formatDateTime(d.createdAt)}</dd></div>
            </dl>
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
                    <span className="block text-xs text-muted">{formatDateTime(h.createdAt)} · {dir.userName(h.actorId)}{h.note ? ` · ${h.note}` : ''}</span></li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
