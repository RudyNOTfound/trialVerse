import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, makeHarness, makeScenario, makeUser, PASSWORD } from './helpers';

const api = '/api/v1';

describe('Phase 3: staff directory', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });

  it('requires authentication and excludes patients', async () => {
    expect((await h.api.get(`${api}/users/directory`)).status).toBe(401);
    expect((await h.api.get(`${api}/users/directory`).set(bearer(sc.patientUser))).status).toBe(403);
  });

  it('is readable by admin, coordinator and investigator', async () => {
    for (const u of [sc.admin, sc.coord, sc.inv]) expect((await h.api.get(`${api}/users/directory`).set(bearer(u))).status).toBe(200);
  });

  it('returns only id, fullName, role and isActive, and never patient accounts', async () => {
    const res = await h.api.get(`${api}/users/directory`).set(bearer(sc.coord));
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    for (const e of res.body.data) {
      expect(Object.keys(e).sort()).toEqual(['fullName', 'id', 'isActive', 'role']);
      expect(['admin', 'coordinator', 'investigator']).toContain(e.role);
    }
    expect(res.body.data.map((e: any) => e.id)).not.toContain(sc.patientUser.id);
    expect(JSON.stringify(res.body)).not.toMatch(/@test\.local|password|hash/i);
  });

  it('rejects asking for patient accounts via the role filter', async () => {
    expect((await h.api.get(`${api}/users/directory?role=patient`).set(bearer(sc.coord))).status).toBe(400);
  });

  it('filters by role and name, hides inactive staff by default, and can include them', async () => {
    const res = await h.api.get(`${api}/users/directory?role=investigator`).set(bearer(sc.coord));
    expect(res.body.data.every((e: any) => e.role === 'investigator')).toBe(true);
    const gone = await h.s.users.create({ email: 'retired@test.local', password: PASSWORD, fullName: 'Retired Investigator', role: 'investigator' }, null);
    await h.api.patch(`${api}/users/${gone.id}`).set(bearer(sc.admin)).send({ isActive: false });
    const active = await h.api.get(`${api}/users/directory?role=investigator`).set(bearer(sc.coord));
    expect(active.body.data.map((e: any) => e.id)).not.toContain(gone.id);
    const all = await h.api.get(`${api}/users/directory?role=investigator&includeInactive=true`).set(bearer(sc.coord));
    expect(all.body.data.find((e: any) => e.id === gone.id)?.isActive).toBe(false);
    const search = await h.api.get(`${api}/users/directory?search=Retired`).set(bearer(sc.coord));
    expect(search.body.meta.total).toBe(0); // inactive + hidden
    const found = await h.api.get(`${api}/users/directory?search=Retired&includeInactive=true`).set(bearer(sc.coord));
    expect(found.body.meta.total).toBe(1);
  });

  it('does not open the admin-only user list or user detail to staff', async () => {
    expect((await h.api.get(`${api}/users`).set(bearer(sc.coord))).status).toBe(403);
    expect((await h.api.get(`${api}/users/${sc.admin.id}`).set(bearer(sc.inv))).status).toBe(403);
    expect((await h.api.get(`${api}/users`).set(bearer(sc.admin))).status).toBe(200);
  });

  it('paginates', async () => {
    const res = await h.api.get(`${api}/users/directory?pageSize=2&page=1`).set(bearer(sc.coord));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.pageSize).toBe(2);
  });
});

