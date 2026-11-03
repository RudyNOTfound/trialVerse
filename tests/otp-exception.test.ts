import { describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario } from './helpers';

const api = '/api/v1';
const exception = { reasonCode: 'device_offline', note: 'Tablet had no signal; the OTP SMS never arrived.' };

describe('completing a visit without OTP verification (explicit integrity exception)', () => {
  const h = makeHarness();
  const complete = (id: string, user: { token: string }, body: object) => h.api.post(`${api}/visits/${id}/status`).set(bearer(user)).send({ status: 'completed', ...body });

  it('lets an investigator complete an unverified visit, records the exception, and NEVER marks it verified', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Exception visit');
    await h.api.post(`${api}/visits/${v.id}/otp`).set(bearer(sc.coord)); // a live OTP exists
    const res = await complete(v.id, sc.inv, { otpException: exception });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'completed', otpVerified: false, verifiedAt: null, verifiedBy: null });
    expect(res.body.data.otpException).toMatchObject({ reasonCode: 'device_offline', recordedBy: sc.inv.id, recordedByName: 'Test investigator', note: exception.note });
    // database truth
    const row = h.ctx.db.prepare('SELECT status, verified_at, completed_at FROM visits WHERE id = ?').get(v.id) as any;
    expect(row).toMatchObject({ status: 'completed', verified_at: null });
    expect(row.completed_at).toEqual(expect.any(String));
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM visit_otp_exceptions WHERE visit_id = ?').get(v.id)).toEqual({ c: 1 });
    // the live OTP can no longer be used to "verify" the closed visit
    expect((h.ctx.db.prepare(`SELECT COUNT(*) c FROM otp_records WHERE visit_id = ? AND status = 'active'`).get(v.id) as any).c).toBe(0);
    const late = await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: '123456' });
    expect(late.status).toBe(409);
    expect((await h.api.get(`${api}/visits/${v.id}`).set(bearer(sc.inv))).body.data.otpVerified).toBe(false);
  });

  it('audits it as visit.completed_without_otp with the reason code but without the free-text note', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Audit visit');
    await complete(v.id, sc.admin, { otpException: exception });
    const ev = (await h.api.get(`${api}/audit?action=visit.completed_without_otp&entityId=${v.id}`).set(bearer(sc.admin))).body.data;
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({ from: 'scheduled', to: 'completed', reasonCode: 'device_offline', patientId: sc.patient.id });
    expect(JSON.stringify(ev[0])).not.toContain('no signal');
    expect(JSON.stringify(ev[0])).not.toContain('SMS');
    expect((await h.api.get(`${api}/audit/verify`).set(bearer(sc.admin))).body.data.valid).toBe(true);
    const hist = (await h.api.get(`${api}/visits/${v.id}/history`).set(bearer(sc.coord))).body.data.map((e: any) => e.action);
    expect(hist).toContain('visit.completed_without_otp');
  });

  it('works from otp_pending too', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Pending visit');
    h.ctx.db.prepare(`UPDATE visits SET status = 'otp_pending' WHERE id = ?`).run(v.id);
    expect((await complete(v.id, sc.inv, { otpException: { reasonCode: 'other', note: 'n' } })).status).toBe(200);
  });

  it('keeps the existing 409 without an exception, and the normal verified path is unchanged', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Normal visit');
    const blocked = await complete(v.id, sc.inv, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const otp = (await h.api.post(`${api}/visits/${v.id}/otp`).set(bearer(sc.coord))).body.data;
    expect((await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: otp.demoOtp })).status).toBe(200);
    const done = await complete(v.id, sc.inv, {});
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', otpVerified: true, otpException: null });
    expect(done.body.data.verifiedAt).toEqual(expect.any(String));
  });

  it('is investigator/admin only: coordinators, participants and anonymous callers are refused', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Authz visit');
    expect((await complete(v.id, sc.coord, { otpException: exception })).status).toBe(403);
    expect((await complete(v.id, sc.patientUser, { otpException: exception })).status).toBe(403);
    expect((await h.api.post(`${api}/visits/${v.id}/status`).send({ status: 'completed', otpException: exception })).status).toBe(401);
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM visit_otp_exceptions WHERE visit_id = ?').get(v.id)).toEqual({ c: 0 });
    expect((await h.api.get(`${api}/visits/${v.id}`).set(bearer(sc.inv))).body.data.status).toBe('scheduled');
  });

  it('rejects an exception where it cannot apply (422) and malformed ones (400)', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Invalid visit');
    const missed = await h.api.post(`${api}/visits/${v.id}/status`).set(bearer(sc.inv)).send({ status: 'missed', otpException: exception });
    expect(missed.status).toBe(422);
    expect(missed.body.error.code).toBe('OTP_EXCEPTION_NOT_APPLICABLE');
    // a verified visit must go through the normal path
    const otp = (await h.api.post(`${api}/visits/${v.id}/otp`).set(bearer(sc.coord))).body.data;
    await h.api.post(`${api}/visits/${v.id}/otp/verify`).set(bearer(sc.patientUser)).send({ code: otp.demoOtp });
    expect((await complete(v.id, sc.inv, { otpException: exception })).body.error.code).toBe('OTP_EXCEPTION_NOT_APPLICABLE');
    const w = sc.newVisit('Malformed');
    expect((await complete(w.id, sc.inv, { otpException: { reasonCode: 'because', note: 'x' } })).status).toBe(400);
    expect((await complete(w.id, sc.inv, { otpException: { reasonCode: 'other', note: '' } })).status).toBe(400);
    expect((await complete(w.id, sc.inv, { otpException: { reasonCode: 'other', note: 'x'.repeat(501) } })).status).toBe(400);
    expect((await complete(w.id, sc.inv, { otpException: { reasonCode: 'other' } })).status).toBe(400);
  });

  it('cannot be applied twice to the same visit', async () => {
    const sc = await makeScenario(h);
    const v = sc.newVisit('Twice');
    expect((await complete(v.id, sc.inv, { otpException: exception })).status).toBe(200);
    expect((await complete(v.id, sc.inv, { otpException: exception })).status).toBe(422);
  });

  it('shows participants and coordinators the reason code but not the free-text note', async () => {
    const sc = await makeScenario(h);
    const v = sc.visit;
    await complete(v.id, sc.inv, { otpException: exception });
    for (const viewer of [sc.patientUser, sc.coord]) {
      const one = (await h.api.get(`${api}/visits/${v.id}`).set(bearer(viewer))).body.data;
      expect(one.otpException).toMatchObject({ reasonCode: 'device_offline' });
      expect(one.otpException.note).toBeUndefined();
      const listed = (await h.api.get(`${api}/visits?pageSize=50`).set(bearer(viewer))).body.data.find((x: any) => x.id === v.id);
      expect(listed.otpException.note).toBeUndefined();
    }
    for (const viewer of [sc.inv, sc.admin]) expect((await h.api.get(`${api}/visits/${v.id}`).set(bearer(viewer))).body.data.otpException.note).toBe(exception.note);
  });
});
