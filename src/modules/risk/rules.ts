import { z } from 'zod';
import { DEFAULT_LEVELS, type FeatureMap, type LevelThresholds, type RiskEntityType } from '../../ml/contracts';

export interface RuleSetting { enabled: boolean; weight: number; threshold: number; params?: Record<string, number> }

export interface RiskRulesConfig {
  levels: LevelThresholds;
  rules: Record<string, RuleSetting>;
}

export const DEFAULT_RISK_CONFIG: RiskRulesConfig = {
  levels: DEFAULT_LEVELS,
  rules: {
    'visit.otp_failed_attempts': { enabled: true, weight: 30, threshold: 3 },
    'visit.otp_locked': { enabled: true, weight: 25, threshold: 1 },
    'visit.excess_otp_issues': { enabled: true, weight: 15, threshold: 3 },
    'visit.missing_verification': { enabled: true, weight: 30, threshold: 24 }, // hours past scheduled time
    'patient.failed_otp_burst': { enabled: true, weight: 30, threshold: 5 }, // failed attempts in 24h
    'patient.visit_frequency': { enabled: true, weight: 20, threshold: 4 }, // visits in 7 days
    'patient.missed_visits': { enabled: true, weight: 20, threshold: 2 }, // in 90 days
    'patient.unverified_visits': { enabled: true, weight: 25, threshold: 2 },
    'patient.duplicate_reimbursements': { enabled: true, weight: 30, threshold: 1 },
    'patient.reimbursement_volume': { enabled: true, weight: 20, threshold: 100000 }, // cents in 30 days
    'reimbursement.duplicate': { enabled: true, weight: 40, threshold: 1 },
    'reimbursement.unverified_visit': { enabled: true, weight: 25, threshold: 1 },
    'reimbursement.amount_outlier': { enabled: true, weight: 25, threshold: 3, params: { absoluteCents: 50000 } }, // x category average
    'reimbursement.rapid_submission': { enabled: true, weight: 15, threshold: 3 }, // claims in 24h
  },
};

const overridesSchema = z.object({
  levels: z.object({ medium: z.number(), high: z.number(), critical: z.number() }).partial().optional(),
  rules: z.record(z.object({
    enabled: z.boolean().optional(), weight: z.number().min(0).max(100).optional(),
    threshold: z.number().optional(), params: z.record(z.number()).optional(),
  })).optional(),
});

/** Merges validated overrides (from RISK_RULES_OVERRIDES) over defaults. Unknown rule ids are rejected. */
export function resolveRiskConfig(overrides?: unknown): RiskRulesConfig {
  const cfg: RiskRulesConfig = structuredClone(DEFAULT_RISK_CONFIG);
  if (overrides === undefined || overrides === null) return cfg;
  const parsed = overridesSchema.parse(overrides);
  Object.assign(cfg.levels, parsed.levels);
  for (const [id, o] of Object.entries(parsed.rules ?? {})) {
    if (!cfg.rules[id]) throw new Error(`Unknown risk rule in overrides: ${id}`);
    cfg.rules[id] = { ...cfg.rules[id], ...o, params: { ...cfg.rules[id].params, ...o.params } };
  }
  if (!(cfg.levels.medium < cfg.levels.high && cfg.levels.high < cfg.levels.critical)) throw new Error('Risk level thresholds must be strictly increasing');
  return cfg;
}

