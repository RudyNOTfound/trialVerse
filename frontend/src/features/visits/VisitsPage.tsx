import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { enrollmentsApi } from '@/api/trials';
import { visitsApi } from '@/api/visits';
import { fetchAll } from '@/api/fetchAll';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { InlineError } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDateTime } from '@/utils/format';
import type { VisitStatus } from '@/types/api';

export default function VisitsPage() {
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const [status, setStatus] = useState('');
  const [patientId, setPatientId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const filters = { page, pageSize: 15, status: (status || undefined) as VisitStatus | undefined, patientId: patientId || undefined, sort: 'scheduledAt' as const, order: 'desc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['visits', filters], queryFn: () => visitsApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Visits" description="Schedule visits and run OTP verification at check-in."
        actions={hasRole('admin', 'coordinator') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Schedule visit</Button>} />
      <FilterBar>
        <FilterSelect value={patientId} onChange={(v) => { setPatientId(v); setPage(1); }} options={dir.patients.map((p) => ({ value: p.id, label: `${p.subjectCode} · ${p.firstName} ${p.lastName}` }))} allLabel="All patients" label="Filter by patient" />
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['scheduled', 'otp_pending', 'verified', 'completed', 'missed', 'cancelled']} allLabel="All statuses" label="Filter by status" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading || dir.loading} error={error} onRetry={() => refetch()} rowKey={(v) => v.id} onRowClick={(v) => nav(`/app/visits/${v.id}`)}
        emptyTitle="No visits found" emptyDescription="Schedule a visit for an enrolled patient."
        columns={[
          { header: 'Patient', cell: (v) => <span className="font-medium">{dir.patientName(v.patientId)}</span> },
          { header: 'Visit', cell: (v) => v.visitType },
          { header: 'Trial', cell: (v) => dir.trialCode(v.trialId), hideOnMobile: true },
          { header: 'Site', cell: (v) => dir.siteName(v.trialSiteId), hideOnMobile: true },
          { header: 'Scheduled', cell: (v) => formatDateTime(v.scheduledAt) },
          { header: 'Status', cell: (v) => <StatusBadge value={v.status} /> },
        ]} />
      <ScheduleVisitDialog open={creating} onOpenChange={setCreating} onCreated={(id) => nav(`/app/visits/${id}`)} />
    </>
  );
}

const schema = z.object({ enrollmentId: z.string().min(1, 'Select an enrollment'), visitType: z.string().trim().min(1, 'Required').max(60), scheduledAt: z.string().min(1, 'Pick a date and time'), notes: z.string().max(2000) });
type Values = z.infer<typeof schema>;

function ScheduleVisitDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [error, setError] = useState<unknown>(null);
  const enrollments = useQuery({ queryKey: ['enrollments', 'schedulable'], enabled: open, queryFn: () => fetchAll((page) => enrollmentsApi.list({ page, pageSize: 100 })) });
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { enrollmentId: '', visitType: '', scheduledAt: '', notes: '' } });
  const m = useMutation({
    // datetime-local has no zone; convert to an absolute ISO instant as the API requires.
    mutationFn: (v: Values) => visitsApi.create({ enrollmentId: v.enrollmentId, visitType: v.visitType, scheduledAt: new Date(v.scheduledAt).toISOString(), notes: v.notes || undefined }),
    onSuccess: (visit) => { qc.invalidateQueries({ queryKey: ['visits'] }); qc.invalidateQueries({ queryKey: ['overview'] }); reset(); onOpenChange(false); onCreated(visit.id); },
    onError: setError,
  });
  const usable = (enrollments.data ?? []).filter((e) => e.status === 'screening' || e.status === 'enrolled');
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="Schedule visit">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Patient enrollment" error={errors.enrollmentId?.message} hint={!enrollments.isLoading && !usable.length ? 'No active enrollments. Enrol a patient first.' : undefined}>
            <Select {...register('enrollmentId')}><option value="">Select enrollment…</option>
              {usable.map((e) => <option key={e.id} value={e.id}>{dir.patientName(e.patientId)} · {dir.trialCode(e.trialId)} ({e.status})</option>)}</Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visit type" error={errors.visitType?.message}><Input placeholder="Week 4" {...register('visitType')} /></Field>
            <Field label="Date & time" error={errors.scheduledAt?.message}><Input type="datetime-local" {...register('scheduledAt')} /></Field>
          </div>
          <Field label="Notes (optional)" error={errors.notes?.message}><Textarea {...register('notes')} /></Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Schedule</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
