import type { Ctx } from '../../context';
import { createLookups } from '../../utils/lookups';

export interface VisitHistoryEntry {
  id: string;
  at: string;
  /** Raw audit action, e.g. `otp.verified`. */
  action: string;
  kind: 'schedule' | 'edit' | 'otp' | 'status';
  label: string;
  actor: { id: string; name: string | null; role: string | null } | null;
  from?: string; to?: string;
  /** Present for edits that moved the visit. */
  scheduledAt?: { from: string; to: string };
  changedFields?: string[];
  /** OTP failures: `incorrect_code`, `expired`, ... plus the attempt counters. Never the code. */
  reason?: string; attempt?: number; maxAttempts?: number;
  note?: string;
}

const LABELS: Record<string, { label: string; kind: VisitHistoryEntry['kind'] }> = {
  'visit.created': { label: 'Visit scheduled', kind: 'schedule' },
  'visit.updated': { label: 'Visit details changed', kind: 'edit' },
  'otp.issued': { label: 'OTP issued', kind: 'otp' },
  'otp.verify_failed': { label: 'OTP verification failed', kind: 'otp' },
  'otp.locked': { label: 'OTP locked after too many attempts', kind: 'otp' },
  'otp.verified': { label: 'OTP verified', kind: 'otp' },
  'visit.verified': { label: 'Visit marked verified', kind: 'status' },
  'visit.completed': { label: 'Visit completed', kind: 'status' },
  'visit.missed': { label: 'Visit marked missed', kind: 'status' },
  'visit.cancelled': { label: 'Visit cancelled', kind: 'status' },
};

interface Row { id: string; seq: number; actor_id: string | null; action: string; metadata: string; created_at: string }

/**
 * Read-only projection of the audit log for one visit. It exposes a fixed allow-list of metadata fields (no hashes,
 * no raw metadata, never an OTP), and reads the append-only table without modifying it.
 */
export function createVisitHistory(ctx: Ctx) {
  const { db } = ctx;
  const lookups = createLookups(db);
  const stmt = db.prepare(`SELECT id, seq, actor_id, action, metadata, created_at FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ? ORDER BY seq ASC`);

  return {
    list(visitId: string): VisitHistoryEntry[] {
      const rows = stmt.all(visitId) as Row[];
      const users = lookups.users(rows.map((r) => r.actor_id));
      return rows.map((r) => {
        const m = JSON.parse(r.metadata) as Record<string, unknown>;
        const meta = LABELS[r.action] ?? { label: r.action, kind: 'status' as const };
        const u = r.actor_id ? users.get(r.actor_id) : undefined;
        const entry: VisitHistoryEntry = {
          id: r.id, at: r.created_at, action: r.action, kind: meta.kind, label: meta.label,
          actor: r.actor_id ? { id: r.actor_id, name: u?.name ?? null, role: u?.role ?? null } : null,
        };
        if (typeof m.from === 'string') entry.from = m.from;
        if (typeof m.to === 'string') entry.to = m.to;
        const sched = m.scheduledAt as { from?: unknown; to?: unknown } | undefined;
        if (sched && typeof sched.from === 'string' && typeof sched.to === 'string') entry.scheduledAt = { from: sched.from, to: sched.to };
        if (Array.isArray(m.changedFields)) entry.changedFields = m.changedFields.filter((f): f is string => typeof f === 'string');
        if (typeof m.reason === 'string') entry.reason = m.reason;
        if (typeof m.attempt === 'number') entry.attempt = m.attempt;
        if (typeof m.maxAttempts === 'number') entry.maxAttempts = m.maxAttempts;
        if (typeof m.note === 'string') entry.note = m.note;
        return entry;
      });
    },
  };
}
