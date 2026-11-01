import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../../utils/crypto';
import type { DB } from '../../utils/db';

export const GENESIS_HASH = '0'.repeat(64);
const HASH_VERSION = 1;

export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEvent {
  seq: number;
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
  hash: string;
}

interface HashFields {
  seq: number; id: string; actorId: string | null; action: string; entityType: string;
  entityId: string; metadata: string; createdAt: string; prevHash: string;
}

/** SHA-256 over a canonical encoding of every field except the hash itself. */
export function computeEventHash(f: HashFields): string {
  return sha256(canonicalJson({ v: HASH_VERSION, ...f }));
}

interface Row {
  seq: number; id: string; actor_id: string | null; action: string; entity_type: string;
  entity_id: string; metadata: string; created_at: string; prev_hash: string; hash: string;
}

export function rowToEvent(r: Row): AuditEvent {
  return {
    seq: r.seq, id: r.id, actorId: r.actor_id, action: r.action, entityType: r.entity_type,
    entityId: r.entity_id, metadata: JSON.parse(r.metadata), createdAt: r.created_at,
    prevHash: r.prev_hash, hash: r.hash,
  };
}

/**
 * Appends an event to the chain. Must be called inside the same transaction as the business
 * change it describes so that both commit or neither does. The write lock taken by the
 * surrounding IMMEDIATE transaction (and SQLite's single-writer model) serializes appenders,
 * so two events can never claim the same predecessor.
 */
export function appendAuditEvent(db: DB, input: AuditInput, id: string = randomUUID()): AuditEvent {
  const append = db.transaction(() => {
    const head = db.prepare('SELECT last_seq, last_hash FROM audit_chain_head WHERE id = 1').get() as
      | { last_seq: number; last_hash: string } | undefined;
    const seq = (head?.last_seq ?? 0) + 1;
    const prevHash = head?.last_hash ?? GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const metadata = canonicalJson(input.metadata ?? {});
    const hash = computeEventHash({
      seq, id, actorId: input.actorId, action: input.action, entityType: input.entityType,
      entityId: input.entityId, metadata, createdAt, prevHash,
    });
    db.prepare(
      `INSERT INTO audit_logs (seq, id, actor_id, action, entity_type, entity_id, metadata, created_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seq, id, input.actorId, input.action, input.entityType, input.entityId, metadata, createdAt, prevHash, hash);
    db.prepare(
      `INSERT INTO audit_chain_head (id, last_seq, last_hash) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq, last_hash = excluded.last_hash`,
    ).run(seq, hash);
    return {
      seq, id, actorId: input.actorId, action: input.action, entityType: input.entityType,
      entityId: input.entityId, metadata: JSON.parse(metadata), createdAt, prevHash, hash,
    } as AuditEvent;
  });
  return append.immediate();
}

export type ChainErrorType = 'sequence_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch' | 'invalid_record';

export interface ChainError { type: ChainErrorType; seq: number | null; eventId?: string; message: string }

export interface ChainVerification {
  valid: boolean;
  eventsChecked: number;
  headSeq: number;
  headHash: string;
  errors: ChainError[];
  errorsTruncated: boolean;
  verifiedAt: string;
}

const MAX_ERRORS = 100;

/** Walks the whole chain, recomputing every hash and checking linkage, ordering and the stored head. */
export function verifyChain(db: DB): ChainVerification {
  const errors: ChainError[] = [];
  let truncated = false;
  const push = (e: ChainError) => { if (errors.length < MAX_ERRORS) errors.push(e); else truncated = true; };

  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let lastSeq = 0;
  let lastHash = GENESIS_HASH;

  for (const row of db.prepare('SELECT * FROM audit_logs ORDER BY seq ASC').iterate() as IterableIterator<Row>) {
    checked++;
    if (row.seq !== expectedSeq) {
      push({
        type: 'sequence_gap', seq: row.seq, eventId: row.id,
        message: `Expected seq ${expectedSeq} but found ${row.seq}: ${row.seq > expectedSeq ? 'events were deleted' : 'unexpected event'}`,
      });
    }
    if (row.prev_hash !== prevHash) {
      push({ type: 'prev_hash_mismatch', seq: row.seq, eventId: row.id, message: `prev_hash does not match the preceding event's hash` });
    }
    let recomputed: string | null = null;
    try {
      recomputed = computeEventHash({
        seq: row.seq, id: row.id, actorId: row.actor_id, action: row.action, entityType: row.entity_type,
        entityId: row.entity_id, metadata: canonicalJson(JSON.parse(row.metadata)), createdAt: row.created_at, prevHash: row.prev_hash,
      });
    } catch {
      push({ type: 'invalid_record', seq: row.seq, eventId: row.id, message: 'Event metadata is not valid JSON' });
    }
    if (recomputed !== null && recomputed !== row.hash) {
      push({ type: 'hash_mismatch', seq: row.seq, eventId: row.id, message: 'Stored hash does not match event contents (event was modified)' });
    }
    // Re-synchronise on what is actually stored so one tampered row yields one root-cause error.
    expectedSeq = row.seq + 1;
    prevHash = row.hash;
    lastSeq = row.seq;
    lastHash = row.hash;
  }

  const head = db.prepare('SELECT last_seq, last_hash FROM audit_chain_head WHERE id = 1').get() as
    | { last_seq: number; last_hash: string } | undefined;
  if (!head && checked > 0) {
    push({ type: 'head_mismatch', seq: null, message: 'Chain head record is missing' });
  } else if (head && (head.last_seq !== lastSeq || head.last_hash !== lastHash)) {
    push({
      type: 'head_mismatch', seq: head.last_seq,
      message: `Chain head says seq ${head.last_seq} but the log ends at seq ${lastSeq}: trailing events were deleted or altered`,
    });
  }

  return {
    valid: errors.length === 0,
    eventsChecked: checked,
    headSeq: head?.last_seq ?? lastSeq,
    headHash: head?.last_hash ?? lastHash,
    errors,
    errorsTruncated: truncated,
    verifiedAt: new Date().toISOString(),
  };
}
