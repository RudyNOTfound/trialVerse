import { AlertTriangle, Cpu, Info, ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/common/StatusBadge';
import { factorsOf, riskSource, SOURCE_LABEL, type RiskSource } from '@/lib/ml';
import { cn } from '@/lib/utils';
import { formatDateTime, humanize } from '@/utils/format';
import type { RiskAssessment } from '@/types/api';

const BANNER: Record<RiskSource, { tone: string; icon: typeof Cpu; title: string }> = {
  model: { tone: 'border-brand-200 bg-brand-50 text-brand-900', icon: Cpu, title: 'Scored by the ML model' },
  baseline: { tone: 'border-slate-200 bg-slate-50 text-slate-800', icon: ListChecks, title: 'Scored by the rule engine' },
  fallback: { tone: 'border-amber-300 bg-amber-50 text-amber-900', icon: AlertTriangle, title: 'ML service unavailable: rule-engine result shown' },
};

/** Which engine produced the result, and why, using only the fields the API returns (`engine`, `fallback`). */
export function EngineBanner({ assessment }: { assessment: Pick<RiskAssessment, 'engine' | 'fallback'> }) {
  const source = riskSource(assessment);
  const b = BANNER[source];
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-3 text-sm', b.tone)} data-testid="engine-banner" data-source={source}>
      <b.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{b.title}</p>
        <p className="text-xs opacity-80">{SOURCE_LABEL[source]} · {assessment.engine.name} v{assessment.engine.version}</p>
        {source === 'fallback' && assessment.fallback.reason && <p className="mt-1 break-words text-xs">Reason reported: {assessment.fallback.reason}</p>}
        {source === 'baseline' && <p className="mt-1 text-xs">The ML service is not enabled for risk scoring, so this is the platform's rule-based score.</p>}
      </div>
    </div>
  );
}

/** Signed factor list: bars to the right raise the score, bars to the left lower it. Magnitudes are the API's `weight` values. */
export function FactorList({ assessment }: { assessment: Pick<RiskAssessment, 'triggeredRules' | 'engine' | 'fallback'> }) {
  const factors = factorsOf(assessment);
  const max = Math.max(1, ...factors.map((f) => Math.abs(f.weight)));
  const source = riskSource(assessment);
  if (factors.length === 0) return <p className="text-sm text-muted">The engine returned no contributing factors for this assessment.</p>;
  return (
    <div>
      <p className="mb-2 text-xs text-muted">
        {source === 'model'
          ? "Each bar is the factor's contribution to the model's score in points (right raises, left lowers). These are statistical associations in the training data, not causes."
          : 'Rules that fired, with their configured weight.'}
      </p>
      <ul className="space-y-2" aria-label="Contributing factors">
        {factors.map((f) => (
          <li key={f.ruleId} className="rounded-lg border border-line p-3" data-testid="factor">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{humanize(f.name)}</p>
              <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums', f.direction === 'raises' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700')}>
                {f.weight > 0 ? '+' : ''}{f.weight}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-600">{f.detail}</p>
            <div className="mt-2 grid grid-cols-2 gap-0 text-[0px]" aria-hidden>
              <div className="flex h-1.5 justify-end rounded-l-full bg-slate-100">{f.weight < 0 && <div className="h-full rounded-l-full bg-emerald-500" style={{ width: `${(Math.abs(f.weight) / max) * 100}%` }} />}</div>
              <div className="h-1.5 rounded-r-full bg-slate-100">{f.weight > 0 && <div className="h-full rounded-r-full bg-red-500" style={{ width: `${(f.weight / max) * 100}%` }} />}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Everything the API returned about one assessment, in reading order. `subject` is the participant (or other entity) label. */
export function RiskDetailPanel({ assessment: a, subject, synthetic, lastValid }: { assessment: RiskAssessment; subject?: string; synthetic?: boolean; lastValid?: RiskAssessment }) {
  const fallback = riskSource(a) === 'fallback';
  return (
    <div className="space-y-5" data-testid="risk-detail">
      <div className="flex items-center justify-between rounded-lg bg-slate-50 p-4">
        <div>
          {subject && <p className="text-sm font-medium text-ink">{subject}</p>}
          <p className="text-xs text-muted">{fallback ? 'Rule-engine score (not a model prediction)' : 'Risk score'}</p>
          <p className={cn('whitespace-nowrap text-4xl font-semibold tabular-nums', fallback && 'text-slate-400')} data-testid="risk-score">{a.score}<span className="text-base font-normal text-muted"> / 100</span></p>
        </div>
        <div className="text-right">{fallback ? <Badge tone="amber">No ML result</Badge> : <StatusBadge value={a.level} />}{synthetic && <div className="mt-2"><Badge tone="violet">Synthetic demo data</Badge></div>}</div>
      </div>
      <EngineBanner assessment={a} />
      {fallback && lastValid && (
        <p className="rounded-lg border border-line bg-white p-3 text-sm" data-testid="last-valid">Last successful result: <strong className="tabular-nums">{lastValid.score}</strong> / 100, <StatusBadge value={lastValid.level} /> ({formatDateTime(lastValid.assessedAt)}). It is still used for ranking until a new model result is stored.</p>
      )}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Why this score</p>
        <FactorList assessment={a} />
      </div>
      <div>
        <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted"><Info className="h-3.5 w-3.5" aria-hidden />Explanation from the engine</p>
        <p className="text-sm text-slate-700" data-testid="risk-explanation">{a.explanation}</p>
      </div>
      <p className="text-xs text-muted">Assessed {formatDateTime(a.assessedAt)} · engine {a.engine.name} v{a.engine.version}</p>
    </div>
  );
}
