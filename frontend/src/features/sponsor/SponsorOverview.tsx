import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, FlaskConical, ScrollText, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { integrityApi } from '@/api/integrity';
import { statsApi } from '@/api/stats';
import { CountBars, LEVEL_COLORS } from '@/components/charts/Charts';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { alertSiteIds, bySeverityDesc, ruleLabel } from '@/lib/ml';
import { formatDateTime } from '@/utils/format';
import type { IntegrityAlert, RiskLevel } from '@/types/api';

const LEVELS = ['low', 'medium', 'high', 'critical'];
const toBars = (m?: Record<string, number>) => (m ? LEVELS.map((name) => ({ name, value: m[name] ?? 0 })) : undefined);

/** One aggregate request (`/stats/sponsor`) replaces ~10 list queries; only the "most severe alerts" table still lists records. */
export default function SponsorOverview() {
  const stats = useQuery({ queryKey: ['sponsor', 'stats'], queryFn: () => statsApi.sponsor({ topRisks: 5 }) });
  const latestAlerts = useQuery({ queryKey: ['sponsor', 'latest-alerts'], queryFn: () => integrityApi.alerts({ status: 'open', sort: 'severity', order: 'desc', pageSize: 5 }) });
  const ops = useQuery({ queryKey: ['sponsor', 'operations'], queryFn: () => statsApi.operations() });
  const siteAlerts = useQuery({ queryKey: ['sponsor', 'site-alerts'], queryFn: () => integrityApi.alerts({ entityType: 'site', status: 'open', sort: 'severity', order: 'desc', pageSize: 100 }) });
  const s = stats.data;
  const assessedPatients = s ? Object.values(s.risk.byEntityType.patient ?? {}).reduce((n, c) => n + c, 0) : undefined;
  // Open site-level findings grouped by the site code the alert itself carries (details.siteCode).
  const sites = useMemo(() => {
    const m = new Map<string, { code: string; count: number; highest: RiskLevel; rules: Set<string> }>();
    for (const a of siteAlerts.data?.items ?? [] as IntegrityAlert[]) {
      const code = typeof a.details.siteCode === 'string' ? a.details.siteCode : alertSiteIds(a)[0] ?? a.entityId.slice(0, 8);
      const cur = m.get(code) ?? { code, count: 0, highest: a.severity, rules: new Set<string>() };
      cur.count++; cur.rules.add(a.ruleId); if (bySeverityDesc({ severity: cur.highest }, a) > 0) cur.highest = a.severity;
      m.set(code, cur);
    }
    return [...m.values()].sort((x, y) => bySeverityDesc({ severity: x.highest }, { severity: y.highest }) || y.count - x.count);
  }, [siteAlerts.data]);

  return (
    <>
      <PageHeader title="Trial oversight" description="Risk and integrity oversight across trials. Every figure is the latest stored result; each risk assessment records which engine produced it." />
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
        <Card><CardHeader><div><CardTitle>Patient risk by level</CardTitle><CardDescription>{assessedPatients !== undefined && ops.data ? `${assessedPatients} of ${ops.data.patients.total} patients assessed (latest assessment each)` : "Each patient's latest assessment"}</CardDescription></div></CardHeader>
          <div className="p-4">{s ? <CountBars data={toBars(s.risk.byEntityType.patient ?? {})!} colors={LEVEL_COLORS} /> : <div className="h-[220px]" />}</div></Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader><div><CardTitle>Site-level integrity concerns</CardTitle><CardDescription>Open site-level findings. They compare a site with the other sites of its trial and are prompts for review, not proof of misconduct.</CardDescription></div>
            <Link className="text-sm text-brand-700 hover:underline" to="/sponsor/integrity">Open integrity monitoring</Link></CardHeader>
          {siteAlerts.isLoading ? <div className="h-20 animate-pulse bg-slate-50" /> : siteAlerts.error ? <p role="alert" className="p-5 text-sm text-red-600">Could not load site findings: {(siteAlerts.error as Error).message}</p>
            : sites.length === 0 ? <p className="p-5 text-sm text-muted">No open site-level findings. Run an integrity scan to check a trial.</p>
            : (
              <ul className="divide-y divide-line" data-testid="site-concerns">{sites.map((x) => (
                <li key={x.code} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <div><p className="font-medium">{x.code}</p><p className="text-xs text-muted">{[...x.rules].slice(0, 4).map(ruleLabel).join(' · ')}{x.rules.size > 4 ? ` · +${x.rules.size - 4} more` : ''}</p></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-slate-600">{x.count} open</span><StatusBadge value={x.highest} /></div>
                </li>
              ))}</ul>
            )}
        </Card>
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
