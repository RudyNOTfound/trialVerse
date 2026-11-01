import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { CONTRACT_VERSION, FEATURE_SCHEMA_VERSION, type RiskAssessmentResult, type RiskEntityType, type RiskPredictionRequest } from '../../ml/contracts';
import { inTransaction, mapRow, nowIso, orderBy } from '../../utils/db';
import { AppError } from '../../utils/errors';
import { appendAuditEvent } from '../audit/chain';
import { buildFeatures } from './features';
import { DEFAULT_RISK_CONFIG } from './rules';
import type { assessBody, listAssessmentsQuery } from './schemas';

export interface RiskAssessmentDto extends Omit<RiskAssessmentResult, 'engine' | 'fallback' | 'assessedAt'> {
  id: string; engine: { name: string; version: string }; fallback: { used: boolean; reason: string | null };
  assessedAt: string; requestedBy: string | null; createdAt: string;
}

const JSON_COLS = ['triggered_rules'];

function toDto(row: Record<string, unknown>): RiskAssessmentDto {
  const r = mapRow<Record<string, any>>(row, JSON_COLS)!;
  return {
    id: r.id, entityType: r.entityType, entityId: r.entityId, score: r.score, level: r.level,
    triggeredRules: r.triggeredRules, explanation: r.explanation,
    engine: { name: r.engineName, version: r.engineVersion },
    fallback: { used: Boolean(r.fallbackUsed), reason: r.fallbackReason ?? null },
    assessedAt: r.assessedAt, requestedBy: r.requestedBy, createdAt: r.createdAt,
  };
}

export function createRiskService(ctx: Ctx) {
  const { db } = ctx;

  const get = (id: string): RiskAssessmentDto => {
    const row = db.prepare('SELECT * FROM risk_assessments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('Risk assessment');
    return toDto(row);
  };

  return {
    get,

    /** Gathers features, runs the configured engine (baseline or ML-with-fallback), persists + audits the result. */
    async assess(input: z.infer<typeof assessBody>, actor: Actor | null): Promise<RiskAssessmentDto> {
      const request: RiskPredictionRequest = {
        contractVersion: CONTRACT_VERSION,
        requestId: randomUUID(),
        entityType: input.entityType as RiskEntityType,
        entityId: input.entityId,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        features: buildFeatures(db, input.entityType, input.entityId),
        requestedAt: nowIso(),
      };
      const result = await ctx.ml.risk.assess(request);

      const id = randomUUID();
      inTransaction(db, () => {
        db.prepare(
          `INSERT INTO risk_assessments (id, entity_type, entity_id, score, level, triggered_rules, explanation, engine_name, engine_version,
             fallback_used, fallback_reason, requested_by, assessed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, result.entityType, result.entityId, result.score, result.level, JSON.stringify(result.triggeredRules), result.explanation,
          result.engine.name, result.engine.version, result.fallback.used ? 1 : 0, result.fallback.reason ?? null, actor?.id ?? null, result.assessedAt, nowIso());
        appendAuditEvent(db, {
          actorId: actor?.id ?? null, action: 'risk.assessed', entityType: result.entityType, entityId: result.entityId,
          metadata: {
            assessmentId: id, score: result.score, level: result.level, engine: result.engine.name,
            rules: result.triggeredRules.map((r) => r.ruleId), fallbackUsed: result.fallback.used,
          },
        });
      });
      return get(id);
    },

    list(q: z.infer<typeof listAssessmentsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [['entity_type', q.entityType], ['entity_id', q.entityId], ['level', q.level]] as const) if (v) { where.push(`${col} = ?`); params.push(v); }
      if (q.minScore !== undefined) { where.push('score >= ?'); params.push(q.minScore); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM risk_assessments ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { assessedAt: 'assessed_at', score: 'score' }, 'assessed_at');
      const rows = db.prepare(`SELECT * FROM risk_assessments ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
      return { items: rows.map(toDto), total };
    },

    /** Active rule configuration (defaults merged with env overrides), for transparency / UI. */
    rules() {
      const engine = ctx.ml.risk as unknown as { config?: typeof DEFAULT_RISK_CONFIG };
      return { engine: { name: ctx.ml.risk.name, version: ctx.ml.risk.version }, baselineConfig: engine.config ?? null };
    },
  };
}

export type RiskService = ReturnType<typeof createRiskService>;
