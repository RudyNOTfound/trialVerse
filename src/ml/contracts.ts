/**
 * ML INTEGRATION CONTRACTS (version 1.1)
 * ------------------------------------------------------------------
 * These types/schemas are the ONLY coupling point between the core backend (Person A) and
 * ML models (Person B). Changing them is a breaking change and requires a bump of CONTRACT_VERSION.
 *
 * v1.1 is additive over v1.0 (peers compare MAJOR versions only):
 *   - risk:      participant (`entityType: 'patient'`) requests carry the dropout-model features, `featureSchemaVersion: '2'`
 *   - integrity: `IntegrityScanRequest.trialData` (sites, participants, visits, ECG references) enables the visit rules,
 *                site statistics and ECG duplicate detection. Without it only the audit rules run (v1.0 behaviour).
 * The source of truth for field names/constraints is the Python service: ml-service/app/api/schemas.py and
 * ml-service/docs/phase6/01_CONTRACT_SPECIFICATION.md. See docs/ML_INTEGRATION.md.
 *
 * Two integration styles are supported without touching business logic:
 *   1. HTTP model service  -> implement POST /v1/risk/predict and POST /v1/integrity/predict (see HttpRiskModel).
 *   2. In-process adapter  -> implement the RiskModel / IntegrityModel interfaces and register via createMlGateway.
 */
import { z } from 'zod';
import { isCanonicalIanaTimezone } from '../utils/timezone';

export const CONTRACT_VERSION = '1.1';
/** Current feature schema (participant dropout features). */
export const FEATURE_SCHEMA_VERSION = '2';
/** Visit and reimbursement feature sets did not change in v1.1, so they keep schema '1'. */
export const LEGACY_FEATURE_SCHEMA_VERSION = '1';
export const featureSchemaVersionFor = (entityType: RiskEntityType): string => (entityType === 'patient' ? FEATURE_SCHEMA_VERSION : LEGACY_FEATURE_SCHEMA_VERSION);

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Severity = RiskLevel;
export type RiskEntityType = 'patient' | 'visit' | 'reimbursement';

export type FeatureValue = number | boolean | string | null;
export type FeatureMap = Record<string, FeatureValue>;

// ---------------------------------------------------------------- Risk: model I/O

export interface RiskPredictionRequest {
  contractVersion: string;
  requestId: string;
  entityType: RiskEntityType;
  entityId: string;
  /** Flat, JSON-safe features. Names and semantics are listed in docs/ML_INTEGRATION.md. */
  featureSchemaVersion: string;
  features: FeatureMap;
  requestedAt: string;
}

// ---- participant (patient) features, featureSchemaVersion '2' ----------------------------------------------------------
/** Keys the dropout model REQUIRES. A null/missing value makes the Python service answer HTTP 422 (it never scores on defaults). */
export const PATIENT_V2_REQUIRED_FEATURES = [
  'site_id', 'distance_km', 'daily_wage_worker', 'scheduled_visits', 'missed_reminders', 'side_effects_reported', 'phone_changed', 'visits_missed',
] as const;
/** Optional model inputs: may be null (the model imputes and discloses it). */
export const PATIENT_V2_OPTIONAL_FEATURES = ['age', 'reimbursement_delay_days'] as const;

const intIn = (min: number, max: number) => z.number().int().min(min).max(max);
export const patientFeaturesV2Schema = z.object({
  site_id: z.string().min(1).max(64),
  age: z.number().min(0).max(120).nullable().optional(),
  distance_km: z.number().min(0).max(2000),
  daily_wage_worker: z.union([z.literal(0), z.literal(1)]),
  scheduled_visits: intIn(1, 100),
  missed_reminders: intIn(0, 100),
  reimbursement_delay_days: z.number().min(0).max(730).nullable().optional(),
  side_effects_reported: z.union([z.literal(0), z.literal(1)]),
  phone_changed: z.union([z.literal(0), z.literal(1)]),
  visits_missed: intIn(0, 100),
}).passthrough().refine((f) => f.visits_missed <= f.scheduled_visits, { message: 'visits_missed must not exceed scheduled_visits', path: ['visits_missed'] });

