import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { bearer, makeHarness, makeUser, PASSWORD } from './helpers';

describe('authentication', () => {
  const h = makeHarness();

  it('registers a patient account and returns a token (password is never returned)', async () => {
    const res = await h.api.post('/api/v1/auth/register').send({ email: 'New@Test.local', password: PASSWORD, fullName: 'New Person' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ email: 'new@test.local', role: 'patient', isActive: true });
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('ignores a client-supplied role on public registration (no privilege escalation)', async () => {
    const res = await h.api.post('/api/v1/auth/register').send({ email: 'sneaky@test.local', password: PASSWORD, fullName: 'Sneaky', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('patient');
  });

  it('stores only a bcrypt hash of the password', async () => {
    await h.api.post('/api/v1/auth/register').send({ email: 'hash@test.local', password: PASSWORD, fullName: 'Hash' });
    const row = h.ctx.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('hash@test.local') as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$2[aby]\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });

  it('rejects duplicate emails (case-insensitive) with 409', async () => {
    await h.api.post('/api/v1/auth/register').send({ email: 'dup@test.local', password: PASSWORD, fullName: 'Dup' });
    const res = await h.api.post('/api/v1/auth/register').send({ email: 'DUP@test.local', password: PASSWORD, fullName: 'Dup' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    [{ email: 'not-an-email', password: PASSWORD, fullName: 'X' }, 'email'],
    [{ email: 'a@b.co', password: 'short1', fullName: 'X' }, 'password'],
    [{ email: 'a@b.co', password: 'nodigitsnodigits', fullName: 'X' }, 'password'],
    [{ email: 'a@b.co', password: PASSWORD }, 'fullName'],
  ])('rejects invalid registration %#', async (body, field) => {
    const res = await h.api.post('/api/v1/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
  });

  it('logs in with valid credentials and the token authenticates /auth/me', async () => {
    const u = await makeUser(h, 'coordinator');
    const login = await h.api.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const me = await h.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ id: u.id, role: 'coordinator' });
    expect(me.body.data.lastLoginAt).toBeTruthy();
  });

  it('returns the same generic 401 for wrong password and unknown email', async () => {
    const u = await makeUser(h, 'coordinator');
    const wrong = await h.api.post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-Password1' });
    const unknown = await h.api.post('/api/v1/auth/login').send({ email: 'ghost@test.local', password: 'Wrong-Password1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('records failed and successful logins in the audit chain', async () => {
    const u = await makeUser(h, 'investigator');
    await h.api.post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-Password1' });
    await h.api.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    const actions = (h.ctx.db.prepare(`SELECT action FROM audit_logs WHERE entity_id = ? AND action LIKE 'auth.%' ORDER BY seq`).all(u.id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['auth.login_failed', 'auth.login_succeeded']);
  });

  it('rejects login for deactivated accounts and invalidates their existing tokens', async () => {
    const admin = await makeUser(h, 'admin');
    const u = await makeUser(h, 'coordinator');
    expect((await h.api.get('/api/v1/auth/me').set(bearer(u))).status).toBe(200);
    const off = await h.api.patch(`/api/v1/users/${u.id}`).set(bearer(admin)).send({ isActive: false });
    expect(off.status).toBe(200);
    expect((await h.api.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(401);
    expect((await h.api.get('/api/v1/auth/me').set(bearer(u))).status).toBe(401);
  });

  it('rejects missing, malformed, tampered, wrong-secret, expired and alg=none tokens', async () => {
    const u = await makeUser(h, 'admin');
    expect((await h.api.get('/api/v1/auth/me')).status).toBe(401);
    expect((await h.api.get('/api/v1/auth/me').set('Authorization', 'Basic abc')).status).toBe(401);
    expect((await h.api.get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
    const forged = jwt.sign({ role: 'admin' }, 'some-other-secret-some-other-secret-123', { subject: u.id });
    expect((await h.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = jwt.sign({ role: 'admin' }, h.ctx.config.jwt.secret, { subject: u.id, expiresIn: -10 });
    expect((await h.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: u.id, role: 'admin' })).toString('base64url')}.`;
    expect((await h.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${none}`)).status).toBe(401);
  });

  it('uses the role stored in the database, not the role claimed in the token', async () => {
    const u = await makeUser(h, 'patient');
    const lying = jwt.sign({ role: 'admin' }, h.ctx.config.jwt.secret, { subject: u.id });
    const res = await h.api.get('/api/v1/users').set('Authorization', `Bearer ${lying}`);
    expect(res.status).toBe(403);
  });

  it('rate limits auth endpoints when enabled', async () => {
    const limited = makeHarness({ env: { RATE_LIMIT_ENABLED: 'true', AUTH_RATE_LIMIT_MAX: '3' } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.api.post('/api/v1/auth/login').send({ email: 'x@y.co', password: 'whatever12' })).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
