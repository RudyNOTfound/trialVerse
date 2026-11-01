import type { Ctx, Actor } from '../../context';
import { AppError } from '../../utils/errors';
import { inTransaction } from '../../utils/db';
import { appendAuditEvent, rowToEvent, verifyChain, type ChainVerification } from './chain';
import type { z } from 'zod';
import type { auditListQuery } from './schemas';

export type AuditListQuery = z.infer<typeof auditListQuery>;

export function createAuditService(ctx: Ctx) {
  const { db } = ctx;
  return {
    list(q: AuditListQuery) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (cond: string, v: unknown) => { where.push(cond); params.push(v); };
      if (q.actorId) add('actor_id = ?', q.actorId);
      if (q.action) add('action = ?', q.action);
      if (q.entityType) add('entity_type = ?', q.entityType);
      if (q.entityId) add('entity_id = ?', q.entityId);
      if (q.from) add('created_at >= ?', q.from);
      if (q.to) add('created_at <= ?', q.to);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w}`).get(...params) as { c: number }).c;
      const rows = db
        .prepare(`SELECT * FROM audit_logs ${w} ORDER BY seq ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`)
        .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: rows.map(rowToEvent), total };
    },

    get(id: string) {
      const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as any;
      if (!row) throw AppError.notFound('Audit event');
      return rowToEvent(row);
    },

    /** Verifies the chain and records the attempt (success or failure) in the chain itself. */
    verify(actor: Actor): ChainVerification {
      const result = verifyChain(db);
      inTransaction(db, () =>
        appendAuditEvent(db, {
          actorId: actor.id,
          action: result.valid ? 'audit.chain_verified' : 'audit.chain_verification_failed',
          entityType: 'audit_chain',
          entityId: 'main',
          metadata: {
            eventsChecked: result.eventsChecked,
            valid: result.valid,
            errorCount: result.errors.length,
            firstError: result.errors[0] ?? null,
          },
        }),
      );
      if (!result.valid) ctx.logger.error({ errors: result.errors.slice(0, 5) }, 'AUDIT CHAIN INTEGRITY FAILURE');
      return result;
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
