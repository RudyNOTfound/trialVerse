import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { CONTRACT_VERSION, type AuditEventSummary, type IntegrityFinding, type IntegrityScanRequest, type IntegrityScanResult } from '../../ml/contracts';
import { sha256 } from '../../utils/crypto';
import { inTransaction, mapRow, mapRows, nowIso, orderBy } from '../../utils/db';
import { AppError } from '../../utils/errors';
import { createLookups, entityLabels } from '../../utils/lookups';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent, rowToEvent, verifyChain } from '../audit/chain';
import type { listAlertsQuery, scanBody } from './schemas';

type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface IntegrityAlertDto {
  id: string; ruleId: string; entityType: string; entityId: string; severity: string; status: AlertStatus; message: string;
  details: Record<string, unknown>; source: string; resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null;
  detectedAt: string; createdAt: string; updatedAt: string;
  /** Embedded display names (additive, read-only). */
  resolvedByName?: string | null; entityName?: string | null;
}

export const ALERT_TRANSITIONS: TransitionMap<AlertStatus> = {
  open: ['acknowledged', 'resolved', 'dismissed'],
  acknowledged: ['open', 'resolved', 'dismissed'],
  resolved: ['open'],
  dismissed: ['open'],
};

const MAX_EVENTS = 5000;
const MAX_ROWS = 2000;
const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;

export interface ScanSummary {
  engine: { name: string; version: string };
  fallback: { used: boolean; reason?: string };
  windowStart: string; windowEnd: string;
  eventsScanned: number; findings: number; newAlerts: number; existingAlerts: number;
  alerts: IntegrityAlertDto[];
}

