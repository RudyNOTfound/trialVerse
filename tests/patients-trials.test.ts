import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario } from './helpers';

describe('patient management', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });

  const create = (over = {}) => h.api.post('/api/v1/patients').set(bearer(sc.coord))
    .send({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1985-12-10', sex: 'female', email: 'ada@example.org', ...over });

  it('creates a patient with an auto-generated subject code', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ firstName: 'Ada', status: 'active' });
    expect(res.body.data.subjectCode).toMatch(/^P-\d{4}$/);
  });

  it('rejects duplicate subject codes and invalid data', async () => {
    expect((await create({ subjectCode: 'SUBJ-001' })).status).toBe(201);
    expect((await create({ subjectCode: 'SUBJ-001' })).status).toBe(409);
    expect((await create({ dateOfBirth: '2999-01-01' })).status).toBe(400);
    expect((await create({ dateOfBirth: '1985/12/10' })).status).toBe(400);
    expect((await create({ sex: 'robot' })).status).toBe(400);
    expect((await create({ firstName: '' })).status).toBe(400);
  });

  it('reads, updates and audits a patient (without PII in the audit trail)', async () => {
    const id = (await create({ firstName: 'Grace', lastName: 'Hopper' })).body.data.id;
    expect((await h.api.get(`/api/v1/patients/${id}`).set(bearer(sc.inv))).body.data.lastName).toBe('Hopper');
    const upd = await h.api.patch(`/api/v1/patients/${id}`).set(bearer(sc.coord)).send({ phone: '+1-555-1234', status: 'withdrawn' });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ phone: '+1-555-1234', status: 'withdrawn' });
    const events = h.ctx.db.prepare(`SELECT action, metadata FROM audit_logs WHERE entity_id = ? ORDER BY seq`).all(id) as { action: string; metadata: string }[];
    expect(events.map((e) => e.action)).toEqual(['patient.created', 'patient.updated']);
    const all = events.map((e) => e.metadata).join('');
    expect(all).not.toMatch(/Hopper|Grace|555-1234/);
    expect(JSON.parse(events[1].metadata).changedFields).toEqual(expect.arrayContaining(['phone', 'status']));
  });

  it('rejects empty updates and unknown ids', async () => {
    expect((await h.api.patch(`/api/v1/patients/${sc.patient.id}`).set(bearer(sc.coord)).send({})).status).toBe(400);
    expect((await h.api.get('/api/v1/patients/not-a-uuid').set(bearer(sc.coord))).status).toBe(400);
    expect((await h.api.get('/api/v1/patients/00000000-0000-4000-8000-000000000000').set(bearer(sc.coord))).status).toBe(404);
  });

  it('paginates, searches, filters and sorts', async () => {
    for (let i = 0; i < 5; i++) await create({ firstName: `Zed${i}`, lastName: `Zulu${i}` });
    const page1 = await h.api.get('/api/v1/patients?pageSize=3&page=1&sort=lastName&order=asc').set(bearer(sc.admin));
    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 3 });
    expect(page1.body.meta.total).toBeGreaterThanOrEqual(8);
    expect(page1.body.meta.totalPages).toBe(Math.ceil(page1.body.meta.total / 3));
    const names = page1.body.data.map((p: { lastName: string }) => p.lastName);
    expect(names).toEqual([...names].sort());
    const search = await h.api.get('/api/v1/patients?search=Zulu3').set(bearer(sc.admin));
    expect(search.body.data).toHaveLength(1);
    const byTrial = await h.api.get(`/api/v1/patients?trialId=${sc.trial.id}`).set(bearer(sc.admin));
    expect(byTrial.body.data.map((p: { id: string }) => p.id)).toEqual([sc.patient.id]);
    expect((await h.api.get('/api/v1/patients?pageSize=1000').set(bearer(sc.admin))).status).toBe(400);
    expect((await h.api.get('/api/v1/patients?sort=password').set(bearer(sc.admin))).status).toBe(400);
  });

  it('soft-deletes patients without enrollments and refuses otherwise', async () => {
    const id = (await create({ firstName: 'Temp' })).body.data.id;
    expect((await h.api.delete(`/api/v1/patients/${id}`).set(bearer(sc.admin))).status).toBe(200);
    expect((await h.api.get(`/api/v1/patients/${id}`).set(bearer(sc.admin))).status).toBe(404);
    const refused = await h.api.delete(`/api/v1/patients/${sc.patient.id}`).set(bearer(sc.admin));
    expect(refused.status).toBe(409);
  });

  it('only links patient-role users, and each user to one patient', async () => {
    const id = (await create({ firstName: 'Link' })).body.data.id;
    expect((await h.api.patch(`/api/v1/patients/${id}`).set(bearer(sc.coord)).send({ userId: sc.coord.id })).status).toBe(400);
    expect((await h.api.patch(`/api/v1/patients/${id}`).set(bearer(sc.coord)).send({ userId: sc.patientUser.id })).status).toBe(409);
  });
});