/**
 * Checks a participant risk request BEFORE it is sent. Returns a short, data-free reason (feature names only, never values),
 * or null when the request is acceptable. An incomplete participant is not sent: it would only produce an HTTP 422.
 */
export function describeRiskRequestProblem(req: RiskPredictionRequest): string | null {
  if (req.entityType !== 'patient' || req.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) return null; // v1 features: nothing to pre-check
  const missing = PATIENT_V2_REQUIRED_FEATURES.filter((k) => req.features[k] === null || req.features[k] === undefined);
  if (missing.length) return `missing required features: ${missing.join(', ')}`;
  const parsed = patientFeaturesV2Schema.safeParse(req.features);
  if (parsed.success) return null;
  const bad = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))];
  return `invalid feature values: ${bad.join(', ')}`;
}

export const riskPredictionResponseSchema = z.object({
  contractVersion: z.string(),
  requestId: z.string(),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
  /** 0 (no risk) .. 100 (maximum risk) */
  score: z.number().min(0).max(100),
  /** Optional model confidence 0..1 */
  confidence: z.number().min(0).max(1).optional(),
  /** Top contributing factors, used for explainability. */
  factors: z.array(z.object({ name: z.string(), contribution: z.number(), detail: z.string().optional() })).max(50).default([]),
  explanation: z.string().max(2000),
  /** Additive in v1.1 (ignored by consumers that do not know it): the engine's own category, NOT the platform's 25/50/75 level. */
  retentionRiskLevel: z.enum(['low', 'medium', 'high']).optional(),
  recommendedActions: z.array(z.record(z.unknown())).max(50).optional(),
});
export type RiskPredictionResponse = z.infer<typeof riskPredictionResponseSchema>;

/** Implement this to plug in an ML risk model in-process. */
export interface RiskModel {
  readonly name: string;
  readonly version: string;
  predict(request: RiskPredictionRequest, options?: { signal?: AbortSignal }): Promise<RiskPredictionResponse>;
}

// ---------------------------------------------------------------- Integrity: model I/O

export interface AuditEventSummary {
  id: string; seq: number; actorId: string | null; action: string; entityType: string; entityId: string;
  createdAt: string; metadata: Record<string, unknown>;
}
export interface ReimbursementSnapshot {
  id: string; patientId: string; visitId: string; category: string; amountCents: number; status: string;
  requestedBy: string; reviewedBy: string | null; createdAt: string;
}
export interface VisitSnapshot {
  id: string; patientId: string; status: string; scheduledAt: string; verifiedAt: string | null;
}
export interface ChainSummary { valid: boolean; eventsChecked: number; errorCount: number; firstError: { type: string; seq: number | null; message: string } | null }

