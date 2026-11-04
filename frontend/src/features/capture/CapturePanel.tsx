import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { captureApi, REMINDER_CHANNELS, type Reminder } from '@/api/capture';
import { enrollmentsApi } from '@/api/trials';
import { visitsApi } from '@/api/visits';
import { InlineError } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { formatDateTime } from '@/utils/format';

/** A `datetime-local` value (browser local time) -> ISO-8601 with offset, as the API requires. */
export const localToIso = (v: string) => new Date(v).toISOString();
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const dash = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(n));

const optNum = z.string().refine((v) => v === '' || (Number(v) > 0 && Number.isFinite(Number(v))), 'Must be a positive number');
const num = (v: string) => (v === '' ? undefined : Number(v));

type Mode = 'staff' | 'participant';

/**
 * Data-capture workflows for one patient: measurements, ECG references, reminders and symptom (adverse-event) reports.
 * Who may write is enforced by the API (and mirrored here only to hide controls): measurements / ECGs - admin, coordinator, investigator;
 * reminders - admin, coordinator; symptom reports - staff and the participant themselves. ECGs are stored as a REFERENCE to a file
 * under the shared ECG directory: the project has no upload service, so nothing is uploaded here.
 */
export function CapturePanel({ patientId, mode }: { patientId: string; mode: Mode }) {
  const { hasRole } = useAuth();
  const canMeasure = mode === 'staff' && hasRole('admin', 'coordinator', 'investigator');
  const canRemind = mode === 'staff' && hasRole('admin', 'coordinator');
  const [dialog, setDialog] = useState<null | 'measurement' | 'ecg' | 'reminder' | 'symptom'>(null);
  const measurements = useQuery({ queryKey: ['capture', 'measurements', patientId], queryFn: () => captureApi.measurements(patientId) });
  const ecgs = useQuery({ queryKey: ['capture', 'ecgs', patientId], queryFn: () => captureApi.ecgs(patientId) });
  const reminders = useQuery({ queryKey: ['capture', 'reminders', patientId], queryFn: () => captureApi.reminders(patientId) });
  const events = useQuery({ queryKey: ['capture', 'adverse', patientId], queryFn: () => captureApi.adverseEvents(patientId) });
  const add = (label: string, key: NonNullable<typeof dialog>) => <Button size="sm" variant="outline" onClick={() => setDialog(key)}><Plus className="h-4 w-4" />{label}</Button>;

  return (
    <div className="space-y-6" data-testid="capture-panel">
      <Section title="Measurements" action={canMeasure && add('Record measurement', 'measurement')}>
        <DataTable rows={measurements.data?.items} rowKey={(m) => m.id} loading={measurements.isLoading} error={measurements.error} onRetry={() => measurements.refetch()} emptyTitle="No measurements recorded"
          columns={[
            { header: 'Taken', cell: (m) => formatDateTime(m.performedAt) },
            { header: 'BP (mmHg)', cell: (m) => `${dash(m.systolicBp)}/${dash(m.diastolicBp)}` },
            { header: 'HR (bpm)', cell: (m) => dash(m.heartRate), hideOnMobile: true },
            { header: 'Weight (kg)', cell: (m) => dash(m.weightKg), hideOnMobile: true },
            { header: 'Glucose (mg/dL)', cell: (m) => dash(m.glucoseMgDl), hideOnMobile: true },
          ]} />
      </Section>
      <Section title="ECG records" action={canMeasure && add('Register ECG', 'ecg')}>
        <DataTable rows={ecgs.data?.items} rowKey={(e) => e.id} loading={ecgs.isLoading} error={ecgs.error} onRetry={() => ecgs.refetch()} emptyTitle="No ECG records"
          columns={[
            { header: 'Recorded', cell: (e) => formatDateTime(e.recordedAt) },
            { header: 'Registered', cell: (e) => formatDateTime(e.createdAt), hideOnMobile: true },
            ...(mode === 'staff' ? [
              { header: 'File reference', cell: (e: { fileRef?: string }) => <code className="text-xs">{e.fileRef ?? '—'}</code> },
              { header: 'SHA-256', cell: (e: { fileSha256?: string | null }) => (e.fileSha256 ? <code className="text-xs" title={e.fileSha256}>{e.fileSha256.slice(0, 12)}…</code> : <span className="text-muted">not provided</span>), hideOnMobile: true },
            ] : []),
          ]} />
        {mode === 'staff' && <p className="mt-2 text-xs text-muted">Registers a reference to an image under the shared ECG directory; the image is not uploaded here. Re-used images are surfaced by the integrity scan as findings for review, not as proof of misconduct.</p>}
      </Section>
      <Section title="Reminders" action={canRemind && add('Log reminder', 'reminder')}>
        <DataTable rows={reminders.data?.items} rowKey={(r) => r.id} loading={reminders.isLoading} error={reminders.error} onRetry={() => reminders.refetch()} emptyTitle="No reminders logged"
          columns={[
            { header: 'Sent', cell: (r) => formatDateTime(r.sentAt) },
            { header: 'Channel', cell: (r) => <span className="uppercase">{r.channel}</span>, hideOnMobile: true },
            { header: 'Status', cell: (r) => <StatusBadge value={r.outcome} /> },
            { header: 'Acknowledged', cell: (r) => formatDateTime(r.acknowledgedAt), hideOnMobile: true },
            ...(canRemind ? [{ header: '', cell: (r: Reminder) => <ReminderActions reminder={r} patientId={patientId} /> }] : []),
          ]} />
        <p className="mt-2 text-xs text-muted">A reminder counts as missed when it was sent and not acknowledged within 24 hours. An empty history means no reminder data, not zero missed reminders.</p>
      </Section>
      <Section title="Symptoms & adverse events" action={add('Report symptom', 'symptom')}>
        <DataTable rows={events.data?.items} rowKey={(e) => e.id} loading={events.isLoading} error={events.error} onRetry={() => events.refetch()} emptyTitle="No reports"
          columns={[{ header: 'Reported', cell: (e) => formatDateTime(e.reportedAt) }, { header: 'Recorded', cell: (e) => formatDateTime(e.createdAt), hideOnMobile: true }]} />
      </Section>
      {dialog === 'measurement' && <MeasurementDialog patientId={patientId} onClose={() => setDialog(null)} />}
      {dialog === 'ecg' && <EcgDialog patientId={patientId} onClose={() => setDialog(null)} />}
      {dialog === 'reminder' && <ReminderDialog patientId={patientId} onClose={() => setDialog(null)} />}
      {dialog === 'symptom' && <SymptomDialog patientId={patientId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <Card><CardHeader className="flex-row items-center justify-between"><CardTitle>{title}</CardTitle>{action}</CardHeader><CardContent>{children}</CardContent></Card>;
}

function ReminderActions({ reminder, patientId }: { reminder: Reminder; patientId: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const m = useMutation({
    mutationFn: (outcome: 'acknowledged' | 'missed') => captureApi.resolveReminder(reminder.id, { outcome }),
    onSuccess: () => { toast.success('Reminder updated'); qc.invalidateQueries({ queryKey: ['capture', 'reminders', patientId] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  if (reminder.outcome !== 'sent') return null;
  return <div className="flex gap-2"><Button size="sm" variant="outline" loading={m.isPending && m.variables === 'acknowledged'} onClick={() => m.mutate('acknowledged')}>Acknowledged</Button><Button size="sm" variant="outline" loading={m.isPending && m.variables === 'missed'} onClick={() => m.mutate('missed')}>Missed</Button></div>;
}

/** Shared plumbing: a dialog with a form, a mutation, an inline API error, success toast and cache invalidation. */
function useCapture<V>(patientId: string, key: string, run: (v: V) => Promise<unknown>, onClose: () => void, success: string) {
  const qc = useQueryClient(); const toast = useToast(); const [error, setError] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: run,
    onSuccess: () => { toast.success(success); qc.invalidateQueries({ queryKey: ['capture', key, patientId] }); qc.invalidateQueries({ queryKey: ['visit-activity'] }); onClose(); },
    onError: setError,
  });
  return { m, error };
}

const useVisits = (patientId: string) => useQuery({ queryKey: ['visits', { patientId }], queryFn: () => visitsApi.list({ patientId, pageSize: 100, order: 'desc' }) });
const useEnrollments = (patientId: string) => useQuery({ queryKey: ['enrollments', { patientId }], queryFn: () => enrollmentsApi.list({ patientId, pageSize: 50 }) });

function VisitSelect({ patientId, register, error }: { patientId: string; register: ReturnType<typeof useForm<any>>['register']; error?: string }) {
  const visits = useVisits(patientId);
  return <Field label="Visit" error={error}><Select {...register('visitId')}><option value="">Select a visit…</option>{visits.data?.items.map((v) => <option key={v.id} value={v.id}>{v.visitType} · {formatDateTime(v.scheduledAt)} ({v.status})</option>)}</Select></Field>;
}

function Footer({ onClose, pending, label }: { onClose: () => void; pending: boolean; label: string }) {
  return <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={pending}>{label}</Button></div>;
}

const measurementSchema = z.object({ visitId: z.string().min(1, 'Select a visit'), performedAt: z.string().min(1, 'Required'), systolicBp: optNum, diastolicBp: optNum, heartRate: optNum, weightKg: optNum, glucoseMgDl: optNum })
  .refine((v) => [v.systolicBp, v.diastolicBp, v.heartRate, v.weightKg, v.glucoseMgDl].some((x) => x !== ''), { message: 'Enter at least one measurement', path: ['systolicBp'] });
type MeasurementValues = z.infer<typeof measurementSchema>;
function MeasurementDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<MeasurementValues>({ resolver: zodResolver(measurementSchema), defaultValues: { visitId: '', performedAt: nowLocal(), systolicBp: '', diastolicBp: '', heartRate: '', weightKg: '', glucoseMgDl: '' } });
  const { m, error } = useCapture<MeasurementValues>(patientId, 'measurements', (v) => captureApi.createMeasurement(patientId, {
    visitId: v.visitId, performedAt: localToIso(v.performedAt), systolicBp: num(v.systolicBp), diastolicBp: num(v.diastolicBp), heartRate: num(v.heartRate), weightKg: num(v.weightKg), glucoseMgDl: num(v.glucoseMgDl),
  }), onClose, 'Measurement recorded');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Record measurement" description="One measurement set per visit. Leave a field blank if it was not measured.">
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-3" noValidate>
        <VisitSelect patientId={patientId} register={register as never} error={errors.visitId?.message} />
        <Field label="Taken at" error={errors.performedAt?.message}><Input type="datetime-local" {...register('performedAt')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Systolic BP (mmHg)" error={errors.systolicBp?.message}><Input inputMode="decimal" {...register('systolicBp')} /></Field>
          <Field label="Diastolic BP (mmHg)" error={errors.diastolicBp?.message}><Input inputMode="decimal" {...register('diastolicBp')} /></Field>
          <Field label="Heart rate (bpm)" error={errors.heartRate?.message}><Input inputMode="decimal" {...register('heartRate')} /></Field>
          <Field label="Weight (kg)" error={errors.weightKg?.message}><Input inputMode="decimal" {...register('weightKg')} /></Field>
          <Field label="Glucose (mg/dL)" error={errors.glucoseMgDl?.message}><Input inputMode="decimal" {...register('glucoseMgDl')} /></Field>
        </div>
        <InlineError error={error} /><Footer onClose={onClose} pending={m.isPending} label="Save measurement" />
      </form></DialogContent></Dialog>
  );
}

const ecgSchema = z.object({
  visitId: z.string().min(1, 'Select a visit'),
  fileRef: z.string().min(1, 'Required').max(500)
    .refine((s) => !s.startsWith('/') && !s.startsWith('\\') && !/^[a-zA-Z]:/.test(s), 'Must be relative to the ECG directory (no absolute paths)')
    .refine((s) => !s.includes('\\') && !s.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'No empty, "." or ".." path segments'),
  fileSha256: z.string().refine((s) => s === '' || /^[0-9a-f]{64}$/.test(s), '64 lowercase hex characters'),
  recordedAt: z.string(),
});
type EcgValues = z.infer<typeof ecgSchema>;
function EcgDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<EcgValues>({ resolver: zodResolver(ecgSchema), defaultValues: { visitId: '', fileRef: '', fileSha256: '', recordedAt: '' } });
  const { m, error } = useCapture<EcgValues>(patientId, 'ecgs', (v) => captureApi.createEcg(patientId, { visitId: v.visitId, fileRef: v.fileRef, fileSha256: v.fileSha256 || undefined, recordedAt: v.recordedAt ? localToIso(v.recordedAt) : undefined }), onClose, 'ECG registered');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Register ECG" description="Registers a reference to an ECG image in the shared ECG directory. One ECG per visit.">
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-3" noValidate>
        <VisitSelect patientId={patientId} register={register as never} error={errors.visitId?.message} />
        <Field label="File reference" hint="Path relative to the ECG directory, e.g. ecgs/SITE-A/P-A-001.png" error={errors.fileRef?.message}><Input {...register('fileRef')} /></Field>
        <Field label="SHA-256 (optional)" error={errors.fileSha256?.message}><Input {...register('fileSha256')} /></Field>
        <Field label="Recorded at (optional)"><Input type="datetime-local" {...register('recordedAt')} /></Field>
        <InlineError error={error} /><Footer onClose={onClose} pending={m.isPending} label="Register ECG" />
      </form></DialogContent></Dialog>
  );
}

const reminderSchema = z.object({ enrollmentId: z.string().min(1, 'Select an enrollment'), channel: z.enum(REMINDER_CHANNELS), sentAt: z.string().min(1, 'Required') });
type ReminderValues = z.infer<typeof reminderSchema>;
function ReminderDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const enrollments = useEnrollments(patientId);
  const { register, handleSubmit, formState: { errors } } = useForm<ReminderValues>({ resolver: zodResolver(reminderSchema), defaultValues: { enrollmentId: '', channel: 'sms', sentAt: nowLocal() } });
  const { m, error } = useCapture<ReminderValues>(patientId, 'reminders', (v) => captureApi.createReminder(patientId, { enrollmentId: v.enrollmentId, channel: v.channel, sentAt: localToIso(v.sentAt) }), onClose, 'Reminder logged');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Log reminder" description="Records a reminder that was sent. Resolve it afterwards as acknowledged or missed.">
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-3" noValidate>
        <Field label="Enrollment" error={errors.enrollmentId?.message}><Select {...register('enrollmentId')}><option value="">Select…</option>{enrollments.data?.items.map((e) => <option key={e.id} value={e.id}>{e.trialCode ?? 'Trial'} · {e.siteName ?? 'Site'}</option>)}</Select></Field>
        <Field label="Channel"><Select {...register('channel')}>{REMINDER_CHANNELS.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</Select></Field>
        <Field label="Sent at" error={errors.sentAt?.message}><Input type="datetime-local" {...register('sentAt')} /></Field>
        <InlineError error={error} /><Footer onClose={onClose} pending={m.isPending} label="Log reminder" />
      </form></DialogContent></Dialog>
  );
}

const symptomSchema = z.object({ enrollmentId: z.string().min(1, 'Select an enrollment'), visitId: z.string(), reportedAt: z.string().min(1, 'Required') });
type SymptomValues = z.infer<typeof symptomSchema>;
function SymptomDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const enrollments = useEnrollments(patientId); const visits = useVisits(patientId);
  const { register, handleSubmit, formState: { errors } } = useForm<SymptomValues>({ resolver: zodResolver(symptomSchema), defaultValues: { enrollmentId: '', visitId: '', reportedAt: nowLocal() } });
  const { m, error } = useCapture<SymptomValues>(patientId, 'adverse', (v) => captureApi.reportAdverseEvent(patientId, { enrollmentId: v.enrollmentId, visitId: v.visitId || undefined, reportedAt: localToIso(v.reportedAt) }), onClose, 'Report recorded');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Report a symptom" description="Records that a symptom or side effect was reported, and when. For anything urgent, contact the clinic directly.">
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-3" noValidate>
        <Field label="Trial enrollment" error={errors.enrollmentId?.message}><Select {...register('enrollmentId')}><option value="">Select…</option>{enrollments.data?.items.map((e) => <option key={e.id} value={e.id}>{e.trialCode ?? 'Trial'} · {e.siteName ?? 'Site'}</option>)}</Select></Field>
        <Field label="Related visit (optional)"><Select {...register('visitId')}><option value="">None</option>{visits.data?.items.map((v) => <option key={v.id} value={v.id}>{v.visitType} · {formatDateTime(v.scheduledAt)}</option>)}</Select></Field>
        <Field label="Reported at" error={errors.reportedAt?.message}><Input type="datetime-local" {...register('reportedAt')} /></Field>
        <InlineError error={error} /><Footer onClose={onClose} pending={m.isPending} label="Submit report" />
      </form></DialogContent></Dialog>
  );
}
