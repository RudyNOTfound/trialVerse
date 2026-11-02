import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, FlaskConical, ScrollText, ShieldAlert } from 'lucide-react';
import { integrityApi } from '@/api/integrity';
import { riskApi } from '@/api/risk';
import { trialsApi } from '@/api/trials';
import { CountBars, LEVEL_COLORS } from '@/components/charts/Charts';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/utils/format';
import type { RiskLevel } from '@/types/api';

const LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export default function SponsorOverview() {
  const activeTrials = useQuery({ queryKey: ['sponsor', 'trials-active'], queryFn: () => trialsApi.list({ status: 'active', pageSize: 1 }).then((r) => r.meta.total) });
  const openAlerts = useQuery({ queryKey: ['sponsor', 'alerts-open'], queryFn: () => integrityApi.alerts({ status: 'open', pageSize: 1 }).then((r) => r.meta.total) });
  const alertSeverity = useQuery({ queryKey: ['sponsor', 'alerts-by-severity'], queryFn: async () => Promise.all(LEVELS.map(async (l) => ({ name: l, value: (await integrityApi.alerts({ severity: l, status: 'open', pageSize: 1 })).meta.total }))) });
  const riskByLevel = useQuery({ queryKey: ['sponsor', 'risk-by-level'], queryFn: async () => Promise.all(LEVELS.map(async (l) => ({ name: l, value: (await riskApi.list({ level: l, entityType: 'patient', pageSize: 1 })).meta.total }))) });
  const highRisk = useQuery({ queryKey: ['sponsor', 'high-risk'], queryFn: async () => (await Promise.all((['high', 'critical'] as const).map((l) => riskApi.list({ level: l, pageSize: 1 })))).reduce((n, r) => n + r.meta.total, 0) });
  const latestAlerts = useQuery({ queryKey: ['sponsor', 'latest-alerts'], queryFn: () => integrityApi.alerts({ status: 'open', sort: 'severity', order: 'desc', pageSize: 5 }) });

  return (
    <>
      <PageHeader title="Sponsor overview" description="Risk and integrity oversight across trials. All figures come from the baseline rule engines." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active trials" value={activeTrials.data} icon={FlaskConical} to="/sponsor/trials" loading={activeTrials.isLoading} />
        <StatCard label="High / critical assessments" value={highRisk.data} icon={Activity} tone="red" to="/sponsor/risk" hint="Patients, visits and reimbursements" loading={highRisk.isLoading} />
        <StatCard label="Open integrity alerts" value={openAlerts.data} icon={ShieldAlert} tone="amber" to="/sponsor/integrity" loading={openAlerts.isLoading} />
        <StatCard label="Audit chain" value="Verify" icon={ScrollText} tone="green" to="/sponsor/audit" hint="Run verification on demand" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card><CardHeader><div><CardTitle>Open alerts by severity</CardTitle><CardDescription>Unresolved integrity alerts</CardDescription></div></CardHeader>
          <div className="p-4">{alertSeverity.data ? <CountBars data={alertSeverity.data} colors={LEVEL_COLORS} /> : <div className="h-[220px]" />}</div></Card>
        <Card><CardHeader><div><CardTitle>Patient risk assessments by level</CardTitle><CardDescription>All stored patient-level assessments</CardDescription></div></CardHeader>
          <div className="p-4">{riskByLevel.data ? <CountBars data={riskByLevel.data} colors={LEVEL_COLORS} /> : <div className="h-[220px]" />}</div></Card>
      </div>
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Most severe open alerts</p><Link className="text-sm text-brand-700 hover:underline" to="/sponsor/integrity">View all</Link></div>
        <DataTable rows={latestAlerts.data?.items} rowKey={(a) => a.id} loading={latestAlerts.isLoading} error={latestAlerts.error} onRetry={() => latestAlerts.refetch()} emptyTitle="No open alerts" emptyDescription="Run an integrity scan to check for issues."
          columns={[
            { header: 'Severity', cell: (a) => <StatusBadge value={a.severity} /> },
            { header: 'Alert', cell: (a) => <span className="font-medium">{a.message}</span> },
            { header: 'Detected', cell: (a) => formatDateTime(a.detectedAt), hideOnMobile: true },
          ]} />
      </div>
    </>
  );
}
