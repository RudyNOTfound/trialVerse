import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { GENESIS_HASH, appendAuditEvent, computeEventHash, verifyChain } from '../src/modules/audit/chain';
import { canonicalJson } from '../src/utils/crypto';
import { bearer, makeHarness, makeScenario } from './helpers';

const freshDb = () => { const db = openDatabase(':memory:'); runMigrations(db); return db; };
const ev = (n: number) => ({ actorId: null, action: `test.event${n}`, entityType: 'thing', entityId: String(n), metadata: { n } });
/** Simulates an attacker with direct DB access who first removes the append-only triggers. */
const dropTriggers = (db: ReturnType<typeof freshDb>) => db.exec('DROP TRIGGER audit_logs_no_update; DROP TRIGGER audit_logs_no_delete;');

describe('audit hash generation', () => {
  it('canonicalises JSON deterministically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('computes a stable SHA-256 that changes when any field changes', () => {
    const base = { seq: 1, id: 'id', actorId: 'a', action: 'x', entityType: 't', entityId: 'e', metadata: '{}', createdAt: '2030-01-01T00:00:00.000Z', prevHash: GENESIS_HASH };
    const h0 = computeEventHash(base);
    expect(h0).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventHash({ ...base })).toBe(h0);
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      const changed = { ...base, [k]: k === 'seq' ? 2 : base[k] === null ? 'z' : `${base[k]}x` };
      expect(computeEventHash(changed), k).not.toBe(h0);
    }
  });

  it('links each event to its predecessor starting from the genesis hash', () => {
    const db = freshDb();
    const e1 = appendAuditEvent(db, ev(1));
    const e2 = appendAuditEvent(db, ev(2));
    const e3 = appendAuditEvent(db, ev(3));
    expect(e1).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(new Set([e1.hash, e2.hash, e3.hash]).size).toBe(3);
    const head = db.prepare('SELECT * FROM audit_chain_head').get() as { last_seq: number; last_hash: string };
    expect(head).toEqual({ id: 1, last_seq: 3, last_hash: e3.hash } as never);
  });

  it('stores the fields required of each event', () => {
    const db = freshDb();
    const e = appendAuditEvent(db, { actorId: 'actor-1', action: 'thing.did', entityType: 'thing', entityId: 'T1', metadata: { k: 'v' } });
    expect(e).toMatchObject({ actorId: 'actor-1', action: 'thing.did', entityType: 'thing', entityId: 'T1', metadata: { k: 'v' } });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(e.createdAt).toISOString()).toBe(e.createdAt);
  });
});

describe('audit chain verification', () => {
  it('reports an empty chain and an intact chain as valid', () => {
    const db = freshDb();
    expect(verifyChain(db)).toMatchObject({ valid: true, eventsChecked: 0, errors: [] });
    for (let i = 1; i <= 25; i++) appendAuditEvent(db, ev(i));
    expect(verifyChain(db)).toMatchObject({ valid: true, eventsChecked: 25, headSeq: 25 });
  });

  it('detects a modified event (content tampering)', () => {
    const db = freshDb();
    for (let i = 1; i <= 10; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    db.prepare(`UPDATE audit_logs SET metadata = '{"n":999}' WHERE seq = 5`).run();
    const r = verifyChain(db);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ type: 'hash_mismatch', seq: 5 })]);
  });

  it('detects tampering with the actor, action, entity or timestamp', () => {
    for (const [col, val] of [['actor_id', 'evil'], ['action', 'x.y'], ['entity_id', '99'], ['created_at', '2000-01-01T00:00:00.000Z']]) {
      const db = freshDb();
      for (let i = 1; i <= 4; i++) appendAuditEvent(db, ev(i));
      dropTriggers(db);
      db.prepare(`UPDATE audit_logs SET ${col} = ? WHERE seq = 2`).run(val);
      expect(verifyChain(db).errors.map((e) => e.type), col).toContain('hash_mismatch');
    }
  });

  it('detects a modified event even if the attacker recomputes that event\'s own hash', () => {
    const db = freshDb();
    for (let i = 1; i <= 6; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    const row = db.prepare('SELECT * FROM audit_logs WHERE seq = 3').get() as Record<string, string | number | null>;
    const newMeta = '{"n":42}';
    const newHash = computeEventHash({
      seq: 3, id: row.id as string, actorId: row.actor_id as string | null, action: row.action as string, entityType: row.entity_type as string,
      entityId: row.entity_id as string, metadata: newMeta, createdAt: row.created_at as string, prevHash: row.prev_hash as string,
    });
    db.prepare('UPDATE audit_logs SET metadata = ?, hash = ? WHERE seq = 3').run(newMeta, newHash);
    const r = verifyChain(db);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ type: 'prev_hash_mismatch', seq: 4 })]); // successor no longer links
  });

  it('detects a deleted event in the middle (sequence gap + broken link)', () => {
    const db = freshDb();
    for (let i = 1; i <= 8; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    db.prepare('DELETE FROM audit_logs WHERE seq = 4').run();
    const types = verifyChain(db).errors.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['sequence_gap', 'prev_hash_mismatch']));
  });

  it('detects deletion of the first event', () => {
    const db = freshDb();
    for (let i = 1; i <= 4; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    db.prepare('DELETE FROM audit_logs WHERE seq = 1').run();
    expect(verifyChain(db).valid).toBe(false);
  });

  it('detects truncation of the tail via the chain head record', () => {
    const db = freshDb();
    for (let i = 1; i <= 8; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    db.prepare('DELETE FROM audit_logs WHERE seq > 5').run();
    const r = verifyChain(db);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ type: 'head_mismatch' })]);
  });

  it('detects a wholesale wipe of the log', () => {
    const db = freshDb();
    for (let i = 1; i <= 3; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    db.prepare('DELETE FROM audit_logs').run();
    expect(verifyChain(db).valid).toBe(false);
  });

  it('detects an inserted forged event', () => {
    const db = freshDb();
    for (let i = 1; i <= 4; i++) appendAuditEvent(db, ev(i));
    dropTriggers(db);
    const prev = db.prepare('SELECT hash FROM audit_logs WHERE seq = 4').get() as { hash: string };
    db.prepare(`INSERT INTO audit_logs (seq,id,actor_id,action,entity_type,entity_id,metadata,created_at,prev_hash,hash) VALUES (5,'forged',NULL,'x','t','1','{}','2030-01-01T00:00:00.000Z',?,?)`)
      .run(prev.hash, 'f'.repeat(64));
    const r = verifyChain(db);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.type)).toEqual(expect.arrayContaining(['hash_mismatch', 'head_mismatch']));
  });

  it('is append-only at the application layer (triggers reject UPDATE and DELETE)', () => {
    const db = freshDb();
    appendAuditEvent(db, ev(1));
    expect(() => db.prepare(`UPDATE audit_logs SET action = 'x'`).run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_logs').run()).toThrow(/append-only/);
    expect(verifyChain(db).valid).toBe(true);
  });
});

