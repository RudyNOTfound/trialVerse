import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { enrollmentsApi } from '@/api/trials';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { InlineError } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDate, humanize } from '@/utils/format';
import { ENROLLMENT_NEXT } from '@/utils/transitions';
import type { Enrollment, EnrollmentStatus } from '@/types/api';

export default function EnrollmentsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const [status, setStatus] = useState('');
  const [trialId, setTrialId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [rowError, setRowError] = useState<unknown>(null);
  const filters = { page, pageSize: 15, status: (status || undefined) as EnrollmentStatus | undefined, trialId: trialId || undefined };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['enrollments', filters], queryFn: () => enrollmentsApi.list(filters), placeholderData: (p) => p });
  const change = useMutation({
    mutationFn: ({ id, status }: { id: string; status: EnrollmentStatus }) => enrollmentsApi.setStatus(id, status),
    onSuccess: () => { setRowError(null); qc.invalidateQueries({ queryKey: ['enrollments'] }); qc.invalidateQueries({ queryKey: ['overview'] }); },
    onError: setRowError,
  });
  const canManage = hasRole('admin', 'coordinator', 'investigator');

  return (
    <>
      <PageHeader title="Enrollments" description="Link patients to trials and sites, and manage their enrollment status."
        actions={hasRole('admin', 'coordinator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Enrol patient</Button>} />
      <FilterBar>
        <FilterSelect value={trialId} onChange={(v) => { setTrialId(v); setPage(1); }} options={dir.trials.map((t) => ({ value: t.id, label: t.code }))} allLabel="All trials" label="Filter by trial" />
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['screening', 'enrolled', 'completed', 'withdrawn', 'screen_failed']} allLabel="All statuses" label="Filter by status" />
      </FilterBar>
      <div className="mb-3"><InlineError error={rowError} /></div>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading || dir.loading} error={error} onRetry={() => refetch()} rowKey={(e) => e.id}
        emptyTitle="No enrollments found"
        columns={[
          { header: 'Patient', cell: (e) => <button className="font-medium text-brand-700 hover:underline" onClick={() => nav(`/app/patients/${e.patientId}`)}>{dir.patientName(e.patientId)}</button> },
          { header: 'Trial', cell: (e) => <button className="hover:underline" onClick={() => nav(`/app/trials/${e.trialId}`)}>{dir.trialCode(e.trialId)}</button> },
          { header: 'Site', cell: (e) => dir.siteName(e.trialSiteId), hideOnMobile: true },
          { header: 'Arm', cell: (e) => e.arm ?? '—', hideOnMobile: true },
          { header: 'Enrolled', cell: (e) => formatDate(e.enrolledAt), hideOnMobile: true },
          { header: 'Status', cell: (e) => <StatusBadge value={e.status} /> },
          ...(canManage ? [{ header: 'Change status', cell: (e: Enrollment) => <StatusMenu enrollment={e} pending={change.isPending && change.variables?.id === e.id} onPick={(s) => change.mutate({ id: e.id, status: s })} /> }] : []),
        ]} />
      <EnrollDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function StatusMenu({ enrollment, onPick, pending }: { enrollment: Enrollment; onPick: (s: EnrollmentStatus) => void; pending: boolean }) {
  const next = ENROLLMENT_NEXT[enrollment.status];
  if (!next.length) return <span className="text-xs text-muted">Final</span>;
  return (
    <Select className="h-8 w-36 text-xs" value="" disabled={pending} aria-label="Change enrollment status"
      onChange={(e) => { const s = e.target.value as EnrollmentStatus; if (s && window.confirm(`Change status to "${humanize(s)}"?`)) onPick(s); }}>
      <option value="">Move to…</option>
      {next.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
    </Select>
  );
}

const schema = z.object({ patientId: z.string().min(1, 'Select a patient'), trialId: z.string().min(1, 'Select a trial'), trialSiteId: z.string().min(1, 'Select a site'), arm: z.string().max(60) });
type Values = z.infer<typeof schema>;

function EnrollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { patientId: '', trialId: '', trialSiteId: '', arm: '' } });
  const trialId = watch('trialId');
  const sites = dir.sites.filter((s) => s.trialId === trialId && s.status === 'active');
  const m = useMutation({
    mutationFn: (v: Values) => enrollmentsApi.create({ ...v, arm: v.arm || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['enrollments'] }); qc.invalidateQueries({ queryKey: ['overview'] }); reset(); onOpenChange(false); },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="Enrol patient" description="New enrollments start in screening.">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Patient" error={errors.patientId?.message}>
            <Select {...register('patientId')}><option value="">Select patient…</option>{dir.patients.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.subjectCode} · {p.firstName} {p.lastName}</option>)}</Select>
          </Field>
          <Field label="Trial" error={errors.trialId?.message}>
            <Select {...register('trialId', { onChange: () => setValue('trialSiteId', '') })}><option value="">Select trial…</option>{dir.trials.filter((t) => t.status === 'active' || t.status === 'draft').map((t) => <option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}</Select>
          </Field>
          <Field label="Site" error={errors.trialSiteId?.message} hint={trialId && !sites.length ? 'This trial has no active sites yet.' : undefined}>
            <Select {...register('trialSiteId')} disabled={!trialId}><option value="">Select site…</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.siteCode} · {s.name}</option>)}</Select>
          </Field>
          <Field label="Arm (optional)" error={errors.arm?.message}><Input {...register('arm')} /></Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Enrol</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
