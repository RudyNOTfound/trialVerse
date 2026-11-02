import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, FlaskConical, ListChecks, Receipt, ShieldQuestion, Users } from 'lucide-react';
import { patientsApi } from '@/api/patients';
import { enrollmentsApi, trialsApi } from '@/api/trials';
import { visitsApi } from '@/api/visits';
import { actionsApi } from '@/api/actions';
import { reimbursementsApi } from '@/api/reimbursements';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDateTime, relativeTime } from '@/utils/format';
import type { Visit } from '@/types/api';

const total = <T,>(p: Promise<{ meta: { total: number } } & { items: T[] }>) => p.then((r) => r.meta.total);

export default function OverviewPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const dir = useDirectory();
  const q = (key: string, fn: () => Promise<number>) => useQuery({ queryKey: ['overview', key], queryFn: fn });
  const patients = q('patients', () => total(patientsApi.list({ pageSize: 1 })));
  const trials = q('trials', () => total(trialsApi.list({ status: 'active', pageSize: 1 })));
  const enrolled = q('enrolled', () => total(enrollmentsApi.list({ status: 'enrolled', pageSize: 1 })));
  const awaiting = q('awaiting', () => total(visitsApi.list({ status: 'otp_pending', pageSize: 1 })));
  const toComplete = q('verified', () => total(visitsApi.list({ status: 'verified', pageSize: 1 })));
  const overdue = q('overdue', () => total(actionsApi.list({ status: 'overdue', pageSize: 1 })));
  const pendingReimb = q('reimb', () => total(reimbursementsApi.list({ status: 'pending', pageSize: 1 })));

  const upcoming = useQuery({
    queryKey: ['overview', 'upcoming'],
    queryFn: () => visitsApi.list({ from: new Date().toISOString(), sort: 'scheduledAt', order: 'asc', pageSize: 8 }),
  });
  const open = (items: Visit[]) => items.filter((v) => v.status === 'scheduled' || v.status === 'otp_pending' || v.status === 'verified');

  return (
    <>
      <PageHeader title={`Welcome back, ${user?.fullName.split(' ')[0] ?? ''}`} description="Operational snapshot across your trials and sites." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Patients" value={patients.data} icon={Users} to="/app/patients" loading={patients.isLoading} />
        <StatCard label="Active trials" value={trials.data} icon={FlaskConical} to="/app/trials" loading={trials.isLoading} />
        <StatCard label="Enrolled participants" value={enrolled.data} icon={Users} tone="green" to="/app/enrollments" loading={enrolled.isLoading} />
        <StatCard label="Awaiting OTP verification" value={awaiting.data} icon={ShieldQuestion} tone="amber" to="/app/visits" hint="OTP issued, not yet verified" loading={awaiting.isLoading} />
        <StatCard label="Verified, ready to complete" value={toComplete.data} icon={CalendarCheck} to="/app/visits" hint="Investigator completes the visit" loading={toComplete.isLoading} />
        <StatCard label="Overdue actions" value={overdue.data} icon={ListChecks} tone="red" to="/app/actions" loading={overdue.isLoading} />
        <StatCard label="Pending reimbursements" value={pendingReimb.data} icon={Receipt} tone="amber" to="/app/reimbursements" loading={pendingReimb.isLoading} />
      </div>

      <div className="mt-8">
        <Card className="mb-0 border-0 bg-transparent shadow-none">
          <CardHeader className="border-0 px-0 pt-0"><div><CardTitle>Upcoming visits</CardTitle><CardDescription>Next scheduled visits from now.</CardDescription></div></CardHeader>
        </Card>
        <DataTable
          rows={upcoming.data ? open(upcoming.data.items) : undefined} rowKey={(v) => v.id} loading={upcoming.isLoading} error={upcoming.error} onRetry={() => upcoming.refetch()}
          onRowClick={(v) => nav(`/app/visits/${v.id}`)} emptyTitle="No upcoming visits" emptyDescription="Scheduled visits will appear here."
          columns={[
            { header: 'Patient', cell: (v) => <span className="font-medium">{dir.patientName(v.patientId)}</span> },
            { header: 'Visit', cell: (v) => v.visitType },
            { header: 'Trial', cell: (v) => dir.trialCode(v.trialId), hideOnMobile: true },
            { header: 'When', cell: (v) => <span title={formatDateTime(v.scheduledAt)}>{relativeTime(v.scheduledAt)}</span> },
            { header: 'Status', cell: (v) => <StatusBadge value={v.status} /> },
          ]}
        />
      </div>
    </>
  );
}
