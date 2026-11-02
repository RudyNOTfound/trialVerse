import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, MapPin, Plus } from 'lucide-react';
import { enrollmentsApi, trialsApi } from '@/api/trials';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDate, humanize } from '@/utils/format';
import { TRIAL_NEXT } from '@/utils/transitions';

export default function TrialDetailPage({ backTo = '/app/trials', readOnly = false }: { backTo?: string; readOnly?: boolean }) {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const [siteOpen, setSiteOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const trial = useQuery({ queryKey: ['trial', id], queryFn: () => trialsApi.get(id) });
  const sites = useQuery({ queryKey: ['trial-sites', id], queryFn: () => trialsApi.sites(id) });
  const enrollments = useQuery({ queryKey: ['enrollments', { trialId: id }], queryFn: () => enrollmentsApi.list({ trialId: id, pageSize: 100 }) });
  const setStatus = useMutation({
    mutationFn: (status: Parameters<typeof trialsApi.update>[1]['status']) => trialsApi.update(id, { status }),
    onSuccess: () => { setActionError(null); qc.invalidateQueries({ queryKey: ['trial', id] }); qc.invalidateQueries({ queryKey: ['trials'] }); qc.invalidateQueries({ queryKey: ['directory', 'trials'] }); },
    onError: setActionError,
  });

  if (trial.isLoading) return <Skeleton className="h-64 w-full" />;
  if (trial.error || !trial.data) return <Card><ErrorState error={trial.error} onRetry={() => trial.refetch()} /></Card>;
  const t = trial.data;
  const canEdit = !readOnly && hasRole('admin', 'coordinator');
  const sitePatients = (siteId: string) => enrollments.data?.items.filter((e) => e.trialSiteId === siteId).length ?? 0;

  return (
    <>
      <Link to={backTo} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />Trials</Link>
      <PageHeader title={t.title} description={`${t.code} · Phase ${t.phase} · ${t.sponsor}`} actions={<StatusBadge value={t.status} />} />
      {canEdit && TRIAL_NEXT[t.status].length > 0 && (
        <Card className="mb-6"><CardContent className="flex flex-wrap items-center gap-2 py-4">
          <span className="mr-2 text-sm text-muted">Move trial to:</span>
          {TRIAL_NEXT[t.status].map((s) => (
            <Button key={s} size="sm" variant={s === 'terminated' ? 'danger-outline' : 'outline'} loading={setStatus.isPending && setStatus.variables === s}
              onClick={() => { if (s !== 'terminated' || window.confirm('Terminate this trial? This cannot be undone.')) setStatus.mutate(s); }}>{humanize(s)}</Button>
          ))}
        </CardContent></Card>
      )}
      <div className="mb-4"><InlineError error={actionError} /></div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2"><CardHeader><CardTitle>About</CardTitle></CardHeader><CardContent className="text-sm text-slate-700">{t.description ?? <span className="text-muted">No description provided.</span>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Timeline</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted">Start</span><span className="font-medium">{formatDate(t.startDate)}</span></div>
          <div className="flex justify-between"><span className="text-muted">End</span><span className="font-medium">{formatDate(t.endDate)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Participants</span><span className="font-medium">{enrollments.data?.meta.total ?? '—'}</span></div>
        </CardContent></Card>
      </div>

      <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Sites</p>{canEdit && <Button size="sm" variant="outline" onClick={() => setSiteOpen(true)}><Plus className="h-4 w-4" />Add site</Button>}</div>
      <DataTable rows={sites.data} rowKey={(s) => s.id} loading={sites.isLoading} error={sites.error} emptyTitle="No sites yet" emptyDescription="Add a site before enrolling participants."
        columns={[
          { header: 'Code', cell: (s) => <span className="font-mono text-xs">{s.siteCode}</span> },
          { header: 'Site', cell: (s) => <span className="font-medium">{s.name}</span> },
          { header: 'Location', cell: (s) => <span className="flex items-center gap-1 text-muted"><MapPin className="h-3.5 w-3.5" />{[s.city, s.country].filter(Boolean).join(', ')}</span>, hideOnMobile: true },
          { header: 'Participants', cell: (s) => sitePatients(s.id), hideOnMobile: true },
          { header: 'Status', cell: (s) => <StatusBadge value={s.status} /> },
        ]} />

      <p className="mb-2 mt-6 text-sm font-semibold">Enrolled participants</p>
      <DataTable rows={enrollments.data?.items} rowKey={(e) => e.id} loading={enrollments.isLoading || dir.loading} error={enrollments.error} emptyTitle="No participants enrolled"
        onRowClick={readOnly ? undefined : (e) => nav(`/app/patients/${e.patientId}`)}
        columns={[
          { header: 'Patient', cell: (e) => <span className="font-medium">{dir.patientName(e.patientId)}</span> },
          { header: 'Site', cell: (e) => dir.siteName(e.trialSiteId), hideOnMobile: true },
          { header: 'Arm', cell: (e) => e.arm ?? '—', hideOnMobile: true },
          { header: 'Enrolled', cell: (e) => formatDate(e.enrolledAt), hideOnMobile: true },
          { header: 'Status', cell: (e) => <StatusBadge value={e.status} /> },
        ]} />
      <SiteDialog trialId={id} open={siteOpen} onOpenChange={setSiteOpen} />
    </>
  );
}

const siteSchema = z.object({
  siteCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, '2–20 letters, digits or dashes'),
  name: z.string().trim().min(1, 'Required').max(160),
  city: z.string().max(80), country: z.string().trim().min(2, 'Required').max(80),
});
type SiteValues = z.infer<typeof siteSchema>;

function SiteDialog({ trialId, open, onOpenChange }: { trialId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<SiteValues>({ resolver: zodResolver(siteSchema), defaultValues: { siteCode: '', name: '', city: '', country: '' } });
  const m = useMutation({
    mutationFn: (v: SiteValues) => trialsApi.addSite(trialId, { ...v, city: v.city || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['trial-sites', trialId] }); reset(); onOpenChange(false); },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="Add site">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Site code" error={errors.siteCode?.message}><Input placeholder="CHI-01" {...register('siteCode')} /></Field>
            <Field label="Site name" error={errors.name?.message}><Input {...register('name')} /></Field>
            <Field label="City (optional)" error={errors.city?.message}><Input {...register('city')} /></Field>
            <Field label="Country" error={errors.country?.message}><Input {...register('country')} /></Field>
          </div>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Add site</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
