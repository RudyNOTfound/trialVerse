import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { maskEmail } from '../src/modules/visits/otp';
import { EMAIL_ENV, FakeEmailProvider, PASSWORD, TEST_ENV, bearer, makeHarness, makeScenario, makeUser } from './helpers';

const api = '/api/v1';
const COOLDOWN = { OTP_RESEND_COOLDOWN_SECONDS: '60' };

/** A production-like harness: email delivery on, demo off, fake provider, real 60s cooldown. */
function setup(extraEnv: Record<string, string> = {}, opts: { logger?: pino.Logger } = {}) {
  const provider = new FakeEmailProvider();
  const h = makeHarness({ env: { ...EMAIL_ENV, ...COOLDOWN, ...extraEnv }, emailProvider: provider, logger: opts.logger });
  return { h, provider };
}
const issue = (h: ReturnType<typeof setup>['h'], visitId: string, user: { token: string }) => h.api.post(`${api}/visits/${visitId}/otp`).set(bearer(user));
const age = (h: ReturnType<typeof setup>['h'], visitId: string, seconds: number) =>
  h.ctx.db.prepare('UPDATE otp_records SET created_at = ? WHERE visit_id = ?').run(new Date(Date.now() - seconds * 1000).toISOString(), visitId);

describe('OTP email: configuration', () => {
  const base: Record<string, string> = { ...TEST_ENV, DEMO_OTP_ENABLED: 'false' };
  it('is safe by default: email off, no credentials needed, demo off, 60s cooldown', () => {
    const { OTP_RESEND_COOLDOWN_SECONDS: _ignored, ...withoutOverride } = base; // the shared test env zeroes the cooldown for older suites
    const c = loadConfig({ ...withoutOverride });
    expect(c.email.enabled).toBe(false);
    expect(c.otp.demoEnabled).toBe(false);
    expect(c.otp.resendCooldownSeconds).toBe(60);
  });
  it('rejects email enabled without credentials, with a clear message', () => {
    expect(() => loadConfig({ ...base, OTP_EMAIL_ENABLED: 'true' })).toThrow(/OTP_EMAIL_ENABLED=true requires RESEND_API_KEY and OTP_FROM_EMAIL/);
    expect(() => loadConfig({ ...base, OTP_EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_x' })).toThrow(/requires OTP_FROM_EMAIL/);
    expect(() => loadConfig({ ...base, OTP_EMAIL_ENABLED: 'true', OTP_FROM_EMAIL: 'a@b.co' })).toThrow(/requires RESEND_API_KEY/);
    expect(() => loadConfig({ ...base, OTP_EMAIL_ENABLED: 'true', RESEND_API_KEY: '   ', OTP_FROM_EMAIL: 'a@b.co' })).toThrow(/RESEND_API_KEY/);
  });
  it('validates the sender address and accepts "Name <address>"', () => {
    expect(() => loadConfig({ ...base, ...EMAIL_ENV, OTP_FROM_EMAIL: 'not-an-email' })).toThrow(/OTP_FROM_EMAIL must be an email/);
    expect(loadConfig({ ...base, ...EMAIL_ENV, OTP_FROM_EMAIL: 'TrialVerse <noreply@example.org>' }).email.from).toBe('TrialVerse <noreply@example.org>');
    expect(loadConfig({ ...base, ...EMAIL_ENV, OTP_FROM_EMAIL: 'noreply@example.org' }).email.enabled).toBe(true);
  });
  it('refuses to combine demo OTP exposure with real email delivery', () => {
    expect(() => loadConfig({ ...base, ...EMAIL_ENV, DEMO_OTP_ENABLED: 'true' })).toThrow(/cannot be combined/);
  });
  it('allows email delivery in production and still forbids demo mode there', () => {
    expect(loadConfig({ ...base, ...EMAIL_ENV, NODE_ENV: 'production' }).email.enabled).toBe(true);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEMO_OTP_ENABLED: 'true' })).toThrow(/DEMO_OTP_ENABLED/);
  });
  it('masks addresses', () => {
    expect(maskEmail('amelia.hartwell@example.org')).toBe('a***@example.org');
    expect(maskEmail('x@y.io')).toBe('x***@y.io');
    expect(maskEmail('weird')).toBe('***');
  });
});

