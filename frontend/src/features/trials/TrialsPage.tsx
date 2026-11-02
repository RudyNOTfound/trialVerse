import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { trialsApi } from '@/api/trials';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect, SearchBox } from '@/components/common/FilterBar';
import { InlineError } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/utils/format';
import type { TrialPhase, TrialStatus } from '@/types/api';

const PHASES: TrialPhase[] = ['I', 'I/II', 'II', 'II/III', 'III', 'IV'];

export default function TrialsPage({ base = '/app/trials', readOnly = false }: { base?: string; readOnly?: boolean }) {
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
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
        ]} />
      {!readOnly && <TrialFormDialog open={creating} onOpenChange={setCreating} onCreated={(t) => nav(`${base}/${t.id}`)} />}
    </>
  );
}

const schema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{3,30}$/, '3–30 letters, digits or dashes'),
  title: z.string().trim().min(3, 'At least 3 characters').max(200),
  sponsor: z.string().trim().min(1, 'Required').max(120),
  phase: z.enum(['I', 'I/II', 'II', 'II/III', 'III', 'IV']),
  description: z.string().max(5000),
  startDate: z.string(), endDate: z.string(),
}).refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: 'End date must not be before start date', path: ['endDate'] });
type Values = z.infer<typeof schema>;

function TrialFormDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: { id: string }) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { code: '', title: '', sponsor: '', phase: 'I', description: '', startDate: '', endDate: '' } });
  const m = useMutation({
    mutationFn: (v: Values) => trialsApi.create({ ...v, description: v.description || undefined, startDate: v.startDate || undefined, endDate: v.endDate || undefined }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ['trials'] }); qc.invalidateQueries({ queryKey: ['directory', 'trials'] }); reset(); onOpenChange(false); onCreated(t); },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="New trial" description="Trials start in draft status.">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trial code" error={errors.code?.message}><Input placeholder="TG-ONC-201" {...register('code')} /></Field>
            <Field label="Phase" error={errors.phase?.message}><Select {...register('phase')}>{PHASES.map((p) => <option key={p} value={p}>Phase {p}</option>)}</Select></Field>
          </div>
          <Field label="Title" error={errors.title?.message}><Input {...register('title')} /></Field>
          <Field label="Sponsor" error={errors.sponsor?.message}><Input {...register('sponsor')} /></Field>
          <Field label="Description (optional)" error={errors.description?.message}><Textarea {...register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" error={errors.startDate?.message}><Input type="date" {...register('startDate')} /></Field>
            <Field label="End date" error={errors.endDate?.message}><Input type="date" {...register('endDate')} /></Field>
          </div>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Create trial</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
