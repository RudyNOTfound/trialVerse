import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MapPin, Pencil, Power } from 'lucide-react';
import { enrollmentsApi, trialsApi } from '@/api/trials';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/utils/format';
import { SiteFormDialog } from './SiteFormDialog';

export default function SiteDetailPage({ base = '/app/trials', readOnly = false }: { base?: string; readOnly?: boolean }) {
  const { id = '', siteId = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { hasRole } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const site = useQuery({ queryKey: ['trial-site', id, siteId], queryFn: () => trialsApi.site(id, siteId) });
  const trial = useQuery({ queryKey: ['trial', id], queryFn: () => trialsApi.get(id) });
  const enrollments = useQuery({ queryKey: ['enrollments', { trialSiteId: siteId }], queryFn: () => enrollmentsApi.list({ trialSiteId: siteId, pageSize: 100 }) });
  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'inactive') => trialsApi.updateSite(id, siteId, { status }),
    onSuccess: (s) => { toast.success(`Site ${s.status === 'active' ? 'reactivated' : 'deactivated'}`); for (const k of ['trial-site', 'trial-sites', 'directory']) qc.invalidateQueries({ queryKey: [k] }); },
  });

  if (site.isLoading) return <Skeleton className="h-64 w-full" />;
  if (site.error || !site.data) return <Card><ErrorState error={site.error} onRetry={() => site.refetch()} /></Card>;
  const s = site.data;
  const canEdit = !readOnly && hasRole('admin', 'coordinator');

  return (
    <>
      <Link to={`${base}/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />{trial.data?.code ?? 'Trial'}</Link>
      <PageHeader title={s.name} description={`${s.siteCode} · ${[s.city, s.country].filter(Boolean).join(', ')}`}
        actions={<>
          <StatusBadge value={s.status} />
          {canEdit && <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>}
          {canEdit && (s.status === 'active'
            ? <Button variant="danger-outline" onClick={() => setDeactivating(true)}><Power className="h-4 w-4" />Deactivate</Button>
            : s.status === 'inactive' && <Button variant="outline" loading={setStatus.isPending} onClick={() => setStatus.mutate('active')}><Power className="h-4 w-4" />Reactivate</Button>)}
        </>} />
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Site information</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
          <Row k="Trial" v={<Link className="text-brand-700 hover:underline" to={`${base}/${id}`}>{trial.data ? `${trial.data.code} · ${trial.data.title}` : '…'}</Link>} />
          <Row k="Location" v={<span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-slate-400" />{[s.city, s.country].filter(Boolean).join(', ')}</span>} />
          <Row k="Principal investigator" v={s.principalInvestigatorId ? s.principalInvestigatorName ?? 'Unknown' : 'Not assigned'} />
          <Row k="Created" v={formatDate(s.createdAt)} /><Row k="Last updated" v={formatDate(s.updatedAt)} />
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Enrollment at this site</CardTitle></CardHeader><CardContent className="grid grid-cols-3 gap-3 text-center">
          {(['screening', 'enrolled', 'completed'] as const).map((st) => (
            <div key={st} className="rounded-lg bg-slate-50 p-3"><p className="text-2xl font-semibold tabular-nums">{enrollments.data?.items.filter((e) => e.status === st).length ?? '–'}</p><p className="text-xs capitalize text-muted">{st}</p></div>
          ))}
        </CardContent></Card>
      </div>
      <p className="mb-2 text-sm font-semibold">Participants</p>
      <DataTable rows={enrollments.data?.items} rowKey={(e) => e.id} loading={enrollments.isLoading} error={enrollments.error} emptyTitle="No participants at this site"
        onRowClick={readOnly ? undefined : (e) => nav(`/app/patients/${e.patientId}`)}
        columns={[
          { header: 'Patient', cell: (e) => <span className="font-medium">{e.patientName ?? '—'}</span> },
          { header: 'Arm', cell: (e) => e.arm ?? '—', hideOnMobile: true },
          { header: 'Enrolled', cell: (e) => formatDate(e.enrolledAt), hideOnMobile: true },
          { header: 'Status', cell: (e) => <StatusBadge value={e.status} /> },
        ]} />
      <SiteFormDialog trialId={id} open={editing} onOpenChange={setEditing} site={s} />
      <ConfirmDialog open={deactivating} onOpenChange={setDeactivating} title="Deactivate this site?" description="No new patients can be enrolled at an inactive site. Existing enrollments and visits are unaffected. You can reactivate it later."
        confirmLabel="Deactivate" onConfirm={() => setStatus.mutateAsync('inactive')} />
    </>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-center justify-between gap-4"><span className="text-muted">{k}</span><span className="text-right font-medium text-ink">{v}</span></div>;
