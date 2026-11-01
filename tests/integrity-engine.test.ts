import { beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, type AuditEventSummary, type IntegrityScanRequest } from '../src/ml/contracts';
import { BaselineIntegrityEngine, hasBurst } from '../src/modules/integrity/baselineEngine';
import { resolveIntegrityConfig } from '../src/modules/integrity/rules';
import { bearer, makeHarness, makeScenario } from './helpers';

const T0 = Date.parse('2030-01-01T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const event = (action: string, entityType: string, entityId: string, min: number, metadata: Record<string, unknown> = {}, actorId: string | null = 'u1'): AuditEventSummary =>
  ({ id: `ev-${++seq}`, seq, actorId, action, entityType, entityId, createdAt: at(min), metadata });
const scanReq = (over: Partial<IntegrityScanRequest> = {}): IntegrityScanRequest => ({
  contractVersion: CONTRACT_VERSION, requestId: 'r', windowStart: at(-1000), windowEnd: at(500), events: [], reimbursements: [], openVisits: [],
  chain: { valid: true, eventsChecked: 0, errorCount: 0, firstError: null }, ...over,
});
const reimb = (id: string, over = {}) => ({ id, patientId: 'p1', visitId: 'v1', category: 'travel', amountCents: 5000, status: 'pending', requestedBy: 'u1', reviewedBy: null, createdAt: at(0), ...over });

describe('baseline integrity engine (pure)', () => {
  const engine = new BaselineIntegrityEngine();
  const ruleIds = async (req: IntegrityScanRequest, e = engine) => (await e.scan(req)).findings.map((f) => f.ruleId);

  it('finds nothing in a clean scan and returns the structured result shape', async () => {
    const res = await engine.scan(scanReq({ events: [event('patient.created', 'patient', 'p1', 0)] }));
    expect(res).toMatchObject({ findings: [], engine: { name: 'baseline-integrity-rules' }, fallback: { used: false } });
    expect(res.windowStart).toBe(at(-1000));
    expect(new Date(res.scannedAt).toISOString()).toBe(res.scannedAt);
  });

  it('hasBurst finds N events inside a window', () => {
    expect(hasBurst([0, 1, 2, 3, 4], 5, 4)).toBe(true);
    expect(hasBurst([0, 1, 2, 3, 40], 5, 10)).toBe(false);
    expect(hasBurst([0, 10, 20, 21, 22], 3, 2)).toBe(true);
    expect(hasBurst([], 1, 1)).toBe(false);
  });

  it('flags a broken audit chain as critical', async () => {
    const res = await engine.scan(scanReq({ chain: { valid: false, eventsChecked: 9, errorCount: 2, firstError: { type: 'hash_mismatch', seq: 4, message: 'modified' } } }));
    expect(res.findings).toEqual([expect.objectContaining({ ruleId: 'integrity.chain_broken', severity: 'critical', entityType: 'audit_chain' })]);
  });

  it('detects duplicate reimbursement requests but ignores cancelled/rejected ones', async () => {
    const dup = await engine.scan(scanReq({ reimbursements: [reimb('a'), reimb('b'), reimb('c', { amountCents: 1 })] }));
    expect(dup.findings).toHaveLength(1);
    expect(dup.findings[0]).toMatchObject({ ruleId: 'integrity.duplicate_reimbursement', severity: 'high', entityId: 'b' });
    expect(dup.findings[0].details.reimbursementIds).toEqual(['a', 'b']);
    expect(await ruleIds(scanReq({ reimbursements: [reimb('a'), reimb('b', { status: 'cancelled' })] }))).toEqual([]);
  });

  it('detects OTP brute-force bursts only when attempts are close together', async () => {
    const fail = (min: number) => event('otp.verify_failed', 'visit', 'v1', min, { reason: 'incorrect_code' });
    expect(await ruleIds(scanReq({ events: [0, 1, 2, 3, 4].map(fail) }))).toContain('integrity.otp_brute_force');
    expect(await ruleIds(scanReq({ events: [0, 30, 60, 90, 120].map(fail) }))).not.toContain('integrity.otp_brute_force');
    const expired = [0, 1, 2, 3, 4].map((m) => event('otp.verify_failed', 'visit', 'v1', m, { reason: 'expired' }));
    expect(await ruleIds(scanReq({ events: expired }))).toEqual([]);
  });

  it('detects the suspicious sequence "repeated failures then success"', async () => {
    const events = [event('otp.verify_failed', 'visit', 'v1', 0, { reason: 'incorrect_code' }), event('otp.verify_failed', 'visit', 'v1', 1, { reason: 'incorrect_code' }), event('otp.verified', 'visit', 'v1', 2)];
    const res = await engine.scan(scanReq({ events }));
    expect(res.findings).toEqual([expect.objectContaining({ ruleId: 'integrity.verify_after_failures', severity: 'medium', details: expect.objectContaining({ failedBeforeSuccess: 2 }) })]);
    expect(await ruleIds(scanReq({ events: [events[0], events[2]] }))).toEqual([]);
  });

  it('detects self-approval of reimbursements', async () => {
    const e = event('reimbursement.approved', 'reimbursement', 'r1', 0, { requestedBy: 'u1' }, 'u1');
    expect(await ruleIds(scanReq({ events: [e] }))).toEqual(['integrity.self_approval']);
    expect(await ruleIds(scanReq({ events: [{ ...e, actorId: 'u2' }] }))).toEqual([]);
  });

  it('detects unusual churn of changes on one record', async () => {
    const upd = (m: number) => event('patient.updated', 'patient', 'p9', m, { changedFields: ['phone'] });
    const res = await engine.scan(scanReq({ events: [0, 5, 10, 15].map(upd) }));
    expect(res.findings).toEqual([expect.objectContaining({ ruleId: 'integrity.record_churn', entityType: 'patient', entityId: 'p9' })]);
    expect(await ruleIds(scanReq({ events: [0, 100, 200, 300].map(upd) }))).toEqual([]);
  });

  it('detects an amount edit shortly before approval', async () => {
    const events = [event('reimbursement.updated', 'reimbursement', 'r1', 0, { amountCents: { from: 1000, to: 9000 } }), event('reimbursement.approved', 'reimbursement', 'r1', 3, { requestedBy: 'u9' }, 'u2')];
    const res = await engine.scan(scanReq({ events }));
    expect(res.findings.map((f) => f.ruleId)).toEqual(['integrity.amount_changed_before_approval']);
    expect(res.findings[0].severity).toBe('high');
    const slow = [events[0], { ...events[1], createdAt: at(120) }];
    expect(await ruleIds(scanReq({ events: slow }))).toEqual([]);
  });

  it('flags visits left unverified beyond the threshold', async () => {
    const res = await engine.scan(scanReq({ openVisits: [
      { id: 'old', patientId: 'p', status: 'scheduled', scheduledAt: at(-60 * 100), verifiedAt: null },
      { id: 'recent', patientId: 'p', status: 'otp_pending', scheduledAt: at(-60), verifiedAt: null }] }));
    expect(res.findings.map((f) => f.entityId)).toEqual(['old']);
  });

  it('flags role changes and login-failure bursts', async () => {
    const roleEv = event('user.updated', 'user', 'u7', 0, { changes: { role: { from: 'coordinator', to: 'admin' } } });
    expect(await ruleIds(scanReq({ events: [roleEv] }))).toEqual(['integrity.role_change']);
    const fails = Array.from({ length: 10 }, (_, i) => event('auth.login_failed', 'user', 'unknown', i, {}, null));
    expect(await ruleIds(scanReq({ events: fails }))).toEqual(['integrity.login_failure_burst']);
  });

  it('honours configurable thresholds and disabled rules', async () => {
    const strict = new BaselineIntegrityEngine({ recordChurn: { updates: 2 }, duplicateReimbursement: { enabled: false } });
    const upd = (m: number) => event('visit.updated', 'visit', 'v1', m, {});
    expect(await ruleIds(scanReq({ events: [upd(0), upd(1)], reimbursements: [reimb('a'), reimb('b')] }), strict)).toEqual(['integrity.record_churn']);
    expect(() => resolveIntegrityConfig({ nope: { enabled: true } })).toThrow(/Unknown integrity rule/);
    expect(() => resolveIntegrityConfig({ recordChurn: { updates: true } })).toThrow(/Invalid integrity setting/);
    expect(() => resolveIntegrityConfig({ recordChurn: { bogus: 1 } })).toThrow(/Invalid integrity setting/);
  });
});

describe('integrity scanning API (database-backed)', () => {
  let h: ReturnType<typeof makeHarness>;
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeEach(async () => { h = makeHarness(); sc = await makeScenario(h); });
  const scan = (who = sc.admin) => h.api.post('/api/v1/integrity/scans').set(bearer(who)).send({});

  it('raises alerts from real data and de-duplicates repeat scans', async () => {
    const dupe = () => h.s.reimbursements.create({ visitId: sc.visit.id, category: 'meals', amountCents: 2500, currency: 'USD' }, sc.coord.actor);
    dupe(); dupe();
    const first = await scan();
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ engine: { name: 'baseline-integrity-rules' }, newAlerts: 1, existingAlerts: 0 });
    expect(first.body.data.alerts[0]).toMatchObject({ ruleId: 'integrity.duplicate_reimbursement', status: 'open', severity: 'high' });
    const second = await scan(sc.inv);
    expect(second.body.data).toMatchObject({ newAlerts: 0, existingAlerts: 1 });
    expect((await h.api.get('/api/v1/integrity/alerts').set(bearer(sc.admin))).body.meta.total).toBe(1);
  });

  it('raises a CRITICAL alert when the audit chain has been tampered with', async () => {
    h.ctx.db.exec('DROP TRIGGER audit_logs_no_update');
    h.ctx.db.prepare(`UPDATE audit_logs SET metadata = '{"x":1}' WHERE seq = 2`).run();
    const res = await scan();
    const alert = res.body.data.alerts.find((a: { ruleId: string }) => a.ruleId === 'integrity.chain_broken');
    expect(alert).toMatchObject({ severity: 'critical', entityType: 'audit_chain' });
    expect(alert.message).toMatch(/verification failed/);
  });

  it('detects OTP guessing from the audit trail', async () => {
    h.s.otp.issue(sc.visit.id, sc.coord.actor, { code: '482913' });
    for (let i = 0; i < 5; i++) try { h.s.otp.verify(sc.visit.id, '000000', sc.coord.actor); } catch { /* expected */ }
    const res = await scan();
    expect(res.body.data.alerts.map((a: { ruleId: string }) => a.ruleId)).toContain('integrity.otp_brute_force');
  });

  it('manages the alert lifecycle with a state machine, notes and audit events', async () => {
    h.s.reimbursements.create({ visitId: sc.visit.id, category: 'meals', amountCents: 100, currency: 'USD' }, sc.coord.actor);
    h.s.reimbursements.create({ visitId: sc.visit.id, category: 'meals', amountCents: 100, currency: 'USD' }, sc.coord.actor);
    const id = (await scan()).body.data.alerts[0].id;
    const patch = (status: string, note?: string) => h.api.patch(`/api/v1/integrity/alerts/${id}`).set(bearer(sc.inv)).send({ status, note });
    expect((await patch('acknowledged')).body.data.status).toBe('acknowledged');
    const resolved = await patch('resolved', 'Verified with site: legitimate');
    expect(resolved.body.data).toMatchObject({ status: 'resolved', resolvedBy: sc.inv.id, resolutionNote: 'Verified with site: legitimate' });
    expect(resolved.body.data.resolvedAt).toBeTruthy();
    expect((await patch('acknowledged')).status).toBe(409);
    expect((await patch('open')).body.data).toMatchObject({ status: 'open', resolvedBy: null });
    expect((await patch('bogus')).status).toBe(400);
    const open = await h.api.get('/api/v1/integrity/alerts?status=open&severity=high&sort=severity').set(bearer(sc.admin));
    expect(open.body.data).toHaveLength(1);
    const actions = (h.ctx.db.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'integrity.%' ORDER BY seq`).all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['integrity.alert_raised', 'integrity.scan_completed', 'integrity.alert_status_changed', 'integrity.alert_status_changed', 'integrity.alert_status_changed']);
  });

  it('validates the scan window and exposes rule configuration', async () => {
    expect((await h.api.post('/api/v1/integrity/scans').set(bearer(sc.admin)).send({ windowHours: 0 })).status).toBe(400);
    expect((await h.api.post('/api/v1/integrity/scans').set(bearer(sc.admin)).send({ windowHours: 100000 })).status).toBe(400);
    const rules = await h.api.get('/api/v1/integrity/rules').set(bearer(sc.admin));
    expect(rules.body.data.baselineConfig.otpBruteForce).toMatchObject({ enabled: true, failures: 5 });
  });
});