describe('OTP email: delivery', () => {
  it('emails the code to the linked portal account, and never returns it', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    const before = Date.now();
    const res = await issue(h, sc.visit.id, sc.coord);
    expect(res.status).toBe(201);
    const text = JSON.stringify(res.body);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe(sc.patientUser.email);
    expect(provider.sent[0]!.subject).toBe('Your TrialVerse verification code');
    const code = provider.lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(text).not.toContain(code);
    expect(res.body.data.demoOtp).toBeUndefined();
    expect(res.body.data.delivery).toMatchObject({ channel: 'email', status: 'sent', recipientHint: maskEmail(sc.patientUser.email), cooldownSeconds: 60 });
    expect(text).not.toContain(sc.patientUser.email); // only the masked form
    // 5-minute expiry
    const ttl = new Date(res.body.data.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(299_000);
    expect(ttl).toBeLessThan(302_000);
    // email content: HTML + text both carry the code, with expiry wording
    expect(provider.sent[0]!.html).toContain(code);
    expect(provider.sent[0]!.text).toMatch(/expires in 5 minutes/);
  });

  it('lets the participant verify the emailed code through the existing flow', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const ok = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: provider.lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('verified');
    const done = await h.api.post(`${api}/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });
    expect(done.body.data.status).toBe('completed');
  });

  it('stores only a keyed hash and never writes the code to the database, audit trail or logs', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (s: string) => { lines.push(s); } } as any);
    const { h, provider } = setup({ RATE_LIMIT_ENABLED: 'true' }, { logger });
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const code = provider.lastCode();
    await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: code === '000000' ? '111111' : '000000' });
    await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code });
    const row = h.ctx.db.prepare('SELECT * FROM otp_records WHERE visit_id = ?').get(sc.visit.id) as Record<string, unknown>;
    expect(row.code_hash).not.toBe(code);
    expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/);
    for (const table of ['otp_records', 'audit_logs', 'visits', 'status_history']) {
      expect(JSON.stringify(h.ctx.db.prepare(`SELECT * FROM ${table}`).all()).includes(`"${code}"`), table).toBe(false);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(code);
    expect(lines.join('\n')).not.toContain(sc.patientUser.email);
  });

  it('audits issuance with channel and provider message id, but no code, hash or address', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const events = (await h.api.get(`${api}/audit?action=otp.issued&entityId=${sc.visit.id}`).set(bearer(sc.admin))).body.data;
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ channel: 'email', messageId: 'msg_1', provider: 'fake', patientId: sc.patient.id });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(provider.lastCode());
    expect(dump).not.toMatch(/code_?hash|"hash":"[0-9a-f]{64}"\s*,\s*"hash"/); // the chain's own event hash is fine; the OTP hash is not recorded
    expect(dump).not.toContain(sc.patientUser.email);
    expect((await h.api.get(`${api}/audit/verify`).set(bearer(sc.admin))).body.data.valid).toBe(true);
  });
});

describe('OTP email: failures leave no half-issued OTP', () => {
  it('provider failure -> 502 with a generic message; nothing committed; previous code keeps working; no cooldown', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const firstCode = provider.lastCode();
    age(h, sc.visit.id, 120);
    provider.fail('provider_unavailable', 'SECRET upstream detail re_live_abc');

    const res = await issue(h, sc.visit.id, sc.coord);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/SECRET|re_live|provider_unavailable|resend|fake/i);

    const rows = h.ctx.db.prepare('SELECT status FROM otp_records WHERE visit_id = ?').all(sc.visit.id) as Array<{ status: string }>;
    expect(rows).toEqual([{ status: 'active' }]); // no new row, previous one untouched
    const ok = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: firstCode });
    expect(ok.status).toBe(200); // the previous OTP was not superseded by the failed attempt
  });

  it('failure on a first issue leaves the visit scheduled with no OTP, and a retry works immediately', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    provider.fail('timeout');
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(502);
    expect((h.ctx.db.prepare('SELECT status, otp_issued_at FROM visits WHERE id = ?').get(sc.visit.id) as any)).toEqual({ status: 'scheduled', otp_issued_at: null });
    expect((h.ctx.db.prepare('SELECT COUNT(*) c FROM otp_records WHERE visit_id = ?').get(sc.visit.id) as any).c).toBe(0);
    provider.recover();
    const retry = await issue(h, sc.visit.id, sc.coord); // a failed send must not start the 60s cooldown
    expect(retry.status).toBe(201);
    expect(provider.sent).toHaveLength(1);
  });

  it('records otp.delivery_failed in the audit trail without code, address or provider detail', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    provider.fail('provider_auth', 'API key re_live_leak rejected for someone@private.org');
    await issue(h, sc.visit.id, sc.coord);
    const ev = (await h.api.get(`${api}/audit?action=otp.delivery_failed`).set(bearer(sc.admin))).body.data;
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toEqual({ patientId: sc.patient.id, channel: 'email', provider: 'fake', reason: 'provider_auth' });
    expect(JSON.stringify(ev)).not.toMatch(/re_live|private\.org/);
  });

  it('refuses when the participant has no linked portal account (no email, no OTP row)', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    const p = h.s.patients.create({ firstName: 'No', lastName: 'Account', dateOfBirth: '1991-01-01', sex: 'male' }, sc.coord.actor);
    const e = h.s.trials.createEnrollment({ patientId: p.id, trialId: sc.trial.id, trialSiteId: sc.site.id }, sc.coord.actor);
    const v = h.s.visits.create({ enrollmentId: e.id, visitType: 'Orphan', scheduledAt: new Date().toISOString() }, sc.coord.actor);
    const res = await issue(h, v.id, sc.coord);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OTP_NO_RECIPIENT');
    expect(res.body.error.message).toMatch(/no linked portal account/);
    expect(provider.sent).toHaveLength(0);
    expect((h.ctx.db.prepare('SELECT COUNT(*) c FROM otp_records WHERE visit_id = ?').get(v.id) as any).c).toBe(0);
  });

  it('refuses when the linked portal account is deactivated', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    h.s.users.update(sc.patientUser.id, { isActive: false }, sc.admin.actor);
    const res = await issue(h, sc.visit.id, sc.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OTP_NO_RECIPIENT');
    expect(res.body.error.message).toMatch(/deactivated/);
    expect(provider.sent).toHaveLength(0);
  });

  it('fails closed when no delivery channel is configured (email off, demo off): 503, never exposes a code', async () => {
    const h = makeHarness({ env: { DEMO_OTP_ENABLED: 'false' } });
    const sc = await makeScenario(h);
    const res = await h.api.post(`${api}/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OTP_DELIVERY_UNAVAILABLE');
    expect(res.body.data).toBeUndefined();
    expect(res.body.error.message).not.toMatch(/\d{4,}/); // (the request id is random, so check the message, not the whole body)
    expect((h.ctx.db.prepare('SELECT COUNT(*) c FROM otp_records').get() as any).c).toBe(0);
  });

  it('building the email service without credentials fails loudly', async () => {
    const { createEmailService } = await import('../src/email/service');
    const cfg = loadConfig({ ...TEST_ENV, DEMO_OTP_ENABLED: 'false' });
    expect(() => createEmailService({ ...cfg, email: { enabled: true, timeoutMs: 1000 } }, pino({ level: 'silent' }))).toThrow(/RESEND_API_KEY/);
  });
});