describe('Phase 3: participant account linking', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });

  const newPatient = (name: string) => h.s.patients.create({ firstName: name, lastName: 'Linkable', dateOfBirth: '1990-01-01', sex: 'female' }, sc.coord.actor);
  const register = async (email: string) => (await h.api.post(`${api}/auth/register`).send({ email, password: PASSWORD, fullName: `Reg ${email}` })).body.data.user;

  it('lists only active, unlinked patient accounts, with minimal fields, to admin and coordinator', async () => {
    const fresh = await register('fresh-reg@test.local');
    const inactive = await register('inactive-reg@test.local');
    await h.api.patch(`${api}/users/${inactive.id}`).set(bearer(sc.admin)).send({ isActive: false });
    for (const u of [sc.admin, sc.coord]) {
      const res = await h.api.get(`${api}/patients/linkable-accounts`).set(bearer(u));
      expect(res.status).toBe(200);
      const ids = res.body.data.map((a: any) => a.id);
      expect(ids).toContain(fresh.id);
      expect(ids).not.toContain(inactive.id);          // deactivated
      expect(ids).not.toContain(sc.patientUser.id);    // already linked
      expect(ids).not.toContain(sc.coord.id);          // staff
      for (const a of res.body.data) expect(Object.keys(a).sort()).toEqual(['createdAt', 'email', 'fullName', 'id']);
    }
    const search = await h.api.get(`${api}/patients/linkable-accounts?search=fresh-reg`).set(bearer(sc.coord));
    expect(search.body.meta.total).toBe(1);
  });

  it('is forbidden to investigators and participants, and requires auth', async () => {
    expect((await h.api.get(`${api}/patients/linkable-accounts`)).status).toBe(401);
    expect((await h.api.get(`${api}/patients/linkable-accounts`).set(bearer(sc.inv))).status).toBe(403);
    expect((await h.api.get(`${api}/patients/linkable-accounts`).set(bearer(sc.patientUser))).status).toBe(403);
  });

  it('lets a coordinator link an account, audits it, and gives the participant access', async () => {
    const reg = await register('to-link@test.local');
    const p = newPatient('Linkme');
    const login = await h.api.post(`${api}/auth/login`).send({ email: 'to-link@test.local', password: PASSWORD });
    const before = await h.api.get(`${api}/patients/me`).set({ Authorization: `Bearer ${login.body.data.token}` });
    expect(before.status).toBe(404); // not linked yet
    const res = await h.api.post(`${api}/patients/${p.id}/account`).set(bearer(sc.coord)).send({ userId: reg.id });
    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBe(reg.id);
    const token = (await h.api.post(`${api}/auth/login`).send({ email: 'to-link@test.local', password: PASSWORD })).body.data.token;
    const me = await h.api.get(`${api}/patients/me`).set({ Authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(p.id);
    expect(res.body.data.portalAccountName).toBe(`Reg to-link@test.local`);
    const audit = await h.api.get(`${api}/audit?action=patient.account_linked&entityId=${p.id}`).set(bearer(sc.admin));
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0].actorId).toBe(sc.coord.id);
    // the linked account no longer appears as linkable
    const list = await h.api.get(`${api}/patients/linkable-accounts`).set(bearer(sc.coord));
    expect(list.body.data.map((a: any) => a.id)).not.toContain(reg.id);
  });

  it('rejects invalid links: staff user, unknown user, inactive user, malformed id', async () => {
    const p = newPatient('Invalid');
    const url = `${api}/patients/${p.id}/account`;
    expect((await h.api.post(url).set(bearer(sc.coord)).send({ userId: sc.inv.id })).status).toBe(400);
    expect((await h.api.post(url).set(bearer(sc.coord)).send({ userId: '11111111-1111-4111-8111-111111111111' })).status).toBe(400);
    expect((await h.api.post(url).set(bearer(sc.coord)).send({ userId: 'nope' })).status).toBe(400);
    const dead = await register('dead@test.local');
    await h.api.patch(`${api}/users/${dead.id}`).set(bearer(sc.admin)).send({ isActive: false });
    const res = await h.api.post(url).set(bearer(sc.coord)).send({ userId: dead.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/deactivated/);
    expect((await h.api.get(`${api}/patients/${p.id}`).set(bearer(sc.coord))).body.data.userId).toBeNull();
  });

  it('rejects duplicate links in both directions', async () => {
    const a = await register('dup-a@test.local');
    const p1 = newPatient('DupOne'); const p2 = newPatient('DupTwo');
    expect((await h.api.post(`${api}/patients/${p1.id}/account`).set(bearer(sc.coord)).send({ userId: a.id })).status).toBe(201);
    // same account to another patient
    const again = await h.api.post(`${api}/patients/${p2.id}/account`).set(bearer(sc.coord)).send({ userId: a.id });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already linked to another patient/);
    // another account to an already-linked patient
    const b = await register('dup-b@test.local');
    const full = await h.api.post(`${api}/patients/${p1.id}/account`).set(bearer(sc.coord)).send({ userId: b.id });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/unlink/);
    // re-linking the same pair is also a conflict, not a silent success
    expect((await h.api.post(`${api}/patients/${p1.id}/account`).set(bearer(sc.coord)).send({ userId: a.id })).status).toBe(409);
  });

  it('forbids investigators and participants from linking or unlinking', async () => {
    const p = newPatient('Forbidden'); const u = await register('forbidden@test.local');
    for (const actor of [sc.inv, sc.patientUser]) {
      expect((await h.api.post(`${api}/patients/${p.id}/account`).set(bearer(actor)).send({ userId: u.id })).status).toBe(403);
      expect((await h.api.delete(`${api}/patients/${sc.patient.id}/account`).set(bearer(actor))).status).toBe(403);
    }
    expect((await h.api.post(`${api}/patients/${p.id}/account`).send({ userId: u.id })).status).toBe(401);
  });

  it('unlinks, audits, and 409s when there is nothing to unlink; 404 for unknown patients', async () => {
    const u = await register('unlink@test.local'); const p = newPatient('Unlink');
    await h.api.post(`${api}/patients/${p.id}/account`).set(bearer(sc.coord)).send({ userId: u.id });
    const res = await h.api.delete(`${api}/patients/${p.id}/account`).set(bearer(sc.coord));
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBeNull();
    expect((await h.api.delete(`${api}/patients/${p.id}/account`).set(bearer(sc.coord))).status).toBe(409);
    const audit = await h.api.get(`${api}/audit?action=patient.account_unlinked&entityId=${p.id}`).set(bearer(sc.admin));
    expect(audit.body.data).toHaveLength(1);
    expect((await h.api.post(`${api}/patients/22222222-2222-4222-8222-222222222222/account`).set(bearer(sc.coord)).send({ userId: u.id })).status).toBe(404);
    // the account is linkable again after unlinking
    expect((await h.api.get(`${api}/patients/linkable-accounts`).set(bearer(sc.coord))).body.data.map((a: any) => a.id)).toContain(u.id);
  });

  it('keeps the existing PATCH link path working for admins and now refuses deactivated accounts there too', async () => {
    const u = await register('patch-link@test.local'); const p = newPatient('PatchLink');
    expect((await h.api.patch(`${api}/patients/${p.id}`).set(bearer(sc.admin)).send({ userId: u.id })).body.data.userId).toBe(u.id);
    const dead = await register('patch-dead@test.local'); const p2 = newPatient('PatchDead');
    await h.api.patch(`${api}/users/${dead.id}`).set(bearer(sc.admin)).send({ isActive: false });
    expect((await h.api.patch(`${api}/patients/${p2.id}`).set(bearer(sc.admin)).send({ userId: dead.id })).status).toBe(400);
  });
});