// ---- trialData (contract v1.1, optional) -------------------------------------------------------------------------------
// Mirrors ml-service/app/api/schemas.py (TrialData and friends). Python answers HTTP 422 for the WHOLE call if any rule below is
// broken, so the backend validates with this schema first and never sends a request it knows will be rejected.
export const TRIAL_DATA_LIMITS = { sites: 200, participants: 5000, visits: 20000, ecgs: 2000 } as const;
export const OTP_EXCEPTION_REASONS = ['device_offline', 'participant_unreachable', 'otp_delivery_failed', 'coordinator_override', 'other'] as const;
export type OtpExceptionReason = (typeof OTP_EXCEPTION_REASONS)[number];
export const CONTRACT_VISIT_STATUSES = ['scheduled', 'otp_pending', 'verified', 'completed', 'missed', 'cancelled'] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
/** ISO-8601 instant that MUST carry 'Z' or a UTC offset. */
const isoWithOffset = z.string().regex(ISO).refine((v) => /(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO-8601 instant with Z or a UTC offset');
/** ISO-8601; an offset-less value is accepted by the service and reported there as a data-quality finding (never guessed). */
const isoLoose = z.string().regex(ISO).refine((v) => !Number.isNaN(Date.parse(v)), 'must be ISO-8601');
const id100 = z.string().min(1).max(100);
const measurement = z.number().finite().nullable().optional();

export const trialSiteRefSchema = z.object({
  siteId: id100,
  siteCode: z.string().min(1).max(64),
  timezone: z.string().refine(isCanonicalIanaTimezone, "must be a canonical IANA name such as 'Asia/Kolkata'"),
});
export const trialParticipantRefSchema = z.object({ participantId: id100, siteId: id100, droppedOut: z.boolean() });
export const trialVisitSchema = z.object({
  visitId: id100,
  participantId: id100,
  siteId: id100,
  visitNumber: z.number().int().min(1).max(100),
  visitType: z.string().max(60).optional(),
  status: z.enum(CONTRACT_VISIT_STATUSES),
  scheduledAt: isoWithOffset,
  performedAt: isoLoose.nullable().optional(),
  enteredAt: isoLoose.nullable().optional(),
  otpVerified: z.boolean().nullable().optional(),
  otpExceptionReason: z.enum(OTP_EXCEPTION_REASONS).nullable().optional(),
  systolicBp: measurement,
  diastolicBp: measurement,
  heartRate: measurement,
  weightKg: measurement,
  glucoseMgDl: measurement,
  ecgRecordId: id100.nullable().optional(),
}).refine((v) => v.otpExceptionReason == null || v.otpVerified === false, { message: 'otpExceptionReason is only allowed when otpVerified is false', path: ['otpExceptionReason'] });
export const trialEcgRefSchema = z.object({
  ecgRecordId: id100, visitId: id100, participantId: id100, siteId: id100,
  /** Path relative to the shared ECG directory (ML_ECG_DIR). Never an absolute path; image bytes are never sent. */
  imageRef: z.string().max(500),
});

export const trialDataSchema = z.object({
  scope: z.object({ trialId: id100, asOf: isoWithOffset }),
  sites: z.array(trialSiteRefSchema).max(TRIAL_DATA_LIMITS.sites),
  participants: z.array(trialParticipantRefSchema).max(TRIAL_DATA_LIMITS.participants),
  visits: z.array(trialVisitSchema).max(TRIAL_DATA_LIMITS.visits),
  ecgs: z.array(trialEcgRefSchema).max(TRIAL_DATA_LIMITS.ecgs).optional(),
}).superRefine((t, ctx) => {
  // Referential integrity, exactly as the Python service enforces it.
  const add = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const unique = (ids: string[], what: string): Set<string> => {
    const seen = new Set<string>();
    for (const i of ids) { if (seen.has(i)) add(`duplicate ${what}`); seen.add(i); }
    return seen;
  };
  const sites = unique(t.sites.map((x) => x.siteId), 'siteId');
  const parts = unique(t.participants.map((x) => x.participantId), 'participantId');
  unique(t.visits.map((x) => x.visitId), 'visitId');
  if (t.participants.some((p) => !sites.has(p.siteId))) add('a participant references an unknown siteId');
  const byVisit = new Map(t.visits.map((v) => [v.visitId, v]));
  for (const v of t.visits) {
    if (!sites.has(v.siteId)) add('a visit references an unknown siteId');
    if (!parts.has(v.participantId)) add('a visit references an unknown participantId');
  }
  if (t.ecgs) {
    const records = unique(t.ecgs.map((e) => e.ecgRecordId), 'ecgRecordId');
    for (const e of t.ecgs) {
      const v = byVisit.get(e.visitId);
      if (!v || !sites.has(e.siteId) || !parts.has(e.participantId)) add('an ECG references an unknown visit, participant or site');
      else if (v.siteId !== e.siteId || v.participantId !== e.participantId) add('an ECG disagrees with its visit on site or participant');
    }
    for (const v of t.visits) if (v.ecgRecordId != null && !records.has(v.ecgRecordId)) add('a visit references an ecgRecordId that is not in ecgs[]');
  }
});
export type TrialData = z.infer<typeof trialDataSchema>;
export type TrialSiteRef = z.infer<typeof trialSiteRefSchema>;
export type TrialParticipantRef = z.infer<typeof trialParticipantRefSchema>;
export type TrialVisit = z.infer<typeof trialVisitSchema>;
export type TrialEcgRef = z.infer<typeof trialEcgRefSchema>;

export interface IntegrityScanRequest {
  contractVersion: string;
  requestId: string;
  windowStart: string;
  windowEnd: string;
  events: AuditEventSummary[];
  reimbursements: ReimbursementSnapshot[];
  /** Visits that are past their scheduled time and not yet verified. */
  openVisits: VisitSnapshot[];
  chain: ChainSummary;
  /** v1.1, optional. Absent => the service runs the audit rules only. One trial per request (`trialData.scope.trialId`). */
  trialData?: TrialData;
}

/** Returns a short, data-free reason when `trialData` would be rejected by the service, otherwise null. */
export function describeIntegrityRequestProblem(req: IntegrityScanRequest): string | null {
  if (!req.trialData) return null;
  const parsed = trialDataSchema.safeParse(req.trialData);
  if (parsed.success) return null;
  const where = [...new Set(parsed.error.issues.slice(0, 3).map((i) => `${i.path.slice(0, 3).join('.') || 'trialData'}: ${i.message}`))];
  return where.join('; ');
}

export const integrityFindingSchema = z.object({
  ruleId: z.string().min(1).max(100),
  entityType: z.string().min(1).max(50),
  entityId: z.string().min(1).max(100),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  /** Optional anomaly score 0..1 */
  score: z.number().min(0).max(1).optional(),
  message: z.string().min(1).max(1000),
  details: z.record(z.unknown()).default({}),
  /** Distinguishes separate occurrences for the same rule+entity; findings with equal keys are de-duplicated. */
  dedupeKey: z.string().max(200).optional(),
});
export type IntegrityFinding = z.infer<typeof integrityFindingSchema>;

export const integrityScanResponseSchema = z.object({
  contractVersion: z.string(),
  requestId: z.string(),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
  findings: z.array(integrityFindingSchema).max(1000),
});
export type IntegrityScanResponse = z.infer<typeof integrityScanResponseSchema>;

/** Implement this to plug in an ML integrity/anomaly model in-process. */
export interface IntegrityModel {
  readonly name: string;
  readonly version: string;
  detect(request: IntegrityScanRequest, options?: { signal?: AbortSignal }): Promise<IntegrityScanResponse>;
}

// ---------------------------------------------------------------- Engine-level results (what the core app consumes)

export interface TriggeredRule { ruleId: string; name: string; weight: number; detail: string }

export interface FallbackInfo { used: boolean; reason?: string }

export interface RiskAssessmentResult {
  entityType: RiskEntityType;
  entityId: string;
  score: number;
  level: RiskLevel;
  triggeredRules: TriggeredRule[];
  explanation: string;
  engine: { name: string; version: string };
  assessedAt: string;
  fallback: FallbackInfo;
}

export interface IntegrityScanResult {
  engine: { name: string; version: string };
  windowStart: string;
  windowEnd: string;
  findings: IntegrityFinding[];
  scannedAt: string;
  fallback: FallbackInfo;
}

/** Anything that can score risk: the rule-based baseline, an ML adapter, or a resilient composite. */
export interface RiskEngine {
  readonly name: string;
  readonly version: string;
  assess(request: RiskPredictionRequest): Promise<RiskAssessmentResult>;
}

/** Anything that can detect integrity problems. */
export interface IntegrityEngine {
  readonly name: string;
  readonly version: string;
  scan(request: IntegrityScanRequest): Promise<IntegrityScanResult>;
}

export type MlErrorKind = 'timeout' | 'unavailable' | 'invalid_response' | 'model_error' | 'disabled' | 'invalid_request' | 'unauthorized';

/** Failure of an ML model call. Always triggers fallback to the baseline engine. */
export class MlError extends Error {
  constructor(public readonly kind: MlErrorKind, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MlError';
  }
}

export interface LevelThresholds { medium: number; high: number; critical: number }
export const DEFAULT_LEVELS: LevelThresholds = { medium: 25, high: 50, critical: 75 };

export function levelForScore(score: number, t: LevelThresholds = DEFAULT_LEVELS): RiskLevel {
  if (score >= t.critical) return 'critical';
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  return 'low';
}