describe('OTP email: cooldown, resend and invalidation', () => {
  it('blocks a resend inside 60s with 429 + Retry-After and sends no second email', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const again = await issue(h, sc.visit.id, sc.coord);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('OTP_COOLDOWN');
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(again.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(again.headers['retry-after']).toBe(String(again.body.error.details.retryAfterSeconds));
    expect(provider.sent).toHaveLength(1);
  });

  it('exposes when a resend is available, and honours it', async () => {
    const { h } = setup();
    const sc = await makeScenario(h);
    const first = await issue(h, sc.visit.id, sc.coord);
    const at = new Date(first.body.data.delivery.resendAvailableAt).getTime();
    expect(at - Date.now()).toBeGreaterThan(55_000);
    const st = (await h.api.get(`${api}/visits/${sc.visit.id}/otp`).set(bearer(sc.coord))).body.data;
    expect(st.delivery).toMatchObject({ channel: 'email', cooldownSeconds: 60, recipientHint: maskEmail(sc.patientUser.email) });
    expect(st.delivery.resendAvailableAt).toBe(first.body.data.delivery.resendAvailableAt);
    age(h, sc.visit.id, 61);
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(201);
  });

  it('a resend supersedes the previous OTP: exactly one active, old code rejected, new code works', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const oldCode = provider.lastCode();
    age(h, sc.visit.id, 61);
    await issue(h, sc.visit.id, sc.coord);
    const newCode = provider.lastCode();
    expect(provider.sent).toHaveLength(2);
    const statuses = (h.ctx.db.prepare('SELECT status FROM otp_records WHERE visit_id = ? ORDER BY rowid').all(sc.visit.id) as Array<{ status: string }>).map((r) => r.status);
    expect(statuses).toEqual(['superseded', 'active']);
    if (oldCode !== newCode) {
      const stale = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: oldCode });
      expect(stale.status).toBe(400); // old code is just "incorrect" against the new active OTP
    }
    expect((await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: newCode })).status).toBe(200);
  });

  it('two simultaneous requests send exactly one email', async () => {
    const { h, provider } = setup();
    provider.delayMs = 60;
    const sc = await makeScenario(h);
    const [a, b] = await Promise.all([issue(h, sc.visit.id, sc.coord), issue(h, sc.visit.id, sc.admin)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(provider.sent).toHaveLength(1);
    expect((h.ctx.db.prepare(`SELECT COUNT(*) c FROM otp_records WHERE visit_id = ? AND status = 'active'`).get(sc.visit.id) as any).c).toBe(1);
  });

  it('still enforces the hourly per-visit cap', async () => {
    const { h } = setup({ OTP_RESEND_COOLDOWN_SECONDS: '0' });
    const sc = await makeScenario(h);
    for (let i = 0; i < 5; i++) expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(201);
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(429);
  });

  it('rate-limits repeated issuance per staff user across visits', async () => {
    const { h } = setup({ RATE_LIMIT_ENABLED: 'true', OTP_ISSUE_RATE_LIMIT_MAX: '2' });
    const sc = await makeScenario(h);
    const v2 = sc.newVisit('Second'); const v3 = sc.newVisit('Third');
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(201);
    expect((await issue(h, v2.id, sc.coord)).status).toBe(201);
    const limited = await issue(h, v3.id, sc.coord);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect((await issue(h, v3.id, sc.admin)).status).toBe(201); // another user is unaffected
  });
});

