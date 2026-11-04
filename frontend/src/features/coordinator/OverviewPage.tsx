import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, FlaskConical, ListChecks, Receipt, ShieldQuestion, Users } from 'lucide-react';
import { statsApi } from '@/api/stats';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { formatDateTime, relativeTime } from '@/utils/format';

/** Two aggregate requests (counts + upcoming visits) replace the previous seven list queries. */
export default function OverviewPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const ops = useQuery({ queryKey: ['overview', 'operations'], queryFn: statsApi.operations });
  const visits = useQuery({ queryKey: ['overview', 'visits'], queryFn: () => statsApi.visits({ limit: 8 }) });
  const s = ops.data;

  return (
    <>
      <PageHeader title={`Welcome back, ${user?.fullName.split(' ')[0] ?? ''}`} description="Operational snapshot across your trials and sites." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Patients" value={s?.patients.total} icon={Users} to="/app/patients" loading={ops.isLoading} />
        <StatCard label="Active trials" value={s?.trials.byStatus.active} icon={FlaskConical} to="/app/trials" loading={ops.isLoading} />
        <StatCard label="Enrolled participants" value={s?.enrollments.byStatus.enrolled} icon={Users} tone="green" to="/app/enrollments" loading={ops.isLoading} />
        <StatCard label="Awaiting OTP verification" value={s?.visits.byStatus.otp_pending} icon={ShieldQuestion} tone="amber" to="/app/visits" hint="OTP issued, not yet verified" loading={ops.isLoading} />
        <StatCard label="Verified, ready to complete" value={s?.visits.byStatus.verified} icon={CalendarCheck} to="/app/visits" hint="Investigator completes the visit" loading={ops.isLoading} />
        <StatCard label="Overdue actions" value={s?.actions.overdue} icon={ListChecks} tone="red" to="/app/actions" loading={ops.isLoading} />
        <StatCard label="Pending reimbursements" value={s?.reimbursements.byStatus.pending} icon={Receipt} tone="amber" to="/app/reimbursements" loading={ops.isLoading} />
      </div>
      {ops.error && <p role="alert" className="mt-4 text-sm text-red-600">Could not load statistics: {(ops.error as Error).message}</p>}

      <div className="mt-8">
        <Card className="mb-0 border-0 bg-transparent shadow-none">
          <CardHeader className="border-0 px-0 pt-0"><div><CardTitle>Upcoming visits</CardTitle><CardDescription>{visits.data ? `${visits.data.upcomingInWindow} in the next ${visits.data.windowDays} days` : 'Next scheduled visits from now.'}</CardDescription></div></CardHeader>
        </Card>
        <DataTable
          rows={visits.data?.upcoming} rowKey={(v) => v.id} loading={visits.isLoading} error={visits.error} onRetry={() => visits.refetch()}
          onRowClick={(v) => nav(`/app/visits/${v.id}`)} emptyTitle="No upcoming visits" emptyDescription="Scheduled visits will appear here."
          columns={[
            { header: 'Patient', cell: (v) => <span className="font-medium">{v.patientName ?? '—'}</span> },
            { header: 'Visit', cell: (v) => v.visitType },
            { header: 'Trial', cell: (v) => v.trialCode ?? '—', hideOnMobile: true },
            { header: 'When', cell: (v) => <span title={formatDateTime(v.scheduledAt)}>{relativeTime(v.scheduledAt)}</span> },
            { header: 'Status', cell: (v) => <StatusBadge value={v.status} /> },
          ]}
        />
      </div>
    </>
  );
}
