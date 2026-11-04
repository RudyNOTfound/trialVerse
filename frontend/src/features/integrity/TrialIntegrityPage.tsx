import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, ScanSearch, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { integrityApi } from '@/api/integrity';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { ErrorState } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { isSyntheticTrial, useTrials } from '@/features/risk/hooks';
import { alertSiteIds, bySeverityDesc, categoryOf, ruleLabel, scopeAlerts, summariseSites } from '@/lib/ml';
import { cn } from '@/lib/utils';
import { formatDateTime, humanize, shortId } from '@/utils/format';
import type { IntegrityAlert, IntegrityScanSummary, TrialSite } from '@/types/api';
import { AlertDialog } from './AlertDialog';
import { useAllAlerts, useScanHistory, useTrialSites } from './hooks';
import { ScanResult } from './ScanResult';

const PAGE_SIZE = 15;
const WINDOWS = [{ value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' }, { value: '720', label: 'Last 30 days' }];
const SEV_DOT: Record<string, string> = { low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-orange-500', critical: 'bg-red-600' };

/** Site cards: one per site of the trial, built from the real alerts. A site with no alerts says so; it does not claim to be "clean". */
export function SiteCards({ summaries, selectedSite, onSelect }: { summaries: ReturnType<typeof summariseSites>; selectedSite: string; onSelect: (siteId: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="site-cards">
      {summaries.map((s) => {
        const active = selectedSite === s.site.id;
        return (
          <button key={s.site.id} type="button" onClick={() => onSelect(active ? '' : s.site.id)} aria-pressed={active} data-testid="site-card" data-site={s.site.siteCode}
            className={cn('flex flex-col items-stretch justify-start rounded-xl border bg-white p-4 text-left transition-shadow hover:shadow-md', active ? 'border-brand-500 ring-2 ring-brand-200' : 'border-line')}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="truncate text-sm font-semibold">{s.site.siteCode}</p><p className="truncate text-xs text-muted">{s.site.name}</p></div>
              {s.highest ? <StatusBadge value={s.highest} /> : <Badge tone="neutral">No findings</Badge>}
            </div>
            {s.total > 0 ? (
              <>
                <p className="mt-3 text-2xl font-semibold tabular-nums">{s.total}<span className="text-sm font-normal text-muted"> finding{s.total === 1 ? '' : 's'}</span></p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                  {(['critical', 'high', 'medium', 'low'] as const).filter((l) => s.bySeverity[l] > 0).map((l) => <span key={l} className="inline-flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', SEV_DOT[l])} aria-hidden />{s.bySeverity[l]} {l}</span>)}
                </div>
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">{s.rules.slice(0, 3).map((r) => <li key={r.ruleId}>{ruleLabel(r.ruleId)}{r.count > 1 ? ` ×${r.count}` : ''}</li>)}{s.rules.length > 3 && <li className="text-muted">+{s.rules.length - 3} more</li>}</ul>
              </>
            ) : <p className="mt-3 text-xs text-muted">No alerts recorded for this site.</p>}
          </button>
        );
      })}
    </div>
  );
}

const rowSite = (a: IntegrityAlert, sites: TrialSite[]) => sites.find((s) => alertSiteIds(a).includes(s.id));

/** Integrity monitoring for one trial: run a scan, see which sites raised findings, inspect each finding's evidence. */
export default function TrialIntegrityPage() {
  const qc = useQueryClient();
  const trials = useTrials();
  const [trialPick, setTrialPick] = useState('');
  const trial = (trials.data ?? []).find((t) => t.id === trialPick) ?? (trials.data ?? []).find((t) => t.status === 'active') ?? trials.data?.[0];
  const sites = useTrialSites(trial?.id);
  const alerts = useAllAlerts();
  const history = useScanHistory();
  const [hours, setHours] = useState('168');
  const [confirm, setConfirm] = useState(false);
  const [outcome, setOutcome] = useState<{ result?: IntegrityScanSummary; error?: unknown } | null>(null);
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [site, setSite] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [showPlatform, setShowPlatform] = useState(false);

  const siteList = sites.data ?? [];
  const siteName = (id: string) => siteList.find((s) => s.id === id)?.siteCode ?? shortId(id);
  const { trial: trialAlerts, platform: platformAlerts } = useMemo(() => scopeAlerts(alerts.data ?? [], siteList.map((s) => s.id)), [alerts.data, siteList]);
  const summaries = useMemo(() => summariseSites(trialAlerts.filter((a) => a.status === 'open'), siteList), [trialAlerts, siteList]);
  const open = trialAlerts.filter((a) => a.status === 'open');
  const sitesWithFindings = summaries.filter((s) => s.total > 0).length;

  const filtered = trialAlerts
    .filter((a) => !status || a.status === status).filter((a) => !severity || a.severity === severity)
    .filter((a) => !category || categoryOf(a) === category).filter((a) => !site || alertSiteIds(a).includes(site))
    .sort((a, b) => bySeverityDesc(a, b) || Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pages) - 1) * PAGE_SIZE, Math.min(page, pages) * PAGE_SIZE);
  const synthetic = isSyntheticTrial(trial);

  const scan = useMutation({
    mutationFn: () => integrityApi.scan(Number(hours), trial!.id),
    onSuccess: (result) => { setOutcome({ result }); for (const k of ['alerts', 'scan-history', 'sponsor']) qc.invalidateQueries({ queryKey: [k] }); },
    onError: (error) => setOutcome({ error }),
  });
  // ConfirmDialog expects a promise; the outcome (success or error) is shown in the result banner instead of inside the dialog.
  const runScan = async () => { setOutcome(null); await scan.mutateAsync().catch(() => undefined); };

  return (
    <>
      <PageHeader title="Integrity monitoring" description="Scan a trial for data-integrity concerns, see which sites raised findings, and inspect the evidence behind each one."
        actions={<><Link className="inline-flex min-h-8 items-center self-center text-sm text-brand-700 hover:underline" to="/sponsor/integrity/alerts">All alerts</Link><Button disabled={!trial} loading={scan.isPending} onClick={() => setConfirm(true)}><ScanSearch className="h-4 w-4" />Run integrity scan</Button></>} />

      <FilterBar>
        <Select className="w-auto min-w-56" value={trial?.id ?? ''} onChange={(e) => { setTrialPick(e.target.value); setSite(''); setPage(1); setOutcome(null); }} aria-label="Trial" disabled={!trials.data?.length}>
          {(trials.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}
        </Select>
        <FilterSelect value={hours} onChange={(v) => setHours(v || '168')} allLabel="Look-back window" label="Look-back window" options={WINDOWS} />
        {synthetic && <Badge tone="violet">Synthetic demo data: not real participants</Badge>}
      </FilterBar>

      {trials.error && <Card className="mb-4"><ErrorState error={trials.error} onRetry={() => trials.refetch()} /></Card>}
      {scan.isPending && <p role="status" className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">Scanning {trial?.code}. Large trials can take several seconds…</p>}
      {outcome && <div className="mb-4"><ScanResult result={outcome.result} error={outcome.error} siteName={siteName} /></div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open findings" value={open.length} icon={ShieldAlert} tone="red" loading={alerts.isLoading || sites.isLoading} hint={trial ? `About ${trial.code} sites` : undefined} />
        <StatCard label="High / critical" value={open.filter((a) => a.severity === 'high' || a.severity === 'critical').length} icon={AlertTriangle} tone="red" loading={alerts.isLoading || sites.isLoading} />
        <StatCard label="Sites with findings" value={`${sitesWithFindings} of ${siteList.length}`} icon={Building2} tone="amber" loading={alerts.isLoading || sites.isLoading} />
        <StatCard label="Open platform-wide alerts" value={platformAlerts.filter((a) => a.status === 'open').length} icon={ShieldCheck} tone="blue" loading={alerts.isLoading || sites.isLoading} hint="From the audit trail, not this trial" />
      </div>

      <section className="mt-8" aria-labelledby="sites-h">
        <h2 id="sites-h" className="mb-1 text-sm font-semibold">Site summary</h2>
        <p className="mb-3 text-xs text-muted">Open findings per site. Statistical findings compare a site with the other sites of the trial and are prompts for review, not proof of misconduct.</p>
        {sites.error ? <Card><ErrorState error={sites.error} onRetry={() => sites.refetch()} /></Card>
          : sites.isLoading ? <div className="h-28 animate-pulse rounded-xl bg-slate-100" />
          : siteList.length === 0 ? <Card className="p-4 text-sm text-muted">This trial has no sites.</Card>
          : <SiteCards summaries={summaries} selectedSite={site} onSelect={(id) => { setSite(id); setPage(1); }} />}
      </section>

      <section className="mt-8" aria-labelledby="findings-h">
        <h2 id="findings-h" className="mb-2 text-sm font-semibold">Findings</h2>
        <FilterBar>
          <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['open', 'acknowledged', 'resolved', 'dismissed']} allLabel="All statuses" label="Filter by status" />
          <FilterSelect value={severity} onChange={(v) => { setSeverity(v); setPage(1); }} options={['low', 'medium', 'high', 'critical']} allLabel="All severities" label="Filter by severity" />
          <FilterSelect value={category} onChange={(v) => { setCategory(v); setPage(1); }} options={[{ value: 'suspicious_pattern', label: 'Suspicious pattern' }, { value: 'data_quality', label: 'Data quality' }]} allLabel="All categories" label="Filter by category" />
          <FilterSelect value={site} onChange={(v) => { setSite(v); setPage(1); }} options={siteList.map((s) => ({ value: s.id, label: s.siteCode }))} allLabel="All sites" label="Filter by site" />
        </FilterBar>
        <DataTable rows={visible} rowKey={(a) => a.id} loading={alerts.isLoading || sites.isLoading} error={alerts.error} onRetry={() => alerts.refetch()} onRowClick={(a) => setSelected(a.id)}
          meta={{ page: Math.min(page, pages), pageSize: PAGE_SIZE, total: filtered.length, totalPages: pages }} onPageChange={setPage}
          emptyTitle={trialAlerts.length === 0 ? 'No findings recorded for this trial' : 'No findings match these filters'}
          emptyDescription={trialAlerts.length === 0 ? 'Run an integrity scan to check this trial. If a scan finds nothing, that is reported as a completed scan with no findings.' : 'Change or clear a filter.'}
          columns={[
            { header: 'Severity', cell: (a) => <StatusBadge value={a.severity} /> },
            { header: 'Finding', cell: (a) => <div className="max-w-md"><p className="font-medium">{a.message}</p><p className="text-xs text-muted">{ruleLabel(a.ruleId)}</p></div> },
            { header: 'Site', cell: (a) => rowSite(a, siteList)?.siteCode ?? '—', hideOnMobile: true },
            { header: 'Category', cell: (a) => { const c = categoryOf(a); return c ? <span className="text-xs text-slate-600">{humanize(c)}</span> : '—'; }, hideOnMobile: true },
            { header: 'Detected', cell: (a) => formatDateTime(a.detectedAt), hideOnMobile: true },
            { header: 'Status', cell: (a) => <StatusBadge value={a.status} /> },
          ]} />
      </section>

      <section className="mt-8" aria-labelledby="platform-h">
        <button type="button" id="platform-h" className="inline-flex min-h-8 items-center text-sm font-semibold text-slate-800 hover:underline" aria-expanded={showPlatform} onClick={() => setShowPlatform((v) => !v)}>
          {showPlatform ? 'Hide' : 'Show'} platform-wide alerts ({platformAlerts.length})
        </button>
        <p className="mt-0.5 text-xs text-muted">Findings from the audit trail (users, reimbursements, OTP activity). They are raised by every scan but do not belong to a single trial.</p>
        {showPlatform && <div className="mt-3"><DataTable rows={platformAlerts.slice(0, 30)} rowKey={(a) => a.id} onRowClick={(a) => setSelected(a.id)} emptyTitle="No platform-wide alerts"
          columns={[
            { header: 'Severity', cell: (a) => <StatusBadge value={a.severity} /> },
            { header: 'Alert', cell: (a) => <div className="max-w-md"><p className="font-medium">{a.message}</p><p className="text-xs text-muted">{ruleLabel(a.ruleId)}{a.entityName ? ` · ${a.entityName}` : ''}</p></div> },
            { header: 'Status', cell: (a) => <StatusBadge value={a.status} /> },
          ]} /></div>}
      </section>

      <section className="mt-8" aria-labelledby="history-h">
        <Card>
          <CardHeader><div><CardTitle><span id="history-h">Scan history</span></CardTitle><CardDescription>Recent scans, read from the audit trail (it does not record which trial was scanned)</CardDescription></div></CardHeader>
          {history.error ? <ErrorState error={history.error} onRetry={() => history.refetch()} />
            : history.isLoading ? <div className="h-16 animate-pulse bg-slate-50" />
            : !history.data?.items.length ? <p className="p-5 text-sm text-muted">No scans have been recorded yet.</p>
            : (
              <ul className="divide-y divide-line" data-testid="scan-history">{history.data.items.map((e) => {
                const m = e.metadata as { engine?: string; findings?: number; newAlerts?: number; fallbackUsed?: boolean; trialsScanned?: number };
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div><p className="font-medium">{formatDateTime(e.createdAt)}</p><p className="text-xs text-muted">{e.actorName ?? 'Unknown'} · {m.engine ?? 'unknown engine'} · {m.trialsScanned ?? 0} trial{m.trialsScanned === 1 ? '' : 's'} analysed</p></div>
                    <div className="flex items-center gap-2 text-xs"><span>{m.findings ?? 0} findings, {m.newAlerts ?? 0} new</span>{m.fallbackUsed && <Badge tone="amber">Fallback used</Badge>}</div>
                  </li>
                );
              })}</ul>
            )}
        </Card>
      </section>

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} confirmVariant="primary" confirmLabel="Run scan" title={`Run an integrity scan on ${trial?.code ?? 'this trial'}?`}
        description={`The backend sends the trial's sites, visits, measurements and ECG references to the integrity service and stores any findings as alerts (repeat findings are de-duplicated). Audit-based checks look at the last ${hours} hours across the whole platform. The scan is recorded in the audit trail.`}
        onConfirm={runScan} />
      <AlertDialog id={selected} onClose={() => setSelected(null)} siteName={siteName} />
    </>
  );
}
