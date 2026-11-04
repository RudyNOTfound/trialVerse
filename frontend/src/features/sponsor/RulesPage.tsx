import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Info, ListChecks } from 'lucide-react';
import { integrityApi } from '@/api/integrity';
import { riskApi } from '@/api/risk';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState, Skeleton } from '@/components/common/States';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { INTEGRITY_RULE_DOCS, RISK_RULE_DOCS } from './ruleDescriptions';

type Tab = 'risk' | 'integrity';

/** Whether the engine is the rule-based baseline or an ML model. The API exposes this only through the active engine name. */
function EngineBadge({ engine }: { engine: { name: string; version: string } }) {
  const baseline = engine.name.startsWith('baseline');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-white p-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', baseline ? 'bg-blue-50 text-blue-600' : 'bg-violet-50 text-violet-600')}>{baseline ? <ListChecks className="h-5 w-5" /> : <Cpu className="h-5 w-5" />}</span>
      <div>
        <p className="text-sm font-medium">{baseline ? 'Rule-based baseline' : 'ML model'}<span className="ml-2 font-mono text-xs font-normal text-muted">{engine.name} v{engine.version}</span></p>
        <p className="text-xs text-muted">{baseline ? 'Scores come from the configurable rules below. No machine-learning model is active.' : 'An ML model is active; the rules below remain the fallback if it fails.'}</p>
      </div>
      <Badge tone={baseline ? 'blue' : 'violet'} className="ml-auto">{baseline ? 'Rules' : 'ML'}</Badge>
    </div>
  );
}

function ReadOnlyNote() {
  return (
    <div className="mb-4 flex items-start gap-2 text-xs text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>Read-only. The API has no endpoint to change rules; thresholds are set in the server's configuration (<code className="font-mono">RISK_RULES_OVERRIDES</code> / <code className="font-mono">INTEGRITY_RULES_OVERRIDES</code>) and take effect on restart.</p>
    </div>
  );
}

function RiskRules() {
  const q = useQuery({ queryKey: ['rules', 'risk'], queryFn: riskApi.rules });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const { engine, baselineConfig: cfg } = q.data;
  const rows = Object.entries(cfg.rules);
  return (
    <>
      <EngineBadge engine={engine} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {([['medium', cfg.levels.medium, 'amber'], ['high', cfg.levels.high, 'orange'], ['critical', cfg.levels.critical, 'red']] as const).map(([lvl, score, tone]) => (
          <Card key={lvl}><CardContent className="flex items-center justify-between py-4"><div><p className="text-xs text-muted">Score for “{lvl}” level</p><p className="text-2xl font-semibold tabular-nums">{score}+</p></div><Badge tone={tone} className="capitalize">{lvl}</Badge></CardContent></Card>
        ))}
      </div>
      <p className="mb-3 text-xs text-muted">A risk score is the sum of the weights of triggered rules, capped at 100.</p>
      <ReadOnlyNote />
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3 font-medium">Rule</th><th className="hidden px-4 py-3 font-medium md:table-cell">Applies to</th><th className="px-4 py-3 font-medium">Triggers when</th><th className="px-4 py-3 font-medium">Weight</th><th className="px-4 py-3 font-medium">State</th></tr></thead>
        <tbody className="divide-y divide-line">{rows.map(([id, c]) => {
          const doc = RISK_RULE_DOCS[id];
          return (
            <tr key={id} className={cn(!c.enabled && 'opacity-60')}>
              <td className="px-4 py-3"><p className="font-medium text-ink">{doc?.description ?? id}</p><p className="font-mono text-[11px] text-slate-400">{id}</p></td>
              <td className="hidden px-4 py-3 md:table-cell">{doc ? <Badge>{doc.applies}</Badge> : '—'}</td>
              <td className="px-4 py-3 text-slate-700">{doc ? doc.trigger(c) : `threshold ${c.threshold}`}</td>
              <td className="px-4 py-3 font-semibold tabular-nums">+{c.weight}</td>
              <td className="px-4 py-3"><Badge tone={c.enabled ? 'green' : 'neutral'}>{c.enabled ? 'Enabled' : 'Disabled'}</Badge></td>
            </tr>
          );
        })}</tbody></table></div></Card>
    </>
  );
}

function IntegrityRules() {
  const q = useQuery({ queryKey: ['rules', 'integrity'], queryFn: integrityApi.rules });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const { engine, baselineConfig: cfg } = q.data;
  return (
    <>
      <EngineBadge engine={engine} />
      <ReadOnlyNote />
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(cfg).map(([key, c]) => {
          const doc = INTEGRITY_RULE_DOCS[key];
          const { enabled, ...settings } = c;
          return (
            <Card key={key} className={cn(!enabled && 'opacity-60')}><CardContent className="space-y-2">
              <div className="flex items-start justify-between gap-3"><p className="font-medium text-ink">{doc?.title ?? key}</p><Badge tone={enabled ? 'green' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge></div>
              <p className="text-sm text-slate-600">{doc?.description ?? 'No description available.'}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {doc && <Badge tone="blue">Rule-based · {doc.severity}</Badge>}
                {Object.entries(settings).map(([k, v]) => <span key={k} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700"><b className="tabular-nums">{String(v)}</b> {doc?.settings[k] ?? k}</span>)}
              </div>
            </CardContent></Card>
          );
        })}
      </div>
    </>
  );
}

export default function RulesPage() {
  const [tab, setTab] = useState<Tab>('risk');
  return (
    <>
      <PageHeader title="Detection rules" description="How risk scores and integrity alerts are produced." />
      <div className="mb-5 inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
        {(['risk', 'integrity'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors', tab === t ? 'bg-white text-ink shadow-sm' : 'text-slate-600 hover:text-ink')}>{t === 'risk' ? 'Risk scoring' : 'Integrity checks'}</button>
        ))}
      </div>
      {tab === 'risk' ? <RiskRules /> : <IntegrityRules />}
    </>
  );
}