describe('audit chain concurrency', () => {
  it('keeps the chain consistent under many concurrent API requests', async () => {
    const h = makeHarness();
    const sc = await makeScenario(h);
    const requests = Array.from({ length: 60 }, (_, i) =>
      h.api.post('/api/v1/patients').set(bearer(sc.coord)).send({ firstName: `P${i}`, lastName: 'Parallel', dateOfBirth: '1990-01-01', sex: 'other' }));
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = (h.ctx.db.prepare('SELECT seq FROM audit_logs ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // contiguous, no duplicates
    expect(verifyChain(h.ctx.db).valid).toBe(true);
  });

  it('keeps the chain consistent when separate connections interleave appends on the same file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-')), 'chain.db');
    const a = openDatabase(file); runMigrations(a);
    const b = openDatabase(file);
    for (let i = 0; i < 100; i++) { appendAuditEvent(a, ev(i * 2)); appendAuditEvent(b, ev(i * 2 + 1)); }
    expect(verifyChain(a)).toMatchObject({ valid: true, eventsChecked: 200 });
    a.close(); b.close();
  });

  it('rolls an audit event back together with a failed business transaction', () => {
    const db = freshDb();
    appendAuditEvent(db, ev(1));
    expect(() => db.transaction(() => { appendAuditEvent(db, ev(2)); throw new Error('business failure'); })()).toThrow('business failure');
    expect((db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(1);
    appendAuditEvent(db, ev(3));
    expect(verifyChain(db)).toMatchObject({ valid: true, eventsChecked: 2 });
  });
});

describe('audit API', () => {
  const h = makeHarness();

  it('lists and filters events, and fetches one by id', async () => {
    const sc = await makeScenario(h);
    const all = await h.api.get('/api/v1/audit?pageSize=5').set(bearer(sc.admin));
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBeGreaterThan(5);
    const filtered = await h.api.get(`/api/v1/audit?entityType=patient&entityId=${sc.patient.id}&action=patient.created`).set(bearer(sc.inv));
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0]).toMatchObject({ actorId: sc.coord.id, entityType: 'patient', entityId: sc.patient.id });
    const one = await h.api.get(`/api/v1/audit/${filtered.body.data[0].id}`).set(bearer(sc.admin));
    expect(one.body.data.hash).toBe(filtered.body.data[0].hash);
    expect((await h.api.get('/api/v1/audit/00000000-0000-4000-8000-000000000000').set(bearer(sc.admin))).status).toBe(404);
    const byActor = await h.api.get(`/api/v1/audit?actorId=${sc.coord.id}&order=asc`).set(bearer(sc.admin));
    expect(byActor.body.data.every((e: { actorId: string }) => e.actorId === sc.coord.id)).toBe(true);
  });

  it('verifies the chain over HTTP and records successful verifications', async () => {
    const sc = await makeScenario(h);
    const res = await h.api.get('/api/v1/audit/verify').set(bearer(sc.admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ valid: true, errors: [] });
    expect(res.body.data.eventsChecked).toBeGreaterThan(10);
    const last = h.ctx.db.prepare('SELECT action, actor_id FROM audit_logs ORDER BY seq DESC LIMIT 1').get() as { action: string; actor_id: string };
    expect(last).toEqual({ action: 'audit.chain_verified', actor_id: sc.admin.id });
  });

  it('reports tampering over HTTP and records the FAILED verification in the chain', async () => {
    const t = makeHarness();
    const sc = await makeScenario(t);
    dropTriggers(t.ctx.db as never);
    t.ctx.db.prepare(`UPDATE audit_logs SET metadata = '{"hacked":true}' WHERE seq = 3`).run();
    const res = await t.api.get('/api/v1/audit/verify').set(bearer(sc.admin));
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.errors[0]).toMatchObject({ type: 'hash_mismatch', seq: 3 });
    const last = t.ctx.db.prepare('SELECT action, actor_id, metadata FROM audit_logs ORDER BY seq DESC LIMIT 1').get() as { action: string; actor_id: string; metadata: string };
    expect(last.action).toBe('audit.chain_verification_failed');
    expect(last.actor_id).toBe(sc.admin.id);
    expect(JSON.parse(last.metadata)).toMatchObject({ valid: false, errorCount: 1 });
    // Failure persists on re-verification (the tampering is still there).
    expect((await t.api.get('/api/v1/audit/verify').set(bearer(sc.admin))).body.data.valid).toBe(false);
  });
});
