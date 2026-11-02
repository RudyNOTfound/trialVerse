import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, FlaskConical, ScrollText, ShieldAlert } from 'lucide-react';
import { integrityApi } from '@/api/integrity';
import { statsApi } from '@/api/stats';
import { CountBars, LEVEL_COLORS } from '@/components/charts/Charts';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/utils/format';

const LEVELS = ['low', 'medium', 'high', 'critical'];
const toBars = (m?: Record<string, number>) => (m ? LEVELS.map((name) => ({ name, value: m[name] ?? 0 })) : undefined);

/** One aggregate request (`/stats/sponsor`) replaces ~10 list queries; only the "most severe alerts" table still lists records. */
export default function SponsorOverview() {
  const stats = useQuery({ queryKey: ['sponsor', 'stats'], queryFn: () => statsApi.sponsor({ topRisks: 5 }) });
  const latestAlerts = useQuery({ queryKey: ['sponsor', 'latest-alerts'], queryFn: () => integrityApi.alerts({ status: 'open', sort: 'severity', order: 'desc', pageSize: 5 }) });
  const s = stats.data;

  return (
    <>
      <PageHeader title="Sponsor overview" description="Risk and integrity oversight across trials. All figures come from the baseline rule engines." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active trials" value={s?.trials.byStatus.active} icon={FlaskConical} to="/sponsor/trials" loading={stats.isLoading} />
        <StatCard label="High / critical risk" value={s?.risk.highOrCritical} icon={Activity} tone="red" to="/sponsor/risk" hint="Latest assessment per patient, visit or claim" loading={stats.isLoading} />
        <StatCard label="Open integrity alerts" value={s?.integrity.open} icon={ShieldAlert} tone="amber" to="/sponsor/integrity" loading={stats.isLoading} />
        <StatCard label="Audit events" value={s?.audit.totalEvents} icon={ScrollText} tone="green" to="/sponsor/audit" hint="Verify the chain on the audit page" loading={stats.isLoading} />
      </div>
      {stats.error && <p role="alert" className="mt-4 text-sm text-red-600">Could not load statistics: {(stats.error as Error).message}</p>}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card><CardHeader><div><CardTitle>Open alerts by severity</CardTitle><CardDescription>Unresolved integrity alerts</CardDescription></div></CardHeader>
          <div className="p-4">{s ? <CountBars data={toBars(s.integrity.openBySeverity)!} colors={LEVEL_COLORS} /> : <div className="h-[220px]" />}</div></Card>
        <Card><CardHeader><div><CardTitle>Patient risk by level</CardTitle><CardDescription>Each patient's latest assessment</CardDescription></div></CardHeader>
          <div className="p-4">{s ? <CountBars data={toBars(s.risk.byEntityType.patient ?? {})!} colors={LEVEL_COLORS} /> : <div className="h-[220px]" />}</div></Card>
      </div>

      {s && s.risk.top.length > 0 && (
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Highest current risk</p><Link className="text-sm text-brand-700 hover:underline" to="/sponsor/risk">View all</Link></div>
          <DataTable rows={s.risk.top} rowKey={(r) => r.id} columns={[
            { header: 'Subject', cell: (r) => <div><p className="font-medium">{r.entityName ?? r.entityId.slice(0, 8)}</p><p className="text-xs capitalize text-muted">{r.entityType}</p></div> },
            { header: 'Score', cell: (r) => <span className="font-semibold tabular-nums">{r.score}</span> },
            { header: 'Level', cell: (r) => <StatusBadge value={r.level} /> },
            { header: 'Assessed', cell: (r) => formatDateTime(r.assessedAt), hideOnMobile: true },
          ]} />
        </div>
      )}

      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Most severe open alerts</p><Link className="text-sm text-brand-700 hover:underline" to="/sponsor/integrity">View all</Link></div>
        <DataTable rows={latestAlerts.data?.items} rowKey={(a) => a.id} loading={latestAlerts.isLoading} error={latestAlerts.error} onRetry={() => latestAlerts.refetch()} emptyTitle="No open alerts" emptyDescription="Run an integrity scan to check for issues."
          columns={[
            { header: 'Severity', cell: (a) => <StatusBadge value={a.severity} /> },
            { header: 'Alert', cell: (a) => <div><p className="font-medium">{a.message}</p>{a.entityName && <p className="text-xs text-muted">{a.entityName}</p>}</div> },
            { header: 'Detected', cell: (a) => formatDateTime(a.detectedAt), hideOnMobile: true },
          ]} />
      </div>
    </>
  );
}
