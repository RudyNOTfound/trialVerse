import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { categoryOf, participantIdsOf, reviewActionOf, ruleLabel, visitIdsOf } from '@/lib/ml';
import { humanize, shortId } from '@/utils/format';
import type { IntegrityAlert } from '@/types/api';

/** Keys rendered in their own sections below, so the generic table skips them. */
const HANDLED = new Set(['category', 'recommendedReviewAction', 'signals', 'signalEvidence', 'signalCount', 'participantId', 'participantIds', 'visitIds', 'ecgIds', 'siteId', 'siteIds', 'siteCode', 'participant_ids']);

function scalar(key: string, v: unknown): string {
  if (typeof v === 'number') {
    if (/p_?value/i.test(key)) return v < 0.001 ? v.toExponential(1) : v.toFixed(4);
    if (/rate|share|ratio/i.test(key) && v <= 1) return `${(v * 100).toFixed(1)}%${/ratio/i.test(key) ? ` (${v.toFixed(2)})` : ''}`;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
const label = (k: string) => humanize(k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());

function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
      {entries.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted">{label(k)}</dt><dd className="break-words font-medium tabular-nums">{scalar(k, v)}</dd></div>)}
    </dl>
  );
}

/**
 * Renders the evidence an alert carries (`details`), in plain language where the key is known and as labelled values otherwise.
 * `names` resolves ids to display names (participants, sites). The raw JSON is one click away: nothing is hidden or reworded.
 */
export function EvidenceView({ alert, names }: { alert: Pick<IntegrityAlert, 'details' | 'entityType' | 'entityId' | 'ruleId'>; names?: { participant?: (id: string) => string | undefined; site?: (id: string) => string | undefined } }) {
  const [raw, setRaw] = useState(false);
  const d = alert.details;
  const category = categoryOf(alert);
  const action = reviewActionOf(alert);
  const signals = Array.isArray(d.signals) ? (d.signals as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  const signalEvidence = (d.signalEvidence && typeof d.signalEvidence === 'object' ? d.signalEvidence : {}) as Record<string, Record<string, unknown>>;
  const people = participantIdsOf(alert); const visits = visitIdsOf(alert);
  const siteCode = typeof d.siteCode === 'string' ? d.siteCode : undefined;
  const rest = Object.fromEntries(Object.entries(d).filter(([k, v]) => !HANDLED.has(k) && (typeof v !== 'object' || v === null)));
  const shownPeople = people.slice(0, 8);

  return (
    <div className="space-y-4" data-testid="evidence">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{ruleLabel(alert.ruleId)}</Badge>
        {category && <Badge tone={category === 'data_quality' ? 'blue' : 'orange'}>{category === 'data_quality' ? 'Data quality' : 'Suspicious pattern'}</Badge>}
        {siteCode && <Badge tone="violet">{siteCode}</Badge>}
      </div>

      {action && <div className="rounded-lg border border-brand-200 bg-brand-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-brand-800">Suggested review</p><p className="mt-0.5 text-sm text-brand-950">{action}</p></div>}

      {signals.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Signals that fired ({signals.length})</p>
          <ul className="space-y-2">{signals.map((s) => (
            <li key={s} className="rounded-lg border border-line p-2.5" data-testid="signal"><p className="text-sm font-medium">{humanize(s)}</p>
              {signalEvidence[s] && <div className="mt-1.5"><KeyValues data={signalEvidence[s]!} /></div>}</li>
          ))}</ul>
        </div>
      )}

      {Object.keys(rest).length > 0 && <div><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Measurements behind the finding</p><KeyValues data={rest} /></div>}

      {people.length > 0 && (
        <div><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Participants involved ({people.length})</p>
          <div className="flex flex-wrap gap-1.5">{shownPeople.map((id) => <span key={id} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{names?.participant?.(id) ?? shortId(id)}</span>)}{people.length > shownPeople.length && <span className="text-xs text-muted">+{people.length - shownPeople.length} more</span>}</div></div>
      )}
      {visits.length > 0 && alert.entityType !== 'visit' && <p className="text-sm text-slate-700">{visits.length} visit{visits.length === 1 ? '' : 's'} involved.</p>}

      <div>
        <button type="button" className="inline-flex min-h-8 items-center text-xs font-medium text-brand-700 hover:underline" aria-expanded={raw} onClick={() => setRaw((v) => !v)}>{raw ? 'Hide' : 'Show'} raw evidence (JSON)</button>
        {raw && <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-navy-950 p-3 text-xs leading-relaxed text-blue-100">{JSON.stringify(d, null, 2)}</pre>}
      </div>
    </div>
  );
}