describe('Phase 3: embedded names', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });

  it('embeds patient, trial and site names in visits and enrollments', async () => {
    const v = (await h.api.get(`${api}/visits/${sc.visit.id}`).set(bearer(sc.coord))).body.data;
    expect(v).toMatchObject({ patientName: 'Pat Tester', trialCode: sc.trial.code, trialTitle: 'Test Trial', siteName: 'Site One' });
    expect(v.patientCode).toBe(sc.patient.subjectCode);
    const list = (await h.api.get(`${api}/visits`).set(bearer(sc.coord))).body.data;
    expect(list[0].patientName).toBe('Pat Tester');
    const e = (await h.api.get(`${api}/enrollments/${sc.enrollment.id}`).set(bearer(sc.coord))).body.data;
    expect(e).toMatchObject({ patientName: 'Pat Tester', trialCode: sc.trial.code, siteName: 'Site One' });
  });

  it('lets a participant see the trial and site names of their own visits (previously impossible)', async () => {
    const res = await h.api.get(`${api}/visits`).set(bearer(sc.patientUser));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ trialCode: sc.trial.code, siteName: 'Site One' });
    expect((await h.api.get(`${api}/trials`).set(bearer(sc.patientUser))).status).toBe(403); // but still no trial list access
  });

  it('embeds the principal investigator name on sites, and verifier / requester / reviewer names', async () => {
    const sites = (await h.api.get(`${api}/trials/${sc.trial.id}/sites`).set(bearer(sc.coord))).body.data;
    expect(sites[0].principalInvestigatorName).toBe('Test investigator');
    const otp = await h.api.post(`${api}/visits/${sc.visit.id}/otp`).set(bearer(sc.coord));
    await h.api.post(`${api}/visits/${sc.visit.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: otp.body.data.demoOtp });
    await h.api.post(`${api}/visits/${sc.visit.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });
    const v = (await h.api.get(`${api}/visits/${sc.visit.id}`).set(bearer(sc.coord))).body.data;
    expect(v.verifiedByName).toBe('Test patient');
    const r = (await h.api.post(`${api}/reimbursements`).set(bearer(sc.patientUser)).send({ visitId: sc.visit.id, category: 'travel', amountCents: 5000 })).body.data;
    expect(r).toMatchObject({ patientName: 'Pat Tester', trialCode: sc.trial.code, requestedByName: 'Test patient', reviewedByName: null });
    const approved = (await h.api.post(`${api}/reimbursements/${r.id}/approve`).set(bearer(sc.inv)).send({})).body.data;
    expect(approved.reviewedByName).toBe('Test investigator');
  });

  it('embeds assignee, creator and patient names on actions', async () => {
    const a = (await h.api.post(`${api}/actions`).set(bearer(sc.coord)).send({ title: 'Follow up', assigneeId: sc.inv.id, patientId: sc.patient.id })).body.data;
    expect(a).toMatchObject({ assigneeName: 'Test investigator', createdByName: 'Test coordinator', patientName: 'Pat Tester' });
    const list = (await h.api.get(`${api}/actions`).set(bearer(sc.coord))).body.data;
    expect(list.find((x: any) => x.id === a.id).assigneeName).toBe('Test investigator');
  });

  it('embeds actor names in reimbursement and action status history', async () => {
    const r = (await h.api.post(`${api}/reimbursements`).set(bearer(sc.patientUser)).send({ visitId: sc.visit.id, category: 'other', amountCents: 777 })).body.data;
    const rh = (await h.api.get(`${api}/reimbursements/${r.id}/history`).set(bearer(sc.coord))).body.data;
    expect(rh[0].actorName).toBe('Test patient');
    const a = (await h.api.post(`${api}/actions`).set(bearer(sc.coord)).send({ title: 'History names' })).body.data;
    await h.api.post(`${api}/actions/${a.id}/status`).set(bearer(sc.coord)).send({ status: 'in_progress' });
    const ah = (await h.api.get(`${api}/actions/${a.id}/history`).set(bearer(sc.coord))).body.data;
    expect(ah.every((x: any) => x.actorName === 'Test coordinator')).toBe(true);
  });

  it('embeds actor names in audit events without affecting chain verification', async () => {
    const list = (await h.api.get(`${api}/audit?pageSize=100`).set(bearer(sc.admin))).body.data;
    const created = list.find((e: any) => e.action === 'visit.created');
    expect(created.actorName).toBe('Test coordinator');
    expect(created.actorRole).toBe('coordinator');
    const v = (await h.api.get(`${api}/audit/verify`).set(bearer(sc.admin))).body.data;
    expect(v.valid).toBe(true);
  });

  it('embeds entity names on risk assessments and integrity alerts', async () => {
    const a = (await h.api.post(`${api}/risk/assessments`).set(bearer(sc.inv)).send({ entityType: 'patient', entityId: sc.patient.id })).body.data;
    expect(a.entityName).toBe('Pat Tester');
    const v = (await h.api.post(`${api}/risk/assessments`).set(bearer(sc.inv)).send({ entityType: 'visit', entityId: sc.visit.id })).body.data;
    expect(v.entityName).toBe('Baseline · Pat Tester');
    // trigger a duplicate-claim alert
    for (let i = 0; i < 2; i++) await h.api.post(`${api}/reimbursements`).set(bearer(sc.patientUser)).send({ visitId: sc.visit.id, category: 'meals', amountCents: 1234 });
    await h.api.post(`${api}/integrity/scans`).set(bearer(sc.inv)).send({});
    const alerts = (await h.api.get(`${api}/integrity/alerts`).set(bearer(sc.inv))).body.data;
    const dup = alerts.find((x: any) => x.ruleId === 'integrity.duplicate_reimbursement');
    expect(dup.entityName).toMatch(/Pat Tester · meals/);
    const resolved = (await h.api.patch(`${api}/integrity/alerts/${dup.id}`).set(bearer(sc.inv)).send({ status: 'resolved' })).body.data;
    expect(resolved.resolvedByName).toBe('Test investigator');
  });

  it('does not issue per-row queries: query count is constant as the page grows', async () => {
    const countFor = async () => {
      const spy = vi.spyOn(h.ctx.db, 'prepare');
      await h.api.get(`${api}/visits?pageSize=100`).set(bearer(sc.coord));
      const n = spy.mock.calls.length; spy.mockRestore(); return n;
    };
    const small = await countFor();
    for (let i = 0; i < 25; i++) sc.newVisit(`Bulk ${i}`);
    const rows = (await h.api.get(`${api}/visits?pageSize=100`).set(bearer(sc.coord))).body.data.length;
    expect(rows).toBeGreaterThan(25);
    expect(await countFor()).toBe(small);
  });
});

