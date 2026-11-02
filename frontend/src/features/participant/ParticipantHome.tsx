import { Link } from 'react-router-dom';
import { CalendarClock, ChevronRight, KeyRound, Receipt, ClipboardList } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { useAuth } from '@/contexts/AuthContext';
import { formatDateTime, formatMoney, relativeTime } from '@/utils/format';
import { useMyEnrollments, useMyPatient, useMyReimbursements, useMyVisits } from './hooks';

export default function ParticipantHome() {
  const { user } = useAuth();
  const patient = useMyPatient();
  const enrollments = useMyEnrollments();
  const visits = useMyVisits();
  const reimbs = useMyReimbursements();

  if (patient.error) return <Card><ErrorState error={patient.error} onRetry={() => patient.refetch()} /></Card>;
  if (patient.isSuccess && !patient.data) return null;

  const open = (visits.data?.items ?? []).filter((v) => ['scheduled', 'otp_pending', 'verified'].includes(v.status));
  // Prefer a visit that needs the participant's code, then the soonest future visit, then any open (overdue) visit.
  const now = Date.now();
  const next = open.find((v) => v.status === 'otp_pending') ?? open.find((v) => new Date(v.scheduledAt).getTime() >= now) ?? open[0];
  const pendingClaims = (reimbs.data?.items ?? []).filter((r) => r.status === 'pending').length;
  const enrolled = (enrollments.data?.items ?? []).filter((e) => e.status === 'enrolled' || e.status === 'screening');

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted">Hello,</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{patient.data?.firstName ?? user?.fullName.split(' ')[0]}</h1>
      </div>

      <Card className="overflow-hidden border-0 bg-gradient-to-br from-navy-900 to-navy-700 text-white">
        <CardContent className="p-5">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-blue-200"><CalendarClock className="h-4 w-4" />{next?.status === 'otp_pending' ? 'Action needed' : 'Next visit'}</p>
          {visits.isLoading ? <Skeleton className="mt-3 h-12 bg-white/20" /> : next ? (
            <>
              <p className="mt-2 text-xl font-semibold">{next.visitType}</p>
              <p className="text-sm text-blue-100">{formatDateTime(next.scheduledAt)} · {relativeTime(next.scheduledAt)}{next.status === 'verified' ? ' · verified, awaiting completion' : ''}</p>
              <Link to={`/me/visits/${next.id}`} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-navy-900">
                {next.status === 'otp_pending' ? <><KeyRound className="h-4 w-4" />Enter your code</> : 'View visit'}<ChevronRight className="h-4 w-4" />
              </Link>
            </>
          ) : <p className="mt-2 text-sm text-blue-100">You have no upcoming visits.</p>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Link to="/me/visits"><Card className="p-4"><ClipboardList className="h-5 w-5 text-brand-600" /><p className="mt-3 text-2xl font-semibold">{visits.isLoading ? '–' : open.length}</p><p className="text-xs text-muted">Upcoming visits</p></Card></Link>
        <Link to="/me/reimbursements"><Card className="p-4"><Receipt className="h-5 w-5 text-brand-600" /><p className="mt-3 text-2xl font-semibold">{reimbs.isLoading ? '–' : pendingClaims}</p><p className="text-xs text-muted">Claims awaiting review</p></Card></Link>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Your enrollment</h2>
        {enrollments.isLoading ? <Skeleton className="h-20" /> : enrolled.length === 0 ? (
          <Card className="p-4 text-sm text-muted">You are not currently enrolled in a trial.</Card>
        ) : enrolled.map((e) => (
          <Card key={e.id} className="mb-2 flex items-center justify-between p-4">
            <div><p className="text-sm font-medium">{e.arm ? `Study arm: ${e.arm}` : 'Clinical trial participation'}</p><p className="text-xs text-muted">{e.enrolledAt ? `Enrolled ${formatDateTime(e.enrolledAt)}` : 'Screening in progress'}</p></div>
            <StatusBadge value={e.status} />
          </Card>
        ))}
      </section>

      {reimbs.data?.items[0] && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Latest claim</h2>
          <Link to="/me/reimbursements"><Card className="flex items-center justify-between p-4"><div><p className="text-sm font-medium capitalize">{reimbs.data.items[0].category}</p><p className="text-xs text-muted">{formatMoney(reimbs.data.items[0].amountCents, reimbs.data.items[0].currency)}</p></div><StatusBadge value={reimbs.data.items[0].status} /></Card></Link>
        </section>
      )}
    </div>
  );
}