describe('trial management', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });
  const body = (over = {}) => ({ code: 'TRL-100', title: 'Heart Study', sponsor: 'Acme', phase: 'II', ...over });

  it('creates trials in draft, enforces unique codes and date ordering', async () => {
    const res = await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect((await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body())).status).toBe(409);
    expect((await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body({ code: 'TRL-101', startDate: '2025-05-01', endDate: '2025-04-01' }))).status).toBe(400);
    expect((await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body({ code: 'TRL-102', phase: 'V' }))).status).toBe(400);
  });

  it('follows the trial status state machine', async () => {
    const id = (await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body({ code: 'TRL-200' }))).body.data.id;
    const patch = (status: string) => h.api.patch(`/api/v1/trials/${id}`).set(bearer(sc.coord)).send({ status });
    expect((await patch('completed')).status).toBe(409);           // draft -> completed not allowed
    expect((await patch('active')).status).toBe(200);
    expect((await patch('suspended')).status).toBe(200);
    expect((await patch('active')).status).toBe(200);
    expect((await patch('completed')).status).toBe(200);
    const bad = await patch('active');                              // terminal
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('lists with filters, and gets/updates/deletes', async () => {
    const list = await h.api.get('/api/v1/trials?status=active&phase=II&sort=code&order=asc').set(bearer(sc.inv));
    expect(list.status).toBe(200);
    expect(list.body.data.every((t: { status: string }) => t.status === 'active')).toBe(true);
    const upd = await h.api.patch(`/api/v1/trials/${sc.trial.id}`).set(bearer(sc.coord)).send({ title: 'Renamed Trial' });
    expect(upd.body.data.title).toBe('Renamed Trial');
    expect((await h.api.patch(`/api/v1/trials/${sc.trial.id}`).set(bearer(sc.coord)).send({ endDate: '1999-01-01', startDate: '2000-01-01' })).status).toBe(400);
    const id = (await h.api.post('/api/v1/trials').set(bearer(sc.coord)).send(body({ code: 'TRL-300' }))).body.data.id;
    expect((await h.api.delete(`/api/v1/trials/${id}`).set(bearer(sc.admin))).status).toBe(200);
    expect((await h.api.get(`/api/v1/trials/${id}`).set(bearer(sc.admin))).status).toBe(404);
    expect((await h.api.delete(`/api/v1/trials/${sc.trial.id}`).set(bearer(sc.admin))).status).toBe(409); // has enrollments
  });

  it('manages sites, validating principal investigators and unique site codes per trial', async () => {
    const base = `/api/v1/trials/${sc.trial.id}/sites`;
    const created = await h.api.post(base).set(bearer(sc.coord)).send({ siteCode: 'S-02', name: 'Second', country: 'UK', principalInvestigatorId: sc.inv.id });
    expect(created.status).toBe(201);
    expect((await h.api.post(base).set(bearer(sc.coord)).send({ siteCode: 'S-02', name: 'Dup', country: 'UK' })).status).toBe(409);
    expect((await h.api.post(base).set(bearer(sc.coord)).send({ siteCode: 'S-03', name: 'Bad PI', country: 'UK', principalInvestigatorId: sc.coord.id })).status).toBe(400);
    expect((await h.api.get(base).set(bearer(sc.inv))).body.data.length).toBeGreaterThanOrEqual(2);
    const upd = await h.api.patch(`${base}/${created.body.data.id}`).set(bearer(sc.coord)).send({ status: 'inactive' });
    expect(upd.body.data.status).toBe('inactive');
    expect((await h.api.get(`/api/v1/trials/${sc.trial.id}/sites/${sc.site.id}`).set(bearer(sc.inv))).status).toBe(200);
  });

  it('manages enrollments with validation and a status state machine', async () => {
    const p = h.s.patients.create({ firstName: 'En', lastName: 'Roll', dateOfBirth: '1970-01-01', sex: 'male' }, sc.coord.actor);
    const other = h.s.trials.createTrial({ code: 'OTHER-1', title: 'Other trial', sponsor: 'X', phase: 'I' }, sc.admin.actor);
    const otherSite = h.s.trials.createSite(other.id, { siteCode: 'O-1', name: 'O', country: 'US' }, sc.admin.actor);
    const post = (b: object) => h.api.post('/api/v1/enrollments').set(bearer(sc.coord)).send(b);
    // site must belong to the trial
    expect((await post({ patientId: p.id, trialId: sc.trial.id, trialSiteId: otherSite.id })).status).toBe(404);
    expect((await post({ patientId: '00000000-0000-4000-8000-000000000000', trialId: sc.trial.id, trialSiteId: sc.site.id })).status).toBe(404);
    const e = await post({ patientId: p.id, trialId: sc.trial.id, trialSiteId: sc.site.id, arm: 'A' });
    expect(e.status).toBe(201);
    expect(e.body.data.status).toBe('screening');
    expect((await post({ patientId: p.id, trialId: sc.trial.id, trialSiteId: sc.site.id })).status).toBe(409);
    const patch = (status: string) => h.api.patch(`/api/v1/enrollments/${e.body.data.id}`).set(bearer(sc.inv)).send({ status });
    expect((await patch('completed')).status).toBe(409);
    const enrolled = await patch('enrolled');
    expect(enrolled.body.data.enrolledAt).toBeTruthy();
    const done = await patch('completed');
    expect(done.body.data.endedAt).toBeTruthy();
    expect((await patch('enrolled')).status).toBe(409);
    const list = await h.api.get(`/api/v1/enrollments?trialId=${sc.trial.id}&status=completed`).set(bearer(sc.admin));
    expect(list.body.data).toHaveLength(1);
    // closed trials do not accept enrollments
    h.s.trials.updateTrial(other.id, { status: 'terminated' }, sc.admin.actor);
    expect((await post({ patientId: p.id, trialId: other.id, trialSiteId: otherSite.id })).status).toBe(409);
  });
});
