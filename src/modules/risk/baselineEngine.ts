import {
  CONTRACT_VERSION, levelForScore,
  type RiskAssessmentResult, type RiskEngine, type RiskPredictionRequest, type TriggeredRule,
} from '../../ml/contracts';
import { RISK_RULES, resolveRiskConfig, type RiskRulesConfig } from './rules';

export const BASELINE_RISK_VERSION = '1.0.0';

/**
 * Deterministic, configurable, rule-based risk scorer. Needs nothing but the feature map, so it works
 * without ML and doubles as the fallback when an ML model is unavailable.
 * Score = min(100, sum of weights of triggered rules).
 */
export class BaselineRiskEngine implements RiskEngine {
  readonly name = 'baseline-rules';
  readonly version = BASELINE_RISK_VERSION;
  readonly config: RiskRulesConfig;

  constructor(overrides?: unknown) {
    this.config = resolveRiskConfig(overrides);
  }

  async assess(req: RiskPredictionRequest): Promise<RiskAssessmentResult> {
    if (req.contractVersion.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) throw new Error(`Unsupported contractVersion ${req.contractVersion}`);
    const triggered: TriggeredRule[] = [];
    for (const rule of RISK_RULES) {
      const setting = this.config.rules[rule.id];
      if (!setting?.enabled || !rule.entityTypes.includes(req.entityType)) continue;
      const detail = rule.evaluate(req.features, setting);
      if (detail) triggered.push({ ruleId: rule.id, name: rule.name, weight: setting.weight, detail });
    }
    const score = Math.min(100, triggered.reduce((s, r) => s + r.weight, 0));
    const level = levelForScore(score, this.config.levels);
    const explanation = triggered.length === 0
      ? `No risk rules triggered for this ${req.entityType}.`
      : `${level.toUpperCase()} risk (score ${score}/100) for this ${req.entityType}: ${triggered.map((t) => t.detail).join('; ')}.`;
    return {
      entityType: req.entityType, entityId: req.entityId, score, level, triggeredRules: triggered, explanation,
      engine: { name: this.name, version: this.version }, assessedAt: new Date().toISOString(), fallback: { used: false },
    };
  }
}