describe('OTP email: verification rules are unchanged', () => {
  it('wrong code decrements attempts, 5 wrong codes lock it, and the correct code is then refused', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const code = provider.lastCode();
    const bad = code === '999999' ? '888888' : '999999';
    const first = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: bad });
    expect(first.status).toBe(400);
    expect(first.body.error.details.remainingAttempts).toBe(4);
    for (let i = 0; i < 3; i++) await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: bad });
    const last = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: bad });
    expect(last.status).toBe(423);
    expect((await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code })).status).toBe(423);
    // a locked OTP can be replaced by staff (after the cooldown)
    age(h, sc.visit.id, 61);
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(201);
  });

  it('an expired code returns 410, and a used code cannot be reused', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const code = provider.lastCode();
    h.ctx.db.prepare(`UPDATE otp_records SET expires_at = ? WHERE visit_id = ?`).run(new Date(Date.now() - 1000).toISOString(), sc.visit.id);
    const late = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code });
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('OTP_EXPIRED');

    age(h, sc.visit.id, 61);
    await issue(h, sc.visit.id, sc.coord);
    const fresh = provider.lastCode();
    expect((await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: fresh })).status).toBe(200);
    const reuse = await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: fresh });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('OTP_NOT_ACTIVE');
  });

  it('rate-limits verification attempts per user on top of the lockout', async () => {
    const { h, provider } = setup({ RATE_LIMIT_ENABLED: 'true', OTP_VERIFY_RATE_LIMIT_MAX: '3' });
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const bad = provider.lastCode() === '999999' ? '888888' : '999999';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: bad })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  });
});

