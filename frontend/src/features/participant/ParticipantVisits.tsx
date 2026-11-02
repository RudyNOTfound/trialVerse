import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { visitsApi } from '@/api/visits';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { OtpPanel } from '@/features/visits/OtpPanel';
import { VisitStepper } from '@/features/visits/VisitStepper';
import { formatDateTime } from '@/utils/format';
import type { Visit } from '@/types/api';
import { useMyVisits } from './hooks';

export function ParticipantVisits() {
  const visits = useMyVisits();
  if (visits.isLoading) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  if (visits.error) return <Card><ErrorState error={visits.error} onRetry={() => visits.refetch()} /></Card>;
  const all = visits.data?.items ?? [];
  const upcoming = all.filter((v) => ['scheduled', 'otp_pending', 'verified'].includes(v.status));
  const past = all.filter((v) => !upcoming.includes(v)).reverse();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Your visits</h1>
      {all.length === 0 && <Card><EmptyState title="No visits yet" description="Your clinic will schedule visits for you." /></Card>}
      {upcoming.length > 0 && <Section title="Upcoming" visits={upcoming} />}
      {past.length > 0 && <Section title="History" visits={past} />}
    </div>
  );
}

function Section({ title, visits }: { title: string; visits: Visit[] }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-600">{title}</h2>
      <div className="space-y-2">
        {visits.map((v) => (
          <Link key={v.id} to={`/me/visits/${v.id}`}>
            <Card className="mb-2 flex items-center justify-between gap-3 p-4 transition-shadow hover:shadow-md">
              <div className="min-w-0"><p className="truncate text-sm font-medium">{v.visitType}</p><p className="text-xs text-muted">{formatDateTime(v.scheduledAt)}</p>{(v.trialCode || v.siteName) && <p className="truncate text-xs text-slate-500">{[v.trialCode, v.siteName].filter(Boolean).join(' · ')}</p>}</div>
              <div className="flex items-center gap-2"><StatusBadge value={v.status} /><ChevronRight className="h-4 w-4 text-slate-400" /></div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function ParticipantVisitDetail() {
  const { id = '' } = useParams();
  const visit = useQuery({ queryKey: ['visit', id], queryFn: () => visitsApi.get(id) });
  if (visit.isLoading) return <Skeleton className="h-72" />;
  if (visit.error || !visit.data) return <Card><ErrorState error={visit.error} onRetry={() => visit.refetch()} /></Card>;
  const v = visit.data;
  return (
    <div className="space-y-5">
      <Link to="/me/visits" className="inline-flex items-center gap-1 text-sm text-muted"><ArrowLeft className="h-4 w-4" />Visits</Link>
      <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">{v.visitType}</h1><p className="text-sm text-muted">{formatDateTime(v.scheduledAt)}</p>{(v.trialTitle || v.siteName) && <p className="mt-0.5 text-xs text-slate-500">{[v.trialTitle, v.siteName].filter(Boolean).join(' · ')}</p>}</div><StatusBadge value={v.status} /></div>
      <Card><CardContent className="py-5"><VisitStepper visit={v} /></CardContent></Card>
      <OtpPanel visit={v} mode="participant" />
      {v.notes && <Card className="p-4 text-sm"><p className="mb-1 text-xs text-muted">Notes</p>{v.notes}</Card>}
    </div>
  );
}
