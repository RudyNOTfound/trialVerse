import type { AppConfig } from '../config/env';
import type { Logger } from '../config/logger';
import {
  MlError, levelForScore, describeIntegrityRequestProblem, describeRiskRequestProblem,
  type IntegrityEngine, type IntegrityModel, type IntegrityScanRequest, type IntegrityScanResult,
  type RiskAssessmentResult, type RiskEngine, type RiskModel, type RiskPredictionRequest,
} from './contracts';
import { HttpIntegrityModel, HttpRiskModel } from './httpModels';

/** What the rest of the application depends on. Nothing outside src/ml knows whether ML is enabled. */
export interface MlGateway {
  risk: RiskEngine;
  integrity: IntegrityEngine;
  /** True when an ML integrity model is configured. Only then is the (larger) `trialData` payload built and sent. */
  integritySendsTrialData: boolean;
}

/** Adapts an ML RiskModel to the RiskEngine interface (the model's score is authoritative; level derived from it). */
export class MlRiskEngine implements RiskEngine {
  constructor(private readonly model: RiskModel) {}
  get name() { return this.model.name; }
  get version() { return this.model.version; }
  async assess(req: RiskPredictionRequest): Promise<RiskAssessmentResult> {
    // An incomplete participant would only earn an HTTP 422: don't send it, fall back with a precise, data-free reason.
    const problem = describeRiskRequestProblem(req);
    if (problem) throw new MlError('invalid_request', problem);
    const out = await this.model.predict(req);
    return {
      entityType: req.entityType,
      entityId: req.entityId,
      score: Math.round(out.score * 10) / 10,
      level: levelForScore(out.score),
      triggeredRules: out.factors.map((f) => ({ ruleId: `ml:${f.name}`, name: f.name, weight: f.contribution, detail: f.detail ?? '' })),
      explanation: out.explanation,
      engine: { name: out.modelName, version: out.modelVersion },
      assessedAt: new Date().toISOString(),
      fallback: { used: false },
    };
  }
}

export class MlIntegrityEngine implements IntegrityEngine {
  constructor(private readonly model: IntegrityModel) {}
  get name() { return this.model.name; }
  get version() { return this.model.version; }
  async scan(req: IntegrityScanRequest): Promise<IntegrityScanResult> {
    const problem = describeIntegrityRequestProblem(req);
    if (problem) throw new MlError('invalid_request', `trialData failed validation (${problem})`);
    const out = await this.model.detect(req);
    return {
      engine: { name: out.modelName, version: out.modelVersion },
      windowStart: req.windowStart,
      windowEnd: req.windowEnd,
      findings: out.findings,
      scannedAt: new Date().toISOString(),
      fallback: { used: false },
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MlError('timeout', `Model call exceeded ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const reasonOf = (err: unknown) => (err instanceof MlError ? `${err.kind}: ${err.message}` : `model_error: ${(err as Error)?.message ?? 'unknown error'}`);

/**
 * Tries the primary (ML) engine; on ANY failure (timeout, bad response, thrown error) falls back to the
 * baseline engine and reports `fallback.used = true` with the reason. A model outage never fails a request.
 */
export class ResilientRiskEngine implements RiskEngine {
  constructor(private readonly primary: RiskEngine, private readonly baseline: RiskEngine, private readonly timeoutMs: number, private readonly logger: Logger) {}
  get name() { return this.primary.name; }
  get version() { return this.primary.version; }
  async assess(req: RiskPredictionRequest): Promise<RiskAssessmentResult> {
    try {
      return await withTimeout(this.primary.assess(req), this.timeoutMs);
    } catch (err) {
      const reason = reasonOf(err);
      this.logger.warn({ reason, entityType: req.entityType, entityId: req.entityId }, 'ML risk model failed; using baseline engine');
      const base = await this.baseline.assess(req);
      return { ...base, fallback: { used: true, reason } };
    }
  }
}

export class ResilientIntegrityEngine implements IntegrityEngine {
  constructor(private readonly primary: IntegrityEngine, private readonly baseline: IntegrityEngine, private readonly timeoutMs: number, private readonly logger: Logger) {}
  get name() { return this.primary.name; }
  get version() { return this.primary.version; }
  async scan(req: IntegrityScanRequest): Promise<IntegrityScanResult> {
    try {
      return await withTimeout(this.primary.scan(req), this.timeoutMs);
    } catch (err) {
      const reason = reasonOf(err);
      this.logger.warn({ reason }, 'ML integrity model failed; using baseline engine');
      const base = await this.baseline.scan(req);
      return { ...base, fallback: { used: true, reason } };
    }
  }
}

export interface GatewayDeps {
  config: AppConfig;
  logger: Logger;
  baselineRisk: RiskEngine;
  baselineIntegrity: IntegrityEngine;
  /** Override models (in-process integration, tests). When absent, HTTP models are built from config. */
  riskModel?: RiskModel;
  integrityModel?: IntegrityModel;
}

/** Wires baseline + optional ML engines. With ML disabled the baselines are used directly. */
export function createMlGateway(d: GatewayDeps): MlGateway {
  const { config, logger } = d;
  const http = (baseUrl: string, timeoutMs: number) => ({ baseUrl, timeoutMs, apiKey: config.ml.apiKey });

  let riskModel = d.riskModel;
  if (!riskModel && config.ml.risk.enabled && config.ml.risk.url) riskModel = new HttpRiskModel(http(config.ml.risk.url, config.ml.timeoutMs));
  let integrityModel = d.integrityModel;
  if (!integrityModel && config.ml.integrity.enabled && config.ml.integrity.url) integrityModel = new HttpIntegrityModel(http(config.ml.integrity.url, config.ml.integrityTimeoutMs));

  // Outer timeout slightly above the HTTP timeout so the HTTP layer reports the more precise error first.
  return {
    integritySendsTrialData: !!integrityModel,
    risk: riskModel ? new ResilientRiskEngine(new MlRiskEngine(riskModel), d.baselineRisk, config.ml.timeoutMs + 500, logger) : d.baselineRisk,
    integrity: integrityModel ? new ResilientIntegrityEngine(new MlIntegrityEngine(integrityModel), d.baselineIntegrity, config.ml.integrityTimeoutMs + 500, logger) : d.baselineIntegrity,
  };
}