describe('OTP email: authorization', () => {
  it('only staff can issue; participants (even for their own visit) and anonymous callers cannot', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    expect((await h.api.post(`${api}/visits/${sc.visit.id}/otp`)).status).toBe(401);
    expect((await issue(h, sc.visit.id, sc.patientUser)).status).toBe(403);
    expect(provider.sent).toHaveLength(0);
    for (const staff of [sc.coord, sc.inv, sc.admin]) {
      age(h, sc.visit.id, 61);
      expect((await issue(h, sc.visit.id, staff)).status).toBe(201);
    }
  });

  it("a participant cannot verify or even view another participant's visit OTP", async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const stranger = await makeUser(h, 'patient');
    h.s.patients.create({ firstName: 'Str', lastName: 'Anger', dateOfBirth: '1990-01-01', sex: 'male', userId: stranger.id }, sc.coord.actor);
    expect((await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(stranger)).send({ code: provider.lastCode() })).status).toBe(403);
    expect((await h.api.get(`${api}/visits/${sc.visit.id}/otp`).set(bearer(stranger))).status).toBe(403);
    expect((await issue(h, sc.visit.id, stranger)).status).toBe(403);
  });

  it('the participant sees only a masked address and no code or hash in OTP status', async () => {
    const { h, provider } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.coord);
    const res = await h.api.get(`${api}/visits/${sc.visit.id}/otp`).set(bearer(sc.patientUser));
    expect(res.status).toBe(200);
    expect(res.body.data.delivery.recipientHint).toBe(maskEmail(sc.patientUser.email));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(sc.patientUser.email);
    expect(text).not.toContain(provider.lastCode());
    expect(text).not.toMatch(/hash/i);
  });

  it('does not enumerate accounts: no public endpoint accepts an email for OTP delivery', async () => {
    const { h } = setup();
    for (const path of ['/auth/otp', '/otp/send', '/auth/forgot-password']) {
      const r = await h.api.post(`${api}${path}`).send({ email: 'someone@example.org' });
      expect(r.status).toBe(404);
    }
    expect(PASSWORD.length).toBeGreaterThan(0);
  });
});

describe('OTP demo mode (development only) is unchanged but cannot coexist with email', () => {
  it('returns the demo OTP only with demo on and email off, never emails, and applies the cooldown', async () => {
    const provider = new FakeEmailProvider();
    const h = makeHarness({ env: { ...COOLDOWN }, emailProvider: provider }); // TEST_ENV has DEMO_OTP_ENABLED=true, email off
    const sc = await makeScenario(h);
    const res = await issue(h, sc.visit.id, sc.coord);
    expect(res.status).toBe(201);
    expect(res.body.data.demoOtp).toMatch(/^\d{6}$/);
    expect(res.body.data.delivery).toMatchObject({ channel: 'demo', status: 'demo' });
    expect(provider.sent).toHaveLength(0);
    expect((await issue(h, sc.visit.id, sc.coord)).status).toBe(429);
  });
  it('with email enabled there is no demo route and no demo store entry', async () => {
    const { h } = setup();
    const sc = await makeScenario(h);
    await issue(h, sc.visit.id, sc.admin);
    expect(h.ctx.demoOtp.size).toBe(0);
    expect((await h.api.get(`${api}/dev/visits/${sc.visit.id}/otp`).set(bearer(sc.admin))).status).toBe(404);
  });
});
