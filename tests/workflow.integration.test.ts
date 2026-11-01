import { describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeUser, PASSWORD } from './helpers';

/** End-to-end clinical workflow through HTTP only, exactly as a frontend would drive it. */
describe('integration: full trial → visit → OTP → reimbursement → audit workflow', () => {
  const h = makeHarness();

  it('runs the whole lifecycle and leaves a complete, verifiable audit trail', async () => {
    const admin = await makeUser(h, 'admin');
    const coord = await makeUser(h, 'coordinator');
    const inv = await makeUser(h, 'investigator');
    const api = h.api;

    // Patient self-registers; staff creates the clinical record and links it.
    const reg = await api.post('/api/v1/auth/register').send({ email: 'jane@patients.test', password: PASSWORD, fullName: 'Jane Roe' });
    expect(reg.status).toBe(201);
    const patientAuth = { token: reg.body.data.token };
    const patientUserId = reg.body.data.user.id;

    const trial = (await api.post('/api/v1/trials').set(bearer(coord)).send({ code: 'E2E-001', title: 'End to End Trial', sponsor: 'Acme', phase: 'III' })).body.data;
    await api.patch(`/api/v1/trials/${trial.id}`).set(bearer(admin)).send({ status: 'active' }).expect(200);
    const site = (await api.post(`/api/v1/trials/${trial.id}/sites`).set(bearer(coord)).send({ siteCode: 'E2E-S1', name: 'E2E Site', country: 'USA', principalInvestigatorId: inv.id })).body.data;
    const patient = (await api.post('/api/v1/patients').set(bearer(coord)).send({ firstName: 'Jane', lastName: 'Roe', dateOfBirth: '1979-04-02', sex: 'female', userId: patientUserId })).body.data;
    const enrollment = (await api.post('/api/v1/enrollments').set(bearer(coord)).send({ patientId: patient.id, trialId: trial.id, trialSiteId: site.id })).body.data;
    await api.patch(`/api/v1/enrollments/${enrollment.id}`).set(bearer(inv)).send({ status: 'enrolled' }).expect(200);

    // Visit + OTP
    const visit = (await api.post('/api/v1/visits').set(bearer(coord)).send({ enrollmentId: enrollment.id, visitType: 'Baseline', scheduledAt: new Date().toISOString() })).body.data;
    const issued = await api.post(`/api/v1/visits/${visit.id}/otp`).set(bearer(coord));
    expect(issued.status).toBe(201);
    const code: string = issued.body.data.demoOtp;

    // A wrong guess, then the patient verifies with the right one.
    const wrong = await api.post(`/api/v1/visits/${visit.id}/otp/verify`).set(bearer(patientAuth)).send({ code: code === '000000' ? '111111' : '000000' });
    expect(wrong.body.error.code).toBe('OTP_INVALID');
    const verified = await api.post(`/api/v1/visits/${visit.id}/otp/verify`).set(bearer(patientAuth)).send({ code });
    expect(verified.body.data.status).toBe('verified');
    const reuse = await api.post(`/api/v1/visits/${visit.id}/otp/verify`).set(bearer(patientAuth)).send({ code });
    expect(reuse.status).toBe(409);

    await api.post(`/api/v1/visits/${visit.id}/status`).set(bearer(inv)).send({ status: 'completed' }).expect(200);

    // Reimbursement: patient requests, investigator approves, admin pays.
    const reimb = (await api.post('/api/v1/reimbursements').set(bearer(patientAuth)).send({ visitId: visit.id, category: 'travel', amountCents: 6400, description: 'Taxi' })).body.data;
    await api.post(`/api/v1/reimbursements/${reimb.id}/approve`).set(bearer(inv)).send({}).expect(200);
    await api.post(`/api/v1/reimbursements/${reimb.id}/payment`).set(bearer(admin)).send({ status: 'processing' }).expect(200);
    const paid = await api.post(`/api/v1/reimbursements/${reimb.id}/payment`).set(bearer(admin)).send({ status: 'paid', transactionRef: 'TXN-E2E-1' });
    expect(paid.body.data).toMatchObject({ status: 'approved', paymentStatus: 'paid' });

    // Follow-up action, risk and integrity checks.
    const action = await api.post('/api/v1/actions').set(bearer(coord)).send({ title: 'File visit source documents', assigneeId: coord.id, visitId: visit.id, patientId: patient.id, trialId: trial.id, priority: 'low' });
    expect(action.status).toBe(201);
    const risk = await api.post('/api/v1/risk/assessments').set(bearer(inv)).send({ entityType: 'patient', entityId: patient.id });
    expect(risk.status).toBe(201);
    expect(risk.body.data.level).toBe('low');
    expect((await api.post('/api/v1/integrity/scans').set(bearer(inv)).send({})).status).toBe(201);

    // The patient sees only their own data.
    const mine = await api.get('/api/v1/visits').set(bearer(patientAuth));
    expect(mine.body.data.map((v: { id: string }) => v.id)).toEqual([visit.id]);
    expect((await api.get('/api/v1/audit').set(bearer(patientAuth))).status).toBe(403);

    // Audit trail covers every step, in order, and the chain verifies.
    const trail = await api.get(`/api/v1/audit?entityType=visit&entityId=${visit.id}&order=asc&pageSize=100`).set(bearer(admin));
    expect(trail.body.data.map((e: { action: string }) => e.action)).toEqual([
      'visit.created', 'otp.issued', 'otp.verify_failed', 'otp.verified', 'visit.verified', 'otp.verify_failed', 'visit.completed']);
    const reimbTrail = await api.get(`/api/v1/audit?entityType=reimbursement&entityId=${reimb.id}&order=asc`).set(bearer(inv));
    expect(reimbTrail.body.data.map((e: { action: string }) => e.action)).toEqual(
      ['reimbursement.created', 'reimbursement.approved', 'reimbursement.payment_processing', 'reimbursement.payment_paid']);
    const verify = await api.get('/api/v1/audit/verify').set(bearer(admin));
    expect(verify.body.data).toMatchObject({ valid: true, errors: [] });
    expect(verify.body.data.eventsChecked).toBeGreaterThan(20);

    // Every event is linked to the previous one.
    const all = (await api.get('/api/v1/audit?order=asc&pageSize=100').set(bearer(admin))).body.data as { prevHash: string; hash: string }[];
    for (let i = 1; i < all.length; i++) expect(all[i].prevHash).toBe(all[i - 1].hash);
  });
});
