import { randomUUID } from 'node:crypto';
import { mapRows, nowIso, type DB } from '../../utils/db';
import { createLookups } from '../../utils/lookups';

export interface StatusHistoryDto {
  id: string; entityType: string; entityId: string; field: string; fromStatus: string | null;
  toStatus: string; actorId: string | null; note: string | null; createdAt: string;
  /** Embedded display name of the actor (additive, read-only). */
  actorName?: string | null;
}

export function recordStatus(db: DB, e: {
  entityType: 'reimbursement' | 'action'; entityId: string; field?: string; from: string | null; to: string; actorId: string | null; note?: string | null;
}): void {
  db.prepare(
    `INSERT INTO status_history (id, entity_type, entity_id, field, from_status, to_status, actor_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), e.entityType, e.entityId, e.field ?? 'status', e.from, e.to, e.actorId, e.note ?? null, nowIso());
}

export function listStatusHistory(db: DB, entityType: string, entityId: string): StatusHistoryDto[] {
  const rows = mapRows<StatusHistoryDto>(
    db.prepare('SELECT * FROM status_history WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, rowid ASC').all(entityType, entityId) as any[],
  );
  const users = createLookups(db).users(rows.map((r) => r.actorId));
  return rows.map((r) => ({ ...r, actorName: r.actorId ? users.get(r.actorId)?.name ?? null : null }));
}
