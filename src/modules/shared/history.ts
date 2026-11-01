import { randomUUID } from 'node:crypto';
import { mapRows, nowIso, type DB } from '../../utils/db';

export interface StatusHistoryDto {
  id: string; entityType: string; entityId: string; field: string; fromStatus: string | null;
  toStatus: string; actorId: string | null; note: string | null; createdAt: string;
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
  return mapRows<StatusHistoryDto>(
    db.prepare('SELECT * FROM status_history WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, rowid ASC').all(entityType, entityId) as any[],
  );
}
