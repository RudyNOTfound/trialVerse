import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashOtp } from '../src/utils/crypto';
import { loadConfig } from '../src/config/env';
import { EMAIL_ENV, FakeEmailProvider, TEST_ENV, bearer, makeHarness, makeScenario } from './helpers';

describe('visit creation', () => {
  const h = makeHarness();
  it('creates a visit for an enrollment, deriving patient, trial and site', async () => {
    const sc = await makeScenario(h);
    const res = await h.api.post('/api/v1/visits').set(bearer(sc.coord))
      .send({ enrollmentId: sc.enrollment.id, visitType: 'Week 4', scheduledAt: '2030-05-01T09:00:00Z', notes: 'fasting' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      patientId: sc.patient.id, trialId: sc.trial.id, trialSiteId: sc.site.id, status: 'scheduled',
      scheduledAt: '2030-05-01T09:00:00.000Z', otpIssuedAt: null, verifiedAt: null,
    });
  });
  it('rejects bad input, unknown enrollments and closed enrollments', async () => {
    const sc = await makeScenario(h);
    const post = (b: object) => h.api.post('/api/v1/visits').set(bearer(sc.coord)).send(b);
    expect((await post({ enrollmentId: sc.enrollment.id, visitType: 'x', scheduledAt: 'tomorrow' })).status).toBe(400);
    expect((await post({ enrollmentId: 'nope', visitType: 'x', scheduledAt: '2030-01-01T00:00:00Z' })).status).toBe(400);
    expect((await post({ enrollmentId: '00000000-0000-4000-8000-000000000000', visitType: 'x', scheduledAt: '2030-01-01T00:00:00Z' })).status).toBe(404);
    h.s.trials.updateEnrollmentStatus(sc.enrollment.id, 'withdrawn', sc.inv.actor);
    expect((await post({ enrollmentId: sc.enrollment.id, visitType: 'x', scheduledAt: '2030-01-01T00:00:00Z' })).status).toBe(409);
  });
  it('lists and filters visits, and edits only open visits', async () => {
    const sc = await makeScenario(h);
    const v2 = sc.newVisit('Later', '2031-01-01T00:00:00Z');
    const list = await h.api.get(`/api/v1/visits?patientId=${sc.patient.id}&status=scheduled&sort=scheduledAt&order=asc&from=2030-12-01T00:00:00Z`).set(bearer(sc.admin));
    expect(list.body.data.map((v: { id: string }) => v.id)).toEqual([v2.id]);
    const upd = await h.api.patch(`/api/v1/visits/${v2.id}`).set(bearer(sc.coord)).send({ notes: 'rescheduled', scheduledAt: '2031-02-02T00:00:00Z' });
    expect(upd.body.data).toMatchObject({ notes: 'rescheduled', scheduledAt: '2031-02-02T00:00:00.000Z' });
    await h.api.post(`/api/v1/visits/${v2.id}/status`).set(bearer(sc.coord)).send({ status: 'cancelled' });
    expect((await h.api.patch(`/api/v1/visits/${v2.id}`).set(bearer(sc.coord)).send({ notes: 'too late' })).status).toBe(409);
  });
});

