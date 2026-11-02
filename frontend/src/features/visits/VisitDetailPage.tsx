import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCheck, CalendarX, Ban } from 'lucide-react';
import { visitsApi } from '@/api/visits';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDateTime } from '@/utils/format';
import { VISIT_NEXT } from '@/utils/transitions';
import { OtpPanel } from './OtpPanel';
import { VisitStepper } from './VisitStepper';

export default function VisitDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const [error, setError] = useState<unknown>(null);
  const visit = useQuery({ queryKey: ['visit', id], queryFn: () => visitsApi.get(id) });
  const setStatus = useMutation({
    mutationFn: (status: 'completed' | 'missed' | 'cancelled') => visitsApi.setStatus(id, status),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['visit', id] }); qc.invalidateQueries({ queryKey: ['visits'] }); qc.invalidateQueries({ queryKey: ['overview'] }); },
    onError: setError,
  });

  if (visit.isLoading) return <Skeleton className="h-96 w-full" />;
  if (visit.error || !visit.data) return <Card><ErrorState error={visit.error} onRetry={() => visit.refetch()} /></Card>;
  const v = visit.data;
  const next = VISIT_NEXT[v.status];
  // Only investigators / admins close a visit; the server rejects coordinators with 403.
  const canComplete = next.includes('completed') && hasRole('admin', 'investigator');
  const confirmThen = (s: 'missed' | 'cancelled') => { if (window.confirm(`Mark this visit as ${s}? This cannot be undone.`)) setStatus.mutate(s); };

  return (
    <>
      <Link to="/app/visits" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />Visits</Link>
      <PageHeader title={`${v.visitType} · ${dir.patientName(v.patientId)}`} description={`${dir.trialCode(v.trialId)} · ${dir.siteName(v.trialSiteId)}`} actions={<StatusBadge value={v.status} />} />
      <Card className="mb-6"><CardContent className="py-6"><VisitStepper visit={v} /></CardContent></Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <OtpPanel visit={v} mode="staff" />
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Visit details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row k="Patient" v={<Link className="text-brand-700 hover:underline" to={`/app/patients/${v.patientId}`}>{dir.patientName(v.patientId)}</Link>} />
              <Row k="Scheduled" v={formatDateTime(v.scheduledAt)} />
              <Row k="OTP issued" v={formatDateTime(v.otpIssuedAt)} />
              <Row k="Verified" v={v.verifiedAt ? `${formatDateTime(v.verifiedAt)} by ${dir.userName(v.verifiedBy)}` : '—'} />
              <Row k="Completed" v={formatDateTime(v.completedAt)} />
              {v.notes && <Row k="Notes" v={v.notes} />}
            </CardContent>
          </Card>
          {next.length > 0 && hasRole('admin', 'coordinator', 'investigator') && (
            <Card>
              <CardHeader><CardTitle>Visit outcome</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {v.status === 'verified' && !canComplete && <p className="text-sm text-muted">Verified. An investigator or administrator must complete this visit.</p>}
                {v.status !== 'verified' && next.includes('verified') && <p className="text-sm text-muted">Completion unlocks after the participant's OTP is verified.</p>}
                <div className="flex flex-wrap gap-2">
                  {canComplete && <Button variant="navy" loading={setStatus.isPending && setStatus.variables === 'completed'} onClick={() => setStatus.mutate('completed')}><CheckCheck className="h-4 w-4" />Mark completed</Button>}
                  {next.includes('missed') && <Button variant="outline" onClick={() => confirmThen('missed')}><CalendarX className="h-4 w-4" />Mark missed</Button>}
                  {next.includes('cancelled') && <Button variant="danger-outline" onClick={() => confirmThen('cancelled')}><Ban className="h-4 w-4" />Cancel visit</Button>}
                </div>
                <InlineError error={error} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-start justify-between gap-4"><span className="text-muted">{k}</span><span className="text-right font-medium text-ink">{v}</span></div>;