export function createIntegrityService(ctx: Ctx) {
  const { db } = ctx;

  const lookups = createLookups(db);
  const withNames = (items: IntegrityAlertDto[]): IntegrityAlertDto[] => {
    const u = lookups.users(items.map((a) => a.resolvedBy));
    const labels = entityLabels(db, items);
    return items.map((a) => ({ ...a, resolvedByName: a.resolvedBy ? u.get(a.resolvedBy)?.name ?? null : null, entityName: labels.get(`${a.entityType}:${a.entityId}`) ?? null }));
  };

  const get = (id: string): IntegrityAlertDto => {
    const a = mapRow<IntegrityAlertDto>(db.prepare('SELECT * FROM integrity_alerts WHERE id = ?').get(id) as any, ['details']);
    if (!a) throw AppError.notFound('Integrity alert');
    return withNames([a])[0]!;
  };

  /** Assembles the engine input (also the ML contract payload) from the database. */
  function buildScanRequest(windowHours: number, now = new Date()): { request: IntegrityScanRequest; eventsScanned: number } {
    const windowEnd = now.toISOString();
    const windowStart = new Date(now.getTime() - windowHours * 3600_000).toISOString();
    const rows = db.prepare('SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY seq DESC LIMIT ?').all(windowStart, MAX_EVENTS) as any[];
    const events: AuditEventSummary[] = rows.map(rowToEvent).reverse().map((e) => ({
      id: e.id, seq: e.seq, actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId, createdAt: e.createdAt, metadata: e.metadata,
    }));
    const reimbursements = (db.prepare(
      `SELECT id, patient_id, visit_id, category, amount_cents, status, requested_by, reviewed_by, created_at FROM reimbursements
       WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    ).all(windowStart, MAX_ROWS) as any[]).map((r) => ({
      id: r.id, patientId: r.patient_id, visitId: r.visit_id, category: r.category, amountCents: r.amount_cents, status: r.status,
      requestedBy: r.requested_by, reviewedBy: r.reviewed_by, createdAt: r.created_at,
    }));
    // All open visits that are past their scheduled time, regardless of window.
    const openVisits = (db.prepare(
      `SELECT id, patient_id, status, scheduled_at, verified_at FROM visits WHERE status IN ('scheduled','otp_pending') AND scheduled_at < ? ORDER BY scheduled_at LIMIT ?`,
    ).all(windowEnd, MAX_ROWS) as any[]).map((v) => ({ id: v.id, patientId: v.patient_id, status: v.status, scheduledAt: v.scheduled_at, verifiedAt: v.verified_at }));
    const chain = verifyChain(db);
    return {
      eventsScanned: events.length,
      request: {
        contractVersion: CONTRACT_VERSION, requestId: randomUUID(), windowStart, windowEnd, events, reimbursements, openVisits,
        chain: { valid: chain.valid, eventsChecked: chain.eventsChecked, errorCount: chain.errors.length, firstError: chain.errors[0] ? { type: chain.errors[0].type, seq: chain.errors[0].seq, message: chain.errors[0].message } : null },
      },
    };
  }

  const fingerprint = (source: string, f: IntegrityFinding) => sha256([source, f.ruleId, f.entityType, f.entityId, f.dedupeKey ?? ''].join('|'));

  function persistFindings(result: IntegrityScanResult, actor: Actor | null): { created: string[]; existing: number } {
    const created: string[] = [];
    let existing = 0;
    inTransaction(db, () => {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO integrity_alerts (id, rule_id, entity_type, entity_id, severity, status, message, details, source, fingerprint, detected_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of result.findings) {
        const id = randomUUID();
        const now = nowIso();
        const info = insert.run(id, f.ruleId, f.entityType, f.entityId, f.severity, f.message, JSON.stringify(f.details), result.engine.name, fingerprint(result.engine.name, f), result.scannedAt, now, now);
        if (info.changes === 1) {
          created.push(id);
          appendAuditEvent(db, {
            actorId: actor?.id ?? null, action: 'integrity.alert_raised', entityType: f.entityType, entityId: f.entityId,
            metadata: { alertId: id, ruleId: f.ruleId, severity: f.severity, engine: result.engine.name },
          });
        } else existing++;
      }
      appendAuditEvent(db, {
        actorId: actor?.id ?? null, action: 'integrity.scan_completed', entityType: 'integrity_scan', entityId: 'main',
        metadata: { engine: result.engine.name, findings: result.findings.length, newAlerts: created.length, fallbackUsed: result.fallback.used },
      });
    });
    return { created, existing };
  }

  return {
    get,

    async scan(input: z.infer<typeof scanBody>, actor: Actor | null): Promise<ScanSummary> {
      const { request, eventsScanned } = buildScanRequest(input.windowHours);
      const result = await ctx.ml.integrity.scan(request);
      const { created, existing } = persistFindings(result, actor);
      return {
        engine: result.engine, fallback: result.fallback, windowStart: result.windowStart, windowEnd: result.windowEnd,
        eventsScanned, findings: result.findings.length, newAlerts: created.length, existingAlerts: existing, alerts: created.map(get),
      };
    },

    list(q: z.infer<typeof listAlertsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [['status', q.status], ['severity', q.severity], ['rule_id', q.ruleId], ['entity_type', q.entityType], ['entity_id', q.entityId]] as const) {
        if (v) { where.push(`${col} = ?`); params.push(v); }
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM integrity_alerts ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { detectedAt: 'detected_at', severity: SEVERITY_RANK }, 'detected_at');
      const rows = db.prepare(`SELECT * FROM integrity_alerts ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: withNames(mapRows<IntegrityAlertDto>(rows, ['details'])), total };
    },

    updateStatus(id: string, status: AlertStatus, note: string | undefined, actor: Actor): IntegrityAlertDto {
      inTransaction(db, () => {
        const a = get(id);
        assertTransition('Integrity alert', ALERT_TRANSITIONS, a.status, status);
        const closing = status === 'resolved' || status === 'dismissed';
        const now = nowIso();
        db.prepare(`UPDATE integrity_alerts SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ? WHERE id = ?`)
          .run(status, closing ? actor.id : null, closing ? now : null, closing ? note ?? null : null, now, id);
        appendAuditEvent(db, {
          actorId: actor.id, action: 'integrity.alert_status_changed', entityType: 'integrity_alert', entityId: id,
          metadata: { from: a.status, to: status, ruleId: a.ruleId },
        });
      });
      return get(id);
    },

    rules() {
      const engine = ctx.ml.integrity as unknown as { config?: unknown };
      return { engine: { name: ctx.ml.integrity.name, version: ctx.ml.integrity.version }, baselineConfig: engine.config ?? null };
    },
  };
}

export type IntegrityService = ReturnType<typeof createIntegrityService>;
