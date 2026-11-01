import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario, makeUser } from './helpers';

describe('role-based authorization', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  let otherPatientUser: Awaited<ReturnType<typeof makeUser>>;
  let otherPatientId: string;

  beforeAll(async () => {
    sc = await makeScenario(h);
    otherPatientUser = await makeUser(h, 'patient');
    otherPatientId = h.s.patients.create({ firstName: 'Other', lastName: 'Person', dateOfBirth: '1990-02-02', sex: 'male', userId: otherPatientUser.id }, sc.coord.actor).id;
  });

  it('requires authentication on every protected route group', async () => {
    for (const path of ['/users', '/patients', '/trials', '/enrollments', '/visits', '/audit', '/audit/verify', '/reimbursements', '/actions', '/risk/assessments', '/integrity/alerts']) {
      const res = await h.api.get(`/api/v1${path}`);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('only admins can manage users', async () => {
    for (const u of [sc.coord, sc.inv, sc.patientUser]) expect((await h.api.get('/api/v1/users').set(bearer(u))).status).toBe(403);
    expect((await h.api.get('/api/v1/users').set(bearer(sc.admin))).status).toBe(200);
    const create = { email: 'staff@test.local', password: 'Passw0rd-Strong1', fullName: 'Staff', role: 'investigator' };
    expect((await h.api.post('/api/v1/users').set(bearer(sc.coord)).send(create)).status).toBe(403);
    const ok = await h.api.post('/api/v1/users').set(bearer(sc.admin)).send(create);
    expect(ok.status).toBe(201);
    expect(ok.body.data.role).toBe('investigator');
  });

  it('prevents an admin from demoting or deactivating themselves', async () => {
    const res = await h.api.patch(`/api/v1/users/${sc.admin.id}`).set(bearer(sc.admin)).send({ role: 'patient' });
    expect(res.status).toBe(409);
  });

  it('enforces patient-management permissions', async () => {
    const body = { firstName: 'A', lastName: 'B', dateOfBirth: '1991-01-01', sex: 'other' };
    expect((await h.api.post('/api/v1/patients').set(bearer(sc.inv)).send(body)).status).toBe(403);
    expect((await h.api.post('/api/v1/patients').set(bearer(sc.patientUser)).send(body)).status).toBe(403);
    expect((await h.api.post('/api/v1/patients').set(bearer(sc.coord)).send(body)).status).toBe(201);
    expect((await h.api.get('/api/v1/patients').set(bearer(sc.inv))).status).toBe(200);
    expect((await h.api.get('/api/v1/patients').set(bearer(sc.patientUser))).status).toBe(403);
    expect((await h.api.delete(`/api/v1/patients/${otherPatientId}`).set(bearer(sc.coord))).status).toBe(403);
  });

  it('lets a patient read only their own record', async () => {
    expect((await h.api.get(`/api/v1/patients/${sc.patient.id}`).set(bearer(sc.patientUser))).status).toBe(200);
    expect((await h.api.get(`/api/v1/patients/${otherPatientId}`).set(bearer(sc.patientUser))).status).toBe(403);
    const me = await h.api.get('/api/v1/patients/me').set(bearer(sc.patientUser));
    expect(me.body.data.id).toBe(sc.patient.id);
  });

  it('scopes visit / enrollment lists to the patient server-side', async () => {
    const mine = await h.api.get('/api/v1/visits').set(bearer(sc.patientUser));
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    // Attempting to widen the filter to another patient is overridden, not honoured.
    const spoof = await h.api.get(`/api/v1/visits?patientId=${otherPatientId}`).set(bearer(sc.patientUser));
    expect(spoof.body.data.every((v: { patientId: string }) => v.patientId === sc.patient.id)).toBe(true);
    const other = await h.api.get('/api/v1/visits').set(bearer(otherPatientUser));
    expect(other.body.data).toHaveLength(0);
    expect((await h.api.get(`/api/v1/visits/${sc.visit.id}`).set(bearer(otherPatientUser))).status).toBe(403);
    expect((await h.api.get(`/api/v1/enrollments/${sc.enrollment.id}`).set(bearer(otherPatientUser))).status).toBe(403);
  });

  it('blocks patients from staff-only modules', async () => {
    for (const path of ['/trials', '/actions', '/audit', '/risk/assessments', '/integrity/alerts']) {
      expect((await h.api.get(`/api/v1${path}`).set(bearer(sc.patientUser))).status, path).toBe(403);
    }
  });

  it('restricts audit access to admins and investigators', async () => {
    expect((await h.api.get('/api/v1/audit').set(bearer(sc.coord))).status).toBe(403);
    expect((await h.api.get('/api/v1/audit').set(bearer(sc.inv))).status).toBe(200);
    expect((await h.api.get('/api/v1/audit/verify').set(bearer(sc.coord))).status).toBe(403);
    expect((await h.api.get('/api/v1/audit/verify').set(bearer(sc.admin))).status).toBe(200);
  });

  it('restricts trial writes to admin/coordinator and deletes to admin', async () => {
    const body = { code: 'AUTHZ-1', title: 'Authz Trial', sponsor: 'S', phase: 'I' };
    expect((await h.api.post('/api/v1/trials').set(bearer(sc.inv)).send(body)).status).toBe(403);
    const created = await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body);
    expect(created.status).toBe(201);
    expect((await h.api.delete(`/api/v1/trials/${created.body.data.id}`).set(bearer(sc.coord))).status).toBe(403);
    expect((await h.api.delete(`/api/v1/trials/${created.body.data.id}`).set(bearer(sc.admin))).status).toBe(200);
  });

  it('restricts OTP issuance to staff and visit completion to investigators/admins', async () => {
    expect((await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.patientUser))).status).toBe(403);
    const issued = await h.api.post(`/api/v1/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    expect(issued.status).toBe(201);
    await h.api.post(`/api/v1/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: issued.body.data.demoOtp });
    const asCoord = await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.coord)).send({ status: 'completed' });
    expect(asCoord.status).toBe(403);
    const asInv = await h.api.post(`/api/v1/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });
    expect(asInv.status).toBe(200);
  });

  it('restricts integrity scans and reimbursement review/payment roles', async () => {
    expect((await h.api.post('/api/v1/integrity/scans').set(bearer(sc.coord)).send({})).status).toBe(403);
    expect((await h.api.post('/api/v1/integrity/scans').set(bearer(sc.inv)).send({})).status).toBe(201);
    const v = sc.newVisit();
    const r = await h.api.post('/api/v1/reimbursements').set(bearer(sc.coord)).send({ visitId: v.id, category: 'travel', amountCents: 1000 });
    expect(r.status).toBe(201);
    expect((await h.api.post(`/api/v1/reimbursements/${r.body.data.id}/approve`).set(bearer(sc.coord)).send({})).status).toBe(403);
    expect((await h.api.post(`/api/v1/reimbursements/${r.body.data.id}/payment`).set(bearer(sc.inv)).send({ status: 'processing' })).status).toBe(403);
  });

  it('does not expose the dev OTP route when demo mode is disabled', async () => {
    const prodLike = makeHarness({ env: { DEMO_OTP_ENABLED: 'false' } });
    const a = await makeUser(prodLike, 'admin');
    expect((await prodLike.api.get(`/api/v1/dev/visits/${sc.visit.id}/otp`).set(bearer(a))).status).toBe(404);
  });
});