export interface RiskRule {
  id: string;
  name: string;
  entityTypes: RiskEntityType[];
  /** Returns an explanation if the rule fires, otherwise null. Pure: depends only on features + settings. */
  evaluate(f: FeatureMap, s: RuleSetting): string | null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const RISK_RULES: RiskRule[] = [
  {
    id: 'visit.otp_failed_attempts', name: 'Repeated failed OTP attempts (visit)', entityTypes: ['visit'],
    evaluate: (f, s) => num(f.visit_otp_failed_attempts) >= s.threshold ? `${f.visit_otp_failed_attempts} incorrect OTP attempts on this visit (threshold ${s.threshold})` : null,
  },
  {
    id: 'visit.otp_locked', name: 'OTP locked after too many attempts', entityTypes: ['visit'],
    evaluate: (f, s) => num(f.visit_otp_locked_count) >= s.threshold ? `${f.visit_otp_locked_count} OTP(s) were locked for exceeding the attempt limit` : null,
  },
  {
    id: 'visit.excess_otp_issues', name: 'Unusually many OTPs requested', entityTypes: ['visit'],
    evaluate: (f, s) => num(f.visit_otp_issue_count) >= s.threshold ? `${f.visit_otp_issue_count} OTPs have been issued for this visit (threshold ${s.threshold})` : null,
  },
  {
    id: 'visit.missing_verification', name: 'Visit not verified', entityTypes: ['visit'],
    evaluate: (f, s) =>
      f.visit_is_verified === false && ['scheduled', 'otp_pending'].includes(String(f.visit_status)) && f.visit_hours_past_scheduled !== null && num(f.visit_hours_past_scheduled) >= s.threshold
        ? `Visit is ${Math.floor(num(f.visit_hours_past_scheduled))}h past its scheduled time without OTP verification (threshold ${s.threshold}h)` : null,
  },
  {
    id: 'patient.failed_otp_burst', name: 'Burst of failed OTP attempts (patient)', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_failed_otp_24h) >= s.threshold ? `${f.patient_failed_otp_24h} failed OTP attempts in the last 24h (threshold ${s.threshold})` : null,
  },
  {
    id: 'patient.visit_frequency', name: 'Unusual visit frequency', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_visits_7d) >= s.threshold ? `${f.patient_visits_7d} visits scheduled in the last 7 days (threshold ${s.threshold})` : null,
  },
  {
    id: 'patient.missed_visits', name: 'Repeated missed visits', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_missed_90d) >= s.threshold ? `${f.patient_missed_90d} missed visits in the last 90 days (threshold ${s.threshold})` : null,
  },
  {
    id: 'patient.unverified_visits', name: 'Multiple unverified past visits', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_unverified_overdue) >= s.threshold ? `${f.patient_unverified_overdue} past visits remain unverified (threshold ${s.threshold})` : null,
  },
  {
    id: 'patient.duplicate_reimbursements', name: 'Duplicate reimbursement requests (patient)', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_duplicate_reimbursements) >= s.threshold ? `${f.patient_duplicate_reimbursements} duplicate reimbursement request(s) detected` : null,
  },
  {
    id: 'patient.reimbursement_volume', name: 'High reimbursement volume', entityTypes: ['patient'],
    evaluate: (f, s) => num(f.patient_reimbursement_total_30d_cents) >= s.threshold ? `${num(f.patient_reimbursement_total_30d_cents) / 100} claimed in the last 30 days (threshold ${s.threshold / 100})` : null,
  },
  {
    id: 'reimbursement.duplicate', name: 'Duplicate reimbursement request', entityTypes: ['reimbursement'],
    evaluate: (f, s) => num(f.reimb_duplicate_count) >= s.threshold ? `${f.reimb_duplicate_count} other request(s) with the same visit, category and amount` : null,
  },
  {
    id: 'reimbursement.unverified_visit', name: 'Claim for unverified visit', entityTypes: ['reimbursement'],
    evaluate: (f) => f.reimb_visit_verified === false ? `Linked visit has status '${f.reimb_visit_status}' and is not OTP-verified` : null,
  },
  {
    id: 'reimbursement.amount_outlier', name: 'Unusual reimbursement amount', entityTypes: ['reimbursement'],
    evaluate: (f, s) => {
      const abs = s.params?.absoluteCents;
      if (abs !== undefined && num(f.reimb_amount_cents) >= abs) return `Amount ${num(f.reimb_amount_cents) / 100} exceeds the absolute limit ${abs / 100}`;
      if (f.reimb_amount_ratio_to_category_avg !== null && num(f.reimb_amount_ratio_to_category_avg) >= s.threshold) {
        return `Amount is ${num(f.reimb_amount_ratio_to_category_avg).toFixed(1)}x the average for category '${f.reimb_category}' (threshold ${s.threshold}x)`;
      }
      return null;
    },
  },
  {
    id: 'reimbursement.rapid_submission', name: 'Rapid repeated submissions', entityTypes: ['reimbursement'],
    evaluate: (f, s) => num(f.reimb_patient_count_24h) >= s.threshold ? `${f.reimb_patient_count_24h} requests from this patient in 24h (threshold ${s.threshold})` : null,
  },
];
