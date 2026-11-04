import type { IntegrityAlert, RiskAssessment, RiskLevel, TrialSite } from '@/types/api';

/**
 * Pure helpers that interpret what the backend ALREADY returns for risk assessments and integrity alerts.
 * Nothing here computes a score or invents an explanation: it only classifies, groups and orders real API data.
 */

// ------------------------------------------------------------------------------------------------ risk
/** model = the ML service answered; baseline = the ML engine is switched off (rule engine used on purpose); fallback = ML was expected but failed. */
export type RiskSource = 'model' | 'baseline' | 'fallback';

export function riskSource(a: Pick<RiskAssessment, 'engine' | 'fallback'>): RiskSource {
  if (a.fallback.used) return 'fallback';
  return a.engine.name.startsWith('baseline') ? 'baseline' : 'model';
}

export const SOURCE_LABEL: Record<RiskSource, string> = {
  model: 'ML model', baseline: 'Rule engine (ML not used)', fallback: 'Rule engine (ML unavailable)',
};

export const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
export const needsAttention = (level: RiskLevel) => level === 'high' || level === 'critical';

export interface Factor { ruleId: string; name: string; weight: number; detail: string; direction: 'raises' | 'lowers' }

/** Contributing factors exactly as returned (`triggeredRules`), strongest first. For the ML engine `weight` is signed (negative lowers the score). */
export function factorsOf(a: Pick<RiskAssessment, 'triggeredRules'>): Factor[] {
  return [...a.triggeredRules]
    .map((r) => ({ ...r, direction: r.weight < 0 ? ('lowers' as const) : ('raises' as const) }))
    .sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight));
}

/** One entry per entity: the most recently assessed. */
export function latestByEntity(items: RiskAssessment[]): Map<string, RiskAssessment> {
  const out = new Map<string, RiskAssessment>();
  for (const a of items) {
    const cur = out.get(a.entityId);
    if (!cur || Date.parse(a.assessedAt) > Date.parse(cur.assessedAt)) out.set(a.entityId, a);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ integrity
export const SEVERITY_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const bySeverityDesc = (a: Pick<IntegrityAlert, 'severity'>, b: Pick<IntegrityAlert, 'severity'>) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Site ids an alert says it is about (`details.siteId`, or `details.siteIds` for an ECG cluster). Empty = the alert is not tied to a site. */
export function alertSiteIds(a: Pick<IntegrityAlert, 'details' | 'entityType' | 'entityId'>): string[] {
  const ids = new Set([...asStrings(a.details.siteIds), ...(asString(a.details.siteId) ? [asString(a.details.siteId)!] : [])]);
  if (a.entityType === 'site') ids.add(a.entityId);
  return [...ids];
}

/**
 * Splits alerts into those about the selected trial's sites and the rest. The rest are platform-wide findings from the audit trail
 * (reimbursements, users, OTP bursts ...): a trial-scoped scan still reports them, so they must not be presented as trial findings.
 */
export function scopeAlerts<T extends Pick<IntegrityAlert, 'details' | 'entityType' | 'entityId'>>(alerts: T[], siteIds: Iterable<string>) {
  const mine = new Set(siteIds);
  const trial: T[] = []; const platform: T[] = [];
  for (const a of alerts) (alertSiteIds(a).some((id) => mine.has(id)) ? trial : platform).push(a);
  return { trial, platform };
}

export interface SiteSummary {
  site: TrialSite;
  total: number;
  bySeverity: Record<RiskLevel, number>;
  highest: RiskLevel | null;
  /** Rule ids with the number of alerts, most frequent first. */
  rules: Array<{ ruleId: string; count: number }>;
}

/** Per-site roll-up of the given (already trial-scoped) alerts. Sites without alerts are kept, with `highest: null`. */
export function summariseSites(alerts: Array<Pick<IntegrityAlert, 'details' | 'entityType' | 'entityId' | 'severity' | 'ruleId'>>, sites: TrialSite[]): SiteSummary[] {
  const rows = new Map<string, SiteSummary>(sites.map((site) => [site.id, { site, total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, highest: null, rules: [] }]));
  const rules = new Map<string, Map<string, number>>();
  for (const a of alerts) {
    for (const id of alertSiteIds(a)) {
      const row = rows.get(id);
      if (!row) continue;
      row.total++; row.bySeverity[a.severity]++;
      if (!row.highest || SEVERITY_RANK[a.severity] > SEVERITY_RANK[row.highest]) row.highest = a.severity;
      const m = rules.get(id) ?? new Map<string, number>(); m.set(a.ruleId, (m.get(a.ruleId) ?? 0) + 1); rules.set(id, m);
    }
  }
  for (const [id, m] of rules) rows.get(id)!.rules = [...m].map(([ruleId, count]) => ({ ruleId, count })).sort((x, y) => y.count - x.count);
  return [...rows.values()].sort((a, b) => (b.highest ? SEVERITY_RANK[b.highest] : -1) - (a.highest ? SEVERITY_RANK[a.highest] : -1) || b.total - a.total || a.site.siteCode.localeCompare(b.site.siteCode));
}

/**
 * Human label for a rule id, e.g. `site.bp_digit_preference` -> "BP digit preference".
 * `site.` and `visit.multiple_integrity_signals` would otherwise read identically, so the scope is kept for that rule.
 */
export function ruleLabel(ruleId: string): string {
  const [scope = '', ...rest] = ruleId.split('.');
  const known = ['integrity', 'site', 'visit', 'ecg', 'ml'].includes(scope) && rest.length > 0;
  const base = (known ? rest.join('.') : ruleId).replace(/_/g, ' ');
  const s = base.charAt(0).toUpperCase() + base.slice(1);
  const label = s.replace(/\bbp\b/gi, 'BP').replace(/\botp\b/gi, 'OTP').replace(/\becg\b/gi, 'ECG');
  return known && /^multiple integrity signals$/i.test(base) ? `${label} (${scope})` : label;
}

export const categoryOf = (a: Pick<IntegrityAlert, 'details'>) => asString(a.details.category);
export const reviewActionOf = (a: Pick<IntegrityAlert, 'details'>) => asString(a.details.recommendedReviewAction);
export const participantIdsOf = (a: Pick<IntegrityAlert, 'details'>): string[] => [...new Set([...asStrings(a.details.participantIds), ...(asString(a.details.participantId) ? [asString(a.details.participantId)!] : [])])];
export const visitIdsOf = (a: Pick<IntegrityAlert, 'details' | 'entityType' | 'entityId'>): string[] => [...new Set([...asStrings(a.details.visitIds), ...(a.entityType === 'visit' ? [a.entityId] : [])])];

/**
 * What an alert is about, in words. `entityId` is only a database id for most types; for an ECG cluster it is an internal key, and for a
 * site the readable name is the site code the alert carries (or the caller's lookup).
 */
export function entityLabel(a: Pick<IntegrityAlert, 'entityType' | 'entityId' | 'entityName' | 'details'>, siteName?: (siteId: string) => string | undefined): string {
  if (a.entityName) return a.entityName;
  const type = a.entityType.replace(/_/g, ' ');
  if (a.entityType === 'site') return `Site ${typeof a.details.siteCode === 'string' ? a.details.siteCode : siteName?.(a.entityId) ?? a.entityId.slice(0, 8)}`;
  if (a.entityType === 'ecg_cluster') { const n = visitIdsOf(a).length; return n ? `ECG image cluster (${n} visit${n === 1 ? '' : 's'})` : 'ECG image cluster'; }
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} ${a.entityId.slice(0, 8)}`;
}