describe('OTP generation and verification', () => {
  let h: ReturnType<typeof makeHarness>;
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeEach(async () => { h = makeHarness(); sc = await makeScenario(h); });

  const issue = async () => (await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord))).body.data as { demoOtp: string; otpId: string; expiresAt: string };
  const verify = (code: string, who = sc.patientUser) => h.api.post(`/api/v1/visits/${sc.visit.id}/otp/verify`).set(bearer(who)).send({ code });
  const wrong = (otp: string) => (otp === '000000' ? '111111' : '000000');
  const audit = () => (h.ctx.db.prepare(`SELECT action, metadata FROM audit_logs WHERE entity_id = ? ORDER BY seq`).all(sc.visit.id) as { action: string; metadata: string }[]);

  it('issues a numeric OTP of the configured length and moves the visit to otp_pending', async () => {
    const res = await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect(res.status).toBe(201);
    expect(res.body.data.demoOtp).toMatch(/^\d{6}$/);
    expect(res.body.data.maxAttempts).toBe(5);
    const visit = h.s.visits.get(sc.visit.id);
    expect(visit.status).toBe('otp_pending');
    expect(visit.otpIssuedAt).toBeTruthy();
  });

  it('stores only a keyed hash: the plaintext OTP appears nowhere in the database', async () => {
    const otp = await issue();
    const row = h.ctx.db.prepare('SELECT * FROM otp_records WHERE id = ?').get(otp.otpId) as { code_hash: string };
    expect(row.code_hash).toBe(hashOtp(otp.demoOtp, otp.otpId, h.ctx.config.otp.pepper));
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const table of ['otp_records', 'audit_logs', 'visits']) {
      const dump = JSON.stringify(h.ctx.db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump, table).not.toContain(`"${otp.demoOtp}"`);
      expect(dump, table).not.toMatch(new RegExp(`code":"${otp.demoOtp}`));
    }
  });

  it('does not return the OTP when demo mode is off, and never exposes a hash', async () => {
    // Production-like: demo mode off, OTPs delivered by email (fake provider). Without a delivery channel issuing now fails closed.
    const off = makeHarness({ env: EMAIL_ENV, emailProvider: new FakeEmailProvider() });
    const s2 = await makeScenario(off);
    const res = await off.api.post(`/api/v1/visits/${s2.visit.id}/otp`).set(bearer(s2.coord));
    expect(res.status).toBe(201);
    expect(res.body.data.demoOtp).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/hash/i);
    const status = await off.api.get(`/api/v1/visits/${s2.visit.id}/otp`).set(bearer(s2.coord));
    expect(JSON.stringify(status.body)).not.toMatch(/hash|code/i);
  });

  it('refuses to start with demo OTP enabled in production', () => {
    expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: 'production', DEMO_OTP_ENABLED: 'true' })).toThrow(/DEMO_OTP_ENABLED/);
    expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: 'production', DEMO_OTP_ENABLED: 'false', CORS_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() => loadConfig({ ...TEST_ENV, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...TEST_ENV, OTP_PEPPER: TEST_ENV.JWT_SECRET })).toThrow(/differ/);
  });

  it('exposes the demo OTP through the dev endpoint only to staff, only in dev', async () => {
    const otp = await issue();
    const dev = await h.api.get(`/api/v1/dev/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect(dev.status).toBe(200);
    expect(dev.body.data.code).toBe(otp.demoOtp);
    expect((await h.api.get(`/api/v1/dev/visits/${sc.visit.id}/otp`).set(bearer(sc.patientUser))).status).toBe(403);
  });

  it('verifies a correct OTP, marks the visit verified and records timestamps + who', async () => {
    const otp = await issue();
    const res = await verify(otp.demoOtp);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'verified', verifiedBy: sc.patientUser.id });
    expect(res.body.data.verifiedAt).toBeTruthy();
    const rec = h.ctx.db.prepare('SELECT status, used_at FROM otp_records WHERE id = ?').get(otp.otpId) as { status: string; used_at: string };
    expect(rec.status).toBe('used');
    expect(rec.used_at).toBeTruthy();
  });

  it('prevents OTP reuse after a successful verification', async () => {
    const otp = await issue();
    expect((await verify(otp.demoOtp)).status).toBe(200);
    const again = await verify(otp.demoOtp);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OTP_NOT_ACTIVE');
    expect(again.body.error.message).toMatch(/already been used/);
  });

  it('rejects a wrong code, reports remaining attempts and increments the counter', async () => {
    const otp = await issue();
    const res = await verify(wrong(otp.demoOtp));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'OTP_INVALID', details: { remainingAttempts: 4 } });
    const rec = h.ctx.db.prepare('SELECT attempts FROM otp_records WHERE id = ?').get(otp.otpId) as { attempts: number };
    expect(rec.attempts).toBe(1);
    expect(h.s.visits.get(sc.visit.id).status).toBe('otp_pending');
  });

  it('locks the OTP after max attempts, and even the correct code is then refused', async () => {
    const otp = await issue();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await verify(wrong(otp.demoOtp))).status);
    expect(codes).toEqual([400, 400, 400, 400, 423]);
    const afterLock = await verify(otp.demoOtp);
    expect(afterLock.status).toBe(423);
    expect(afterLock.body.error.code).toBe('OTP_LOCKED');
    expect(h.s.visits.get(sc.visit.id).status).toBe('otp_pending');
    // A fresh OTP unlocks the flow.
    const fresh = await issue();
    expect((await verify(fresh.demoOtp)).status).toBe(200);
  });

  it('expires OTPs after the TTL (clock-controlled)', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const otp = await issue();
    expect(otp.expiresAt).toBe(new Date(t0 + 300_000).toISOString());
    vi.setSystemTime(t0 + 301_000);
    const res = await verify(otp.demoOtp);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
    expect((h.ctx.db.prepare('SELECT status FROM otp_records WHERE id = ?').get(otp.otpId) as { status: string }).status).toBe('expired');
    expect((await verify(otp.demoOtp)).body.error.code).toBe('OTP_EXPIRED');
    expect(h.s.visits.get(sc.visit.id).status).toBe('otp_pending');
  });

  it('accepts a correct OTP right up to the expiry boundary', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const otp = await issue();
    vi.setSystemTime(t0 + 299_000);
    expect((await verify(otp.demoOtp)).status).toBe(200);
  });

  it('supersedes the previous OTP when a new one is issued', async () => {
    const first = await issue();
    const second = await issue();
    expect(second.otpId).not.toBe(first.otpId);
    const wrongOne = await verify(first.demoOtp === second.demoOtp ? wrong(second.demoOtp) : first.demoOtp);
    expect(wrongOne.status).toBe(400);
    expect((await verify(second.demoOtp)).status).toBe(200);
    const statuses = (h.ctx.db.prepare('SELECT status FROM otp_records ORDER BY created_at, rowid').all() as { status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(['superseded', 'used']);
  });

  it('rate-limits OTP issuance per visit', async () => {
    for (let i = 0; i < 5; i++) expect((await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord))).status).toBe(201);
    const sixth = await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
  });

  it('returns 409 when verifying a visit with no OTP, and refuses OTPs for closed visits', async () => {
    expect((await verify('123456')).body.error.code).toBe('OTP_NOT_ACTIVE');
    await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.coord)).send({ status: 'cancelled' });
    expect((await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord))).status).toBe(409);
  });

  it('rejects malformed codes with a validation error (not an attempt)', async () => {
    const otp = await issue();
    expect((await verify('12ab56')).status).toBe(400);
    expect((await verify('1')).body.error.code).toBe('VALIDATION_ERROR');
    expect((h.ctx.db.prepare('SELECT attempts FROM otp_records WHERE id = ?').get(otp.otpId) as { attempts: number }).attempts).toBe(0);
  });

  it('only allows the visit\'s own patient (or staff) to verify', async () => {
    const otp = await issue();
    const stranger = await (await import('./helpers')).makeUser(h, 'patient');
    h.s.patients.create({ firstName: 'S', lastName: 'T', dateOfBirth: '1990-01-01', sex: 'male', userId: stranger.id }, sc.coord.actor);
    expect((await verify(otp.demoOtp, stranger)).status).toBe(403);
    expect((await verify(otp.demoOtp, sc.coord)).status).toBe(200);
  });

  it('only completes a visit after verification', async () => {
    const early = await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect((await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' })).status).toBe(409);
    const code = (await h.api.get(`/api/v1/dev/visits/${sc.visit.id}/otp`).set(bearer(sc.coord))).body.data.code;
    await verify(code);
    const done = await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });
    expect(done.body.data.status).toBe('completed');
    expect(done.body.data.completedAt).toBeTruthy();
  });

  it('records every OTP event in the audit trail without leaking the code', async () => {
    const a = await issue();
    await verify(wrong(a.demoOtp));
    await verify(a.demoOtp);
    await verify(a.demoOtp); // reuse
    const events = audit();
    expect(events.map((e) => e.action)).toEqual(
      ['visit.created', 'otp.issued', 'otp.verify_failed', 'otp.verified', 'visit.verified', 'otp.verify_failed']);
    const reasons = events.filter((e) => e.action === 'otp.verify_failed').map((e) => JSON.parse(e.metadata).reason);
    expect(reasons).toEqual(['incorrect_code', 'used']);
    expect(JSON.stringify(events)).not.toContain(a.demoOtp);
    expect(h.s.audit.verify(sc.admin.actor).valid).toBe(true);
  });

  it('audits lockouts and expiry failures too', async () => {
    const a = await issue();
    for (let i = 0; i < 5; i++) await verify(wrong(a.demoOtp));
    expect(audit().map((e) => e.action).filter((x) => x.startsWith('otp.')).slice(-2)).toEqual(['otp.verify_failed', 'otp.locked']);
  });
});
