/**
 * ML INTEGRATION CONTRACTS (version 1.0)
 * ------------------------------------------------------------------
 * These types/schemas are the ONLY coupling point between the core backend (Person A) and
 * ML models (Person B). Changing them is a breaking change and requires a bump of CONTRACT_VERSION.
 *
 * Two integration styles are supported without touching business logic:
 *   1. HTTP model service  -> implement POST /v1/risk/predict and POST /v1/integrity/predict (see HttpRiskModel).
 *   2. In-process adapter  -> implement the RiskModel / IntegrityModel interfaces and register via createMlGateway.
 */
import { z } from 'zod';

export const CONTRACT_VERSION = '1.0';
export const FEATURE_SCHEMA_VERSION = '1';

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

export type MlErrorKind = 'timeout' | 'unavailable' | 'invalid_response' | 'model_error' | 'disabled';

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
