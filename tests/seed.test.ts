import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { buildContext } from '../src/bootstrap';
import { createLogger } from '../src/config/logger';
import { DEMO_OTP, DEMO_PASSWORD, seed } from '../src/seed/seed';
import { verifyChain } from '../src/modules/audit/chain';
import { makeConfig } from './helpers';

describe('demo seed', () => {
  it('populates every module and produces a valid audit chain that is immediately usable via the API', async () => {
    const ctx = buildContext(makeConfig(), { logger: createLogger('silent') });
    const out = await seed(ctx);
    expect(out.chain.valid).toBe(true);
    expect(out.counts).toMatchObject({ users: 8, patients: 8, trials: 3, trial_sites: 4, enrollments: 8 });
    for (const t of ['visits', 'otp_records', 'reimbursements', 'actions', 'risk_assessments', 'integrity_alerts', 'audit_logs']) expect(out.counts[t], t).toBeGreaterThan(4);
    expect(verifyChain(ctx.db).valid).toBe(true);

    const statuses = (q: string) => (ctx.db.prepare(q).all() as { s: string }[]).map((r) => r.s).sort();
    expect(statuses('SELECT DISTINCT status s FROM visits')).toEqual(['cancelled', 'completed', 'missed', 'otp_pending', 'scheduled', 'verified']);
    expect(statuses('SELECT DISTINCT status s FROM otp_records')).toEqual(expect.arrayContaining(['active', 'used', 'locked', 'expired']));
    expect(statuses('SELECT DISTINCT status s FROM reimbursements')).toEqual(['approved', 'cancelled', 'pending', 'rejected']);
    expect(statuses('SELECT DISTINCT payment_status s FROM reimbursements')).toEqual(expect.arrayContaining(['paid', 'failed', 'unpaid']));

    const api = request(createApp(ctx));
    const login = await api.post('/api/v1/auth/login').send({ email: 'coordinator1@trialguard.demo', password: DEMO_PASSWORD });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.token}` };
    // The seeded OTP works with the documented demo code.
    const verify = await api.post(`/api/v1/visits/${out.ids.vRajeshToday}/otp/verify`).set(auth).send({ code: DEMO_OTP });
    expect(verify.body.data.status).toBe('verified');
    const patientLogin = await api.post('/api/v1/auth/login').send({ email: 'patient1@trialguard.demo', password: DEMO_PASSWORD });
    const mine = await api.get('/api/v1/visits').set({ Authorization: `Bearer ${patientLogin.body.data.token}` });
    expect(mine.body.data.length).toBeGreaterThan(1);
    // Risk events and alerts exist for the suspicious patient.
    const admin = await api.post('/api/v1/auth/login').send({ email: 'admin@trialguard.demo', password: DEMO_PASSWORD });
    const high = await api.get('/api/v1/risk/assessments?minScore=50').set({ Authorization: `Bearer ${admin.body.data.token}` });
    expect(high.body.data.length).toBeGreaterThanOrEqual(3);
    const overdue = await api.get('/api/v1/actions?status=overdue').set(auth);
    expect(overdue.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to seed a non-empty database', async () => {
    const ctx = buildContext(makeConfig(), { logger: createLogger('silent') });
    await seed(ctx);
    await expect(seed(ctx)).rejects.toThrow(/already contains users/);
  });
});
