import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/utils/format';
import { useMyEnrollments, useMyPatient } from './hooks';

export default function ParticipantProfile() {
  const { user, logout } = useAuth();
  const patient = useMyPatient();
  const enrollments = useMyEnrollments();
  if (patient.isLoading) return <Skeleton className="h-64" />;
  if (patient.error || !patient.data) return <Card><ErrorState error={patient.error} onRetry={() => patient.refetch()} /></Card>;
  const p = patient.data;
  const row = (k: string, v: React.ReactNode) => <div className="flex items-center justify-between gap-4 text-sm"><span className="text-muted">{k}</span><span className="text-right font-medium">{v}</span></div>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      <Card><CardHeader><CardTitle>{p.firstName} {p.lastName}</CardTitle><StatusBadge value={p.status} /></CardHeader>
        <CardContent className="space-y-3">{row('Subject code', <span className="font-mono">{p.subjectCode}</span>)}{row('Date of birth', formatDate(p.dateOfBirth))}{row('Sex', <span className="capitalize">{p.sex}</span>)}{row('Email', p.email ?? user?.email ?? '—')}{row('Phone', p.phone ?? '—')}</CardContent></Card>
      <Card><CardHeader><CardTitle>Enrollment</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {enrollments.isLoading ? <Skeleton className="h-10" /> : enrollments.data?.items.length ? enrollments.data.items.map((e) => <div key={e.id} className="space-y-2">{row('Trial', e.trialTitle ? `${e.trialCode} · ${e.trialTitle}` : '—')}{row('Site', e.siteName ?? '—')}{row('Status', <StatusBadge value={e.status} />)}{row('Study arm', e.arm ?? '—')}{row('Enrolled', formatDate(e.enrolledAt))}{e.endedAt && row('Ended', formatDate(e.endedAt))}</div>) : <p className="text-sm text-muted">Not enrolled in a trial.</p>}
        </CardContent></Card>
      <p className="text-center text-xs text-muted">To change your details, contact your clinic coordinator.</p>
      <button onClick={logout} className="w-full rounded-lg border border-line bg-white py-2.5 text-sm font-medium text-slate-700 sm:hidden">Log out</button>
    </div>
  );
}