describe('Phase 3: visit history', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => { sc = await makeScenario(h); });

  it('is staff-only: 401 anonymous, 403 participant (even their own visit), 404 unknown visit', async () => {
    expect((await h.api.get(`${api}/visits/${sc.visit.id}/history`)).status).toBe(401);
    expect((await h.api.get(`${api}/visits/${sc.visit.id}/history`).set(bearer(sc.patientUser))).status).toBe(403);
    expect((await h.api.get(`${api}/visits/33333333-3333-4333-8333-333333333333/history`).set(bearer(sc.coord))).status).toBe(404);
    for (const u of [sc.admin, sc.coord, sc.inv]) expect((await h.api.get(`${api}/visits/${sc.visit.id}/history`).set(bearer(u))).status).toBe(200);
  });

  it('returns the lifecycle in order with actor names, edits, failed attempts and verification', async () => {
    const v = sc.newVisit('History flow', new Date(Date.now() + 864e5).toISOString());
    await h.api.patch(`${api}/visits/${v.id}`).set(bearer(sc.coord)).send({ scheduledAt: new Date(Date.now() + 2 * 864e5).toISOString(), notes: 'moved' });
    const otp = (await h.api.post(`${api}/visits/${v.id}/otp`).set(bearer(sc.coord))).body.data;
    const wrong = otp.demoOtp === '000000' ? '111111' : '000000';
    await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: wrong });
    await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: otp.demoOtp });
    await h.api.post(`${api}/visits/${v.id}/status`).set(bearer(sc.inv)).send({ status: 'completed' });

    const res = await h.api.get(`${api}/visits/${v.id}/history`).set(bearer(sc.coord));
    const actions = res.body.data.map((e: any) => e.action);
    expect(actions).toEqual(['visit.created', 'visit.updated', 'otp.issued', 'otp.verify_failed', 'otp.verified', 'visit.verified', 'visit.completed']);
    const byAction = (a: string) => res.body.data.find((e: any) => e.action === a);
    expect(byAction('visit.created').actor).toMatchObject({ name: 'Test coordinator', role: 'coordinator' });
    expect(byAction('visit.updated').scheduledAt).toMatchObject({ from: expect.any(String), to: expect.any(String) });
    expect(byAction('visit.updated').changedFields).toEqual(expect.arrayContaining(['scheduledAt', 'notes']));
    expect(byAction('otp.verify_failed')).toMatchObject({ reason: 'incorrect_code', attempt: 1, maxAttempts: 5, label: 'OTP verification failed' });
    expect(byAction('visit.completed')).toMatchObject({ from: 'verified', to: 'completed', kind: 'status' });
    expect(byAction('visit.completed').actor.name).toBe('Test investigator');
    const times = res.body.data.map((e: any) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it('never leaks hashes, raw metadata or the OTP code', async () => {
    const v = sc.newVisit('Leak check');
    const otp = (await h.api.post(`${api}/visits/${v.id}/otp`).set(bearer(sc.coord))).body.data;
    await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: otp.demoOtp });
    const text = JSON.stringify((await h.api.get(`${api}/visits/${v.id}/history`).set(bearer(sc.inv))).body);
    expect(text).not.toContain(otp.demoOtp);
    expect(text).not.toMatch(/"hash"|"prevHash"|"metadata"|codeHash|code_hash/);
  });

  it('is read-only over the audit trail: reading it adds no events and the chain stays valid', async () => {
    const before = (await h.api.get(`${api}/audit?pageSize=1`).set(bearer(sc.admin))).body.meta.total;
    for (let i = 0; i < 3; i++) await h.api.get(`${api}/visits/${sc.visit.id}/history`).set(bearer(sc.coord));
    expect((await h.api.get(`${api}/audit?pageSize=1`).set(bearer(sc.admin))).body.meta.total).toBe(before);
    expect((await h.api.get(`${api}/audit/verify`).set(bearer(sc.admin))).body.data.valid).toBe(true);
    expect((await h.api.delete(`${api}/visits/${sc.visit.id}/history`).set(bearer(sc.admin))).status).toBe(404); // no mutation surface
  });
});

describe('Phase 3: dashboard statistics', () => {
  const h = makeHarness();
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeAll(async () => {
    sc = await makeScenario(h);
    const day = 864e5;
    sc.newVisit('Soon', new Date(Date.now() + 2 * day).toISOString());
    sc.newVisit('Later', new Date(Date.now() + 20 * day).toISOString());
    const past = sc.newVisit('Past due', new Date(Date.now() - 3 * day).toISOString());
    const missed = sc.newVisit('Missed', new Date(Date.now() - 5 * day).toISOString());
    h.s.visits.changeStatus(missed.id, 'missed', undefined, sc.coord.actor);
    void past;
    h.s.actions.create({ title: 'Overdue one', priority: 'high', dueDate: new Date(Date.now() - day).toISOString(), assigneeId: sc.inv.id }, sc.coord.actor);
    h.s.actions.create({ title: 'Future one', priority: 'medium', dueDate: new Date(Date.now() + day).toISOString() }, sc.coord.actor);
    const mk = (cat: 'travel' | 'meals', amountCents: number, currency = 'USD') =>
      h.s.reimbursements.create({ visitId: sc.visit.id, category: cat, amountCents, currency, description: `${cat}${amountCents}` }, sc.coord.actor);
    const r1 = mk('travel', 10_000); mk('meals', 2_500); mk('travel', 4_000, 'EUR');
    h.s.reimbursements.approve(r1.id, undefined, sc.inv.actor);
  });

  it('enforces roles: staff for operations/visits/reimbursements, admin+investigator for sponsor, never participants', async () => {
    for (const path of ['operations', 'visits', 'reimbursements', 'sponsor']) {
      expect((await h.api.get(`${api}/stats/${path}`)).status, path).toBe(401);
      expect((await h.api.get(`${api}/stats/${path}`).set(bearer(sc.patientUser))).status, path).toBe(403);
    }
    for (const path of ['operations', 'visits', 'reimbursements']) for (const u of [sc.admin, sc.coord, sc.inv]) expect((await h.api.get(`${api}/stats/${path}`).set(bearer(u))).status).toBe(200);
    expect((await h.api.get(`${api}/stats/sponsor`).set(bearer(sc.coord))).status).toBe(403);
    for (const u of [sc.admin, sc.inv]) expect((await h.api.get(`${api}/stats/sponsor`).set(bearer(u))).status).toBe(200);
  });

  it('operations: counts match the database and statuses are zero-filled', async () => {
    const d = (await h.api.get(`${api}/stats/operations`).set(bearer(sc.coord))).body.data;
    const count = (sql: string, ...p: unknown[]) => (h.ctx.db.prepare(sql).get(...p) as { c: number }).c;
    expect(d.patients.total).toBe(count('SELECT COUNT(*) c FROM patients WHERE deleted_at IS NULL'));
    expect(d.patients.byStatus).toEqual({ active: 1, withdrawn: 0, inactive: 0 });
    expect(d.trials.byStatus.active).toBe(1);
    expect(d.trials.byStatus.terminated).toBe(0);
    expect(d.enrollments.byStatus.enrolled).toBe(1);
    expect(d.visits.total).toBe(count('SELECT COUNT(*) c FROM visits'));
    expect(d.visits.byStatus).toMatchObject({ scheduled: 4, missed: 1, completed: 0, otp_pending: 0 });
    expect(d.visits.pastDueUnverified).toBe(2); // baseline (created "now" -> already past) + Past due
    expect(d.actions.overdue).toBe(1);
    expect(d.actions.byStatus.pending).toBe(2);
    expect(d.reimbursements.byStatus).toEqual({ pending: 2, approved: 1, rejected: 0, cancelled: 0 });
    expect(d.reimbursements.total).toBe(3);
  });

  it('operations aggregates are consistent with the list endpoints it replaces', async () => {
    const d = (await h.api.get(`${api}/stats/operations`).set(bearer(sc.admin))).body.data;
    expect(d.actions.overdue).toBe((await h.api.get(`${api}/actions?status=overdue`).set(bearer(sc.admin))).body.meta.total);
    expect(d.visits.byStatus.scheduled).toBe((await h.api.get(`${api}/visits?status=scheduled`).set(bearer(sc.admin))).body.meta.total);
    expect(d.reimbursements.byStatus.pending).toBe((await h.api.get(`${api}/reimbursements?status=pending`).set(bearer(sc.admin))).body.meta.total);
    expect(d.patients.total).toBe((await h.api.get(`${api}/patients`).set(bearer(sc.admin))).body.meta.total);
  });

  it('visits: upcoming list is ordered, excludes past/closed visits, and embeds names', async () => {
    const d = (await h.api.get(`${api}/stats/visits?limit=5&windowDays=7`).set(bearer(sc.coord))).body.data;
    expect(d.upcoming.map((v: any) => v.visitType)).toEqual(['Soon', 'Later']);
    expect(d.upcoming[0]).toMatchObject({ patientName: 'Pat Tester', trialCode: sc.trial.code, siteName: 'Site One', status: 'scheduled' });
    expect(d.upcomingInWindow).toBe(1);
    expect((await h.api.get(`${api}/stats/visits?windowDays=30`).set(bearer(sc.coord))).body.data.upcomingInWindow).toBe(2);
    expect((await h.api.get(`${api}/stats/visits?limit=1`).set(bearer(sc.coord))).body.data.upcoming).toHaveLength(1);
    expect((await h.api.get(`${api}/stats/visits?limit=0`).set(bearer(sc.coord))).status).toBe(400);
    expect(d.byStatus.missed).toBe(1);
  });

  it('reimbursements: counts by status and amounts grouped per currency, never mixed', async () => {
    const d = (await h.api.get(`${api}/stats/reimbursements`).set(bearer(sc.inv))).body.data;
    expect(d.byStatus).toEqual({ pending: 2, approved: 1, rejected: 0, cancelled: 0 });
    expect(d.byPaymentStatus).toMatchObject({ unpaid: 1, none: 2 });
    const usd = d.totals.find((t: any) => t.currency === 'USD');
    const eur = d.totals.find((t: any) => t.currency === 'EUR');
    expect(usd).toMatchObject({ count: 2, amountCents: 12_500, pendingAmountCents: 2_500, approvedAmountCents: 10_000, paidAmountCents: 0 });
    expect(eur).toMatchObject({ count: 1, amountCents: 4_000, pendingAmountCents: 4_000 });
    expect(d.byCategory.find((c: any) => c.category === 'travel' && c.currency === 'USD')).toMatchObject({ count: 1, amountCents: 10_000 });
    expect(d.oldestPendingAt).toEqual(expect.any(String));
  });

  it('sponsor: risk uses the latest assessment per entity; integrity and audit sections are real counts', async () => {
    const assess = (type: 'patient' | 'visit', id: string) => h.s.risk.assess({ entityType: type, entityId: id }, sc.inv.actor);
    await assess('patient', sc.patient.id);
    await assess('patient', sc.patient.id); // a second assessment of the same patient must not double count
    await assess('visit', sc.visit.id);
    const d = (await h.api.get(`${api}/stats/sponsor?topRisks=3`).set(bearer(sc.inv))).body.data;
    const stored = (h.ctx.db.prepare('SELECT COUNT(*) c FROM risk_assessments').get() as { c: number }).c;
    expect(d.risk.storedAssessments).toBe(stored);
    expect(d.risk.assessedEntities).toBe(2);
    expect(d.risk.byEntityType.patient.low + d.risk.byEntityType.patient.medium + d.risk.byEntityType.patient.high + d.risk.byEntityType.patient.critical).toBe(1);
    expect(d.risk.basis).toBe('latest assessment per entity');
    expect(d.risk.top.length).toBeLessThanOrEqual(2);
    expect(d.risk.top[0].entityName).toEqual(expect.any(String));
    expect(d.integrity.byStatus).toMatchObject({ open: 0, resolved: 0 });
    expect(d.trials.byStatus.active).toBe(1);
    const auditTotal = (h.ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
    expect(d.audit.totalEvents).toBe(auditTotal);
    expect(d.audit.headSeq).toBe(auditTotal);
    expect((await h.api.get(`${api}/stats/sponsor?topRisks=0`).set(bearer(sc.inv))).body.data.risk.top).toEqual([]);
  });

  it('sponsor: counts open alerts by severity after a scan, matching the alert list', async () => {
    await h.api.post(`${api}/reimbursements`).set(bearer(sc.patientUser)).send({ visitId: sc.visit.id, category: 'parking', amountCents: 999 });
    await h.api.post(`${api}/reimbursements`).set(bearer(sc.patientUser)).send({ visitId: sc.visit.id, category: 'parking', amountCents: 999 });
    await h.api.post(`${api}/integrity/scans`).set(bearer(sc.inv)).send({});
    const d = (await h.api.get(`${api}/stats/sponsor`).set(bearer(sc.admin))).body.data;
    const open = (await h.api.get(`${api}/integrity/alerts?status=open`).set(bearer(sc.admin))).body.meta.total;
    expect(d.integrity.open).toBe(open);
    expect(open).toBeGreaterThan(0);
    for (const sev of ['low', 'medium', 'high', 'critical']) {
      expect(d.integrity.openBySeverity[sev]).toBe((await h.api.get(`${api}/integrity/alerts?status=open&severity=${sev}`).set(bearer(sc.admin))).body.meta.total);
    }
  });

  it('uses a constant number of queries regardless of data size', async () => {
    const countFor = async (path: string) => {
      const spy = vi.spyOn(h.ctx.db, 'prepare');
      await h.api.get(`${api}/stats/${path}`).set(bearer(sc.admin));
      const n = spy.mock.calls.length; spy.mockRestore(); return n;
    };
    const before = { ops: await countFor('operations'), rb: await countFor('reimbursements') };
    for (let i = 0; i < 30; i++) sc.newVisit(`More ${i}`);
    expect(await countFor('operations')).toBe(before.ops);
    expect(await countFor('reimbursements')).toBe(before.rb);
  });
});
