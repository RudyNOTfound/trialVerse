/**
 * Capture APIs for the ML inputs: measurements, ECG references, reminders, adverse events (src/modules/capture).
 * Real Express app + real SQLite via supertest. The two tests that look at the ML payloads use in-process RECORDING stand-ins for the
 * Python models, so they prove what the backend would SEND; they are not live TypeScript -> Python tests
 * (those are in tests/live/ml-live.test.ts and need the service running).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION, type IntegrityModel, type IntegrityScanRequest, type RiskModel, type RiskPredictionRequest,
} from '../src/ml/contracts';
import { buildTrialData } from '../src/modules/integrity/trialData';
import { buildFeatures } from '../src/modules/risk/features';
import { bearer, makeHarness, makeScenario, makeUser, type Harness, type TestUser } from './helpers';

const api = '/api/v1';
type Scenario = Awaited<ReturnType<typeof makeScenario>>;
const NOW = () => new Date().toISOString();
const PAST = (h = 1) => new Date(Date.now() - h * 3600_000).toISOString();
const V = { systolicBp: 128, diastolicBp: 82, heartRate: 71, weightKg: 70.5, glucoseMgDl: 104 };

function setup() {
  const h = makeHarness();
  const post = (u: string, who: TestUser | null, body: unknown) => { const r = h.api.post(`${api}${u}`); return (who ? r.set(bearer(who)) : r).send(body as object); };
  const patch = (u: string, who: TestUser | null, body: unknown) => { const r = h.api.patch(`${api}${u}`); return (who ? r.set(bearer(who)) : r).send(body as object); };
  const get = (u: string, who: TestUser | null) => { const r = h.api.get(`${api}${u}`); return who ? r.set(bearer(who)) : r; };
  const audit = (action: string) => h.ctx.db.prepare('SELECT entity_id, metadata, actor_id FROM audit_logs WHERE action = ? ORDER BY seq').all(action) as Array<{ entity_id: string; metadata: string; actor_id: string }>;
  return { h, post, patch, get, audit };
}
const ids = (sc: Scenario) => ({ pid: sc.patient.id, vid: sc.visit.id, eid: sc.enrollment.id });

describe('capture APIs: measurements', () => {
  const { h, post, get, audit } = setup();
  let sc: Scenario, other: Scenario;
  const boot = async () => { sc ??= await makeScenario(h); other ??= await makeScenario(h); };

  it('records a measurement set: persisted, server-stamped, audited without the values', async () => {
    await boot(); const { pid, vid } = ids(sc);
    const res = await post(`/patients/${pid}/measurements`, sc.coord, { visitId: vid, performedAt: PAST(), ...V });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: vid, visitId: vid, patientId: pid, trialId: sc.trial.id, enteredBy: sc.coord.id, ...V });
    expect(Date.now() - Date.parse(res.body.data.enteredAt)).toBeLessThan(10_000);      // stamped by the server, not the client
    const row = h.ctx.db.prepare('SELECT * FROM visit_measurements WHERE visit_id = ?').get(vid) as Record<string, unknown>;
    expect(row).toMatchObject({ systolic_bp: 128, glucose_mg_dl: 104, entered_by: sc.coord.id });
    const ev = audit('measurement.recorded').find((e) => e.entity_id === vid)!;
    expect(JSON.parse(ev.metadata)).toMatchObject({ patientId: pid, visitId: vid, fields: ['systolicBp', 'diastolicBp', 'heartRate', 'weightKg', 'glucoseMgDl'] });
    expect(ev.metadata).not.toMatch(/128|104|70\.5/);                                   // clinical values never enter the audit chain
    expect(get(`/measurements/${vid}`, sc.inv)).toBeTruthy();
    expect((await get(`/measurements/${vid}`, sc.inv)).body.data).toMatchObject({ id: vid, systolicBp: 128 });
    const list = await get(`/patients/${pid}/measurements`, sc.admin);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ total: 1 });
  });

  it('accepts a partial set and an implausible value (flagging it is the integrity engine\'s job), rejects a duplicate set', async () => {
    const s = await makeScenario(h);
    const r = await post(`/patients/${s.patient.id}/measurements`, s.inv, { visitId: s.visit.id, performedAt: PAST(), systolicBp: 300 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ systolicBp: 300, diastolicBp: null, heartRate: null });
    const dup = await post(`/patients/${s.patient.id}/measurements`, s.inv, { visitId: s.visit.id, performedAt: PAST(), heartRate: 60 });
    expect(dup.status).toBe(409);
  });

  it('validates the request: UUIDs, numbers, timestamps, unknown fields', async () => {
    await boot(); const { pid } = ids(sc);
    const s2 = await makeScenario(h); const ok = { visitId: s2.visit.id, performedAt: PAST(), heartRate: 60 };
    expect((await post(`/patients/not-a-uuid/measurements`, sc.coord, ok)).status).toBe(400);
    for (const bad of [
      { ...ok, visitId: 'nope' }, { ...ok, visitId: undefined }, { ...ok, performedAt: undefined }, { ...ok, performedAt: '2026-01-01T10:00:00' },
      { ...ok, heartRate: 0 }, { ...ok, heartRate: -5 }, { ...ok, heartRate: '60' }, { ...ok, systolicBp: null },
      { visitId: s2.visit.id, performedAt: PAST() },                                    // no value at all
      { ...ok, enteredAt: PAST() }, { ...ok, enteredBy: sc.admin.id }, { ...ok, unit: 'lb' },   // not client-settable / no invented fields
    ]) {
      const res = await post(`/patients/${pid}/measurements`, sc.coord, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get(`/patients/${pid}/measurements?pageSize=1000`, sc.coord)).status).toBe(400);
    expect((await get(`/measurements/not-a-uuid`, sc.coord)).status).toBe(400);
  });

  it('404 for a patient / visit / measurement that does not exist or is not this patient\'s; 409 for a visit that did not happen', async () => {
    await boot();
    const body = { visitId: other.visit.id, performedAt: PAST(), heartRate: 60 };
    expect((await post(`/patients/${randomUUID()}/measurements`, sc.coord, body)).status).toBe(404);
    expect((await post(`/patients/${sc.patient.id}/measurements`, sc.coord, body)).status).toBe(404);          // someone else's visit
    expect((await post(`/patients/${sc.patient.id}/measurements`, sc.coord, { ...body, visitId: randomUUID() })).status).toBe(404);
    expect((await get(`/measurements/${randomUUID()}`, sc.coord)).status).toBe(404);
    const s = await makeScenario(h);
    h.s.visits.changeStatus(s.visit.id, 'cancelled', undefined, s.coord.actor);
    expect((await post(`/patients/${s.patient.id}/measurements`, s.coord, { visitId: s.visit.id, performedAt: PAST(), heartRate: 60 })).status).toBe(409);
  });

  it('authentication and roles: 401 without a token, participants cannot record; coordinator, investigator and admin can', async () => {
    await boot(); const s = await makeScenario(h);
    const body = (v: string) => ({ visitId: v, performedAt: PAST(), heartRate: 60 });
    expect((await post(`/patients/${s.patient.id}/measurements`, null, body(s.visit.id))).status).toBe(401);
    expect((await post(`/patients/${s.patient.id}/measurements`, s.patientUser, body(s.visit.id))).status).toBe(403);   // not even for themselves
    expect((await get(`/patients/${s.patient.id}/measurements`, null)).status).toBe(401);
    expect((await get(`/measurements/${s.visit.id}`, null)).status).toBe(401);
    for (const who of [s.coord, s.inv, s.admin]) {
      const t = await makeScenario(h);
      expect((await post(`/patients/${t.patient.id}/measurements`, who, body(t.visit.id))).status, who.role).toBe(201);
    }
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM visit_measurements WHERE visit_id = ?').get(s.visit.id)).toEqual({ c: 0 });
  });

  it('participant isolation: own records only, by list and by id; never somebody else\'s', async () => {
    await boot();
    const mine = await post(`/patients/${other.patient.id}/measurements`, other.coord, { visitId: other.visit.id, performedAt: PAST(), heartRate: 66 });
    expect(mine.status).toBe(201);
    expect((await get(`/patients/${other.patient.id}/measurements`, other.patientUser)).body.data).toHaveLength(1);
    expect((await get(`/measurements/${other.visit.id}`, other.patientUser)).status).toBe(200);
    // sc's participant tries to read other's data by changing the URL
    expect((await get(`/patients/${other.patient.id}/measurements`, sc.patientUser)).status).toBe(403);
    expect((await get(`/measurements/${other.visit.id}`, sc.patientUser)).status).toBe(404);
    expect((await get(`/patients/${randomUUID()}/measurements`, sc.patientUser)).status).toBe(403);   // no way to tell "missing" from "not yours"
  });
});

describe('capture APIs: ECG references', () => {
  const { h, post, get, audit } = setup();
  const SHA = 'a'.repeat(64);

  it('registers a reference (not bytes): persisted with its metadata, audited, readable by staff', async () => {
    const s = await makeScenario(h); const { pid, vid } = ids(s);
    const res = await post(`/patients/${pid}/ecgs`, s.coord, { visitId: vid, fileRef: 'ecgs/ecg_001.png', fileSha256: SHA, recordedAt: PAST() });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ visitId: vid, patientId: pid, trialId: s.trial.id, fileRef: 'ecgs/ecg_001.png', fileSha256: SHA, createdBy: s.coord.id });
    expect(h.ctx.db.prepare('SELECT file_ref, file_sha256 FROM visit_ecgs WHERE id = ?').get(res.body.data.id)).toEqual({ file_ref: 'ecgs/ecg_001.png', file_sha256: SHA });
    expect(JSON.parse(audit('ecg.registered').find((e) => e.entity_id === res.body.data.id)!.metadata)).toMatchObject({ patientId: pid, visitId: vid, hasSha256: true });
    expect((await get(`/ecgs/${res.body.data.id}`, s.inv)).body.data.fileRef).toBe('ecgs/ecg_001.png');
    expect((await get(`/patients/${pid}/ecgs?visitId=${vid}`, s.admin)).body.data).toHaveLength(1);
    const minimal = await makeScenario(h);
    expect((await post(`/patients/${minimal.patient.id}/ecgs`, minimal.coord, { visitId: minimal.visit.id, fileRef: 'a/b.png' })).body.data).toMatchObject({ fileSha256: null, recordedAt: null });
  });

  it('validates the reference: relative path only, no traversal, no invented fields', async () => {
    const s = await makeScenario(h); const { pid, vid } = ids(s);
    for (const bad of [
      { visitId: vid, fileRef: '/etc/passwd' }, { visitId: vid, fileRef: '../../etc/passwd' }, { visitId: vid, fileRef: 'ecgs/../../x.png' }, { visitId: vid, fileRef: 'C:\\x.png' },
      { visitId: vid, fileRef: 'ecgs\\x.png' }, { visitId: vid, fileRef: '' }, { visitId: vid, fileRef: 'a//b.png' }, { visitId: vid, fileRef: 'x'.repeat(501) }, { visitId: vid },
      { visitId: vid, fileRef: 'ok.png', fileSha256: 'abc' }, { visitId: vid, fileRef: 'ok.png', fileSha256: 'A'.repeat(64) }, { visitId: vid, fileRef: 'ok.png', recordedAt: 'yesterday' },
      { visitId: 'nope', fileRef: 'ok.png' }, { visitId: vid, fileRef: 'ok.png', imageBase64: 'AAAA' },                  // no binary-storage mechanism is invented
    ]) {
      const res = await post(`/patients/${pid}/ecgs`, s.coord, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect((await post(`/patients/nope/ecgs`, s.coord, { visitId: vid, fileRef: 'ok.png' })).status).toBe(400);
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM visit_ecgs WHERE visit_id = ?').get(vid)).toEqual({ c: 0 });
  });

  it('404 for unknown patient / foreign visit, 409 for a second ECG on a visit or on a cancelled visit', async () => {
    const a = await makeScenario(h); const b = await makeScenario(h);
    expect((await post(`/patients/${randomUUID()}/ecgs`, a.coord, { visitId: a.visit.id, fileRef: 'x.png' })).status).toBe(404);
    expect((await post(`/patients/${a.patient.id}/ecgs`, a.coord, { visitId: b.visit.id, fileRef: 'x.png' })).status).toBe(404);
    expect((await post(`/patients/${a.patient.id}/ecgs`, a.coord, { visitId: a.visit.id, fileRef: 'x.png' })).status).toBe(201);
    expect((await post(`/patients/${a.patient.id}/ecgs`, a.coord, { visitId: a.visit.id, fileRef: 'y.png' })).status).toBe(409);
    h.s.visits.changeStatus(b.visit.id, 'missed', undefined, b.coord.actor);
    expect((await post(`/patients/${b.patient.id}/ecgs`, b.coord, { visitId: b.visit.id, fileRef: 'x.png' })).status).toBe(409);
  });

  it('authentication and roles; participants may read their own record but never see the storage path', async () => {
    const s = await makeScenario(h); const o = await makeScenario(h);
    const body = { visitId: s.visit.id, fileRef: 'ecgs/own.png', fileSha256: SHA };
    expect((await post(`/patients/${s.patient.id}/ecgs`, null, body)).status).toBe(401);
    expect((await post(`/patients/${s.patient.id}/ecgs`, s.patientUser, body)).status).toBe(403);
    const created = await post(`/patients/${s.patient.id}/ecgs`, s.inv, body);
    expect(created.status).toBe(201);
    const own = await get(`/ecgs/${created.body.data.id}`, s.patientUser);
    expect(own.status).toBe(200);
    expect(own.body.data).not.toHaveProperty('fileRef');
    expect(own.body.data).not.toHaveProperty('fileSha256');
    expect((await get(`/patients/${s.patient.id}/ecgs`, s.patientUser)).body.data[0]).not.toHaveProperty('fileRef');
    // isolation
    expect((await get(`/ecgs/${created.body.data.id}`, o.patientUser)).status).toBe(404);
    expect((await get(`/patients/${s.patient.id}/ecgs`, o.patientUser)).status).toBe(403);
    expect((await get(`/ecgs/${created.body.data.id}`, null)).status).toBe(401);
  });

  it('a file that other records already use is accepted (re-use is what the integrity engine detects) and reaches trialData unchanged', async () => {
    const a = await makeScenario(h); const b = await makeScenario(h);
    const ra = await post(`/patients/${a.patient.id}/ecgs`, a.coord, { visitId: a.visit.id, fileRef: 'ecgs/shared.png' });
    const rb = await post(`/patients/${b.patient.id}/ecgs`, b.coord, { visitId: b.visit.id, fileRef: 'ecgs/shared.png' });
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ra.body.data.id).not.toBe(rb.body.data.id);
    h.ctx.db.prepare('UPDATE trial_sites SET timezone = ?, ml_site_category = ? WHERE id = ?').run('Asia/Kolkata', 'SITE-A', a.site.id);
    const td = buildTrialData(h.ctx.db, a.trial.id, new Date()).trialData!;
    expect(td.ecgs).toEqual([expect.objectContaining({ ecgRecordId: ra.body.data.id, visitId: a.visit.id, participantId: a.patient.id, imageRef: 'ecgs/shared.png' })]);
  });
});

describe('capture APIs: reminders', () => {
  const { h, post, patch, get, audit } = setup();

  it('logs a reminder (sent), then resolves it once; every step is audited', async () => {
    const s = await makeScenario(h); const { pid, eid, vid } = ids(s);
    const created = await post(`/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'sms', sentAt: PAST(5) });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ enrollmentId: eid, patientId: pid, trialId: s.trial.id, visitId: null, channel: 'sms', outcome: 'sent', acknowledgedAt: null, outcomeRecordedAt: null });
    const id = created.body.data.id as string;
    expect(JSON.parse(audit('reminder.created').find((e) => e.entity_id === id)!.metadata)).toMatchObject({ patientId: pid, enrollmentId: eid, channel: 'sms' });

    const acked = await patch(`/reminders/${id}`, s.coord, { outcome: 'acknowledged', acknowledgedAt: PAST(4) });
    expect(acked.status).toBe(200);
    expect(acked.body.data).toMatchObject({ outcome: 'acknowledged', recordedBy: s.coord.id });
    expect(acked.body.data.acknowledgedAt).toBeTruthy();
    expect(acked.body.data.outcomeRecordedAt).toBeTruthy();
    expect(JSON.parse(audit('reminder.outcome_recorded').find((e) => e.entity_id === id)!.metadata)).toMatchObject({ from: 'sent', to: 'acknowledged', patientId: pid });

    // a visit determines its enrollment; 'missed' needs no acknowledgedAt
    const viaVisit = await post(`/patients/${pid}/reminders`, s.admin, { visitId: vid, channel: 'call', sentAt: PAST(2) });
    expect(viaVisit.body.data).toMatchObject({ enrollmentId: eid, visitId: vid });
    expect((await patch(`/reminders/${viaVisit.body.data.id}`, s.admin, { outcome: 'missed' })).body.data).toMatchObject({ outcome: 'missed', acknowledgedAt: null });

    expect((await get(`/reminders/${id}`, s.inv)).body.data.outcome).toBe('acknowledged');
    const list = await get(`/patients/${pid}/reminders?outcome=missed`, s.coord);
    expect(list.body.data).toHaveLength(1);
    expect((await get(`/patients/${pid}/reminders`, s.coord)).body.meta.total).toBe(2);
  });

  it('validates fields; no invented channels or statuses', async () => {
    const s = await makeScenario(h); const { pid, eid } = ids(s);
    const ok = { enrollmentId: eid, channel: 'sms', sentAt: PAST() };
    for (const bad of [
      { ...ok, channel: 'pigeon' }, { ...ok, channel: undefined }, { ...ok, sentAt: undefined }, { ...ok, sentAt: '2026-01-01' }, { channel: 'sms', sentAt: PAST() },
      { ...ok, enrollmentId: 'nope' }, { ...ok, outcome: 'missed' }, { ...ok, status: 'sent' }, { ...ok, scheduledAt: PAST() },
    ]) expect((await post(`/patients/${pid}/reminders`, s.coord, bad)).status, JSON.stringify(bad)).toBe(400);
    const r = (await post(`/patients/${pid}/reminders`, s.coord, ok)).body.data.id;
    for (const bad of [{}, { outcome: 'sent' }, { outcome: 'cancelled' }, { outcome: 'missed', acknowledgedAt: PAST() }, { outcome: 'acknowledged', acknowledgedAt: 'x' }, { outcome: 'missed', channel: 'sms' }]) {
      expect((await patch(`/reminders/${r}`, s.coord, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(`/reminders/nope`, s.coord, { outcome: 'missed' })).status).toBe(400);
    expect((await patch(`/reminders/${randomUUID()}`, s.coord, { outcome: 'missed' })).status).toBe(404);
  });

  it('lifecycle: a resolved reminder is final; acknowledgement cannot predate the send or lie in the future', async () => {
    const s = await makeScenario(h); const { pid, eid } = ids(s);
    const mk = async (sentAt = PAST(3)) => (await post(`/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'ivr', sentAt })).body.data.id as string;
    const a = await mk();
    expect((await patch(`/reminders/${a}`, s.coord, { outcome: 'acknowledged', acknowledgedAt: PAST(10) })).status).toBe(400);               // before it was sent
    expect((await patch(`/reminders/${a}`, s.coord, { outcome: 'acknowledged', acknowledgedAt: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(400);
    expect((await get(`/reminders/${a}`, s.coord)).body.data.outcome).toBe('sent');                                                         // failed attempts changed nothing
    expect((await patch(`/reminders/${a}`, s.coord, { outcome: 'missed' })).status).toBe(200);
    for (const outcome of ['missed', 'acknowledged'] as const) {
      const again = await patch(`/reminders/${a}`, s.coord, { outcome });
      expect(again.status, outcome).toBe(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    }
    const b = await mk();
    await patch(`/reminders/${b}`, s.coord, { outcome: 'acknowledged' });
    expect((await patch(`/reminders/${b}`, s.coord, { outcome: 'missed' })).status).toBe(409);
    expect(audit('reminder.outcome_recorded').filter((e) => e.entity_id === a)).toHaveLength(1);       // only the successful change is audited
  });

  it('authentication, roles and isolation; the target must belong to the patient', async () => {
    const s = await makeScenario(h); const o = await makeScenario(h);
    const body = { enrollmentId: s.enrollment.id, channel: 'sms', sentAt: PAST() };
    expect((await post(`/patients/${s.patient.id}/reminders`, null, body)).status).toBe(401);
    expect((await post(`/patients/${s.patient.id}/reminders`, s.patientUser, body)).status).toBe(403);
    expect((await post(`/patients/${s.patient.id}/reminders`, s.inv, body)).status).toBe(403);          // operations roles only
    expect((await post(`/patients/${randomUUID()}/reminders`, s.coord, body)).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/reminders`, s.coord, { ...body, enrollmentId: o.enrollment.id })).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/reminders`, s.coord, { channel: 'sms', sentAt: PAST(), visitId: o.visit.id })).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/reminders`, s.coord, { channel: 'sms', sentAt: PAST(), visitId: s.visit.id, enrollmentId: o.enrollment.id })).status).toBe(400);
    const id = (await post(`/patients/${s.patient.id}/reminders`, s.coord, body)).body.data.id as string;
    expect((await patch(`/reminders/${id}`, null, { outcome: 'missed' })).status).toBe(401);
    expect((await patch(`/reminders/${id}`, s.patientUser, { outcome: 'acknowledged' })).status).toBe(403);   // a participant cannot lower their own risk
    expect((await patch(`/reminders/${id}`, s.inv, { outcome: 'missed' })).status).toBe(403);
    expect((await get(`/reminders/${id}`, s.patientUser)).status).toBe(200);
    expect((await get(`/reminders/${id}`, o.patientUser)).status).toBe(404);
    expect((await get(`/patients/${s.patient.id}/reminders`, o.patientUser)).status).toBe(403);
    expect((await get(`/patients/${s.patient.id}/reminders`, null)).status).toBe(401);
  });
});

describe('capture APIs: adverse events', () => {
  const { h, post, patch, get, audit } = setup();

  it('staff and the participant themselves can report; stored, audited, listed', async () => {
    const s = await makeScenario(h); const { pid, eid, vid } = ids(s);
    const byStaff = await post(`/patients/${pid}/adverse-events`, s.inv, { enrollmentId: eid, reportedAt: PAST(3) });
    expect(byStaff.status).toBe(201);
    expect(byStaff.body.data).toMatchObject({ enrollmentId: eid, patientId: pid, trialId: s.trial.id, visitId: null, createdBy: s.inv.id });
    const byPatient = await post(`/patients/${pid}/adverse-events`, s.patientUser, { visitId: vid });
    expect(byPatient.status).toBe(201);
    expect(byPatient.body.data).toMatchObject({ visitId: vid, enrollmentId: eid, createdBy: s.patientUser.id });
    expect(Date.now() - Date.parse(byPatient.body.data.reportedAt)).toBeLessThan(10_000);              // defaults to now
    const ev = audit('adverse_event.reported');
    expect(ev.map((e) => JSON.parse(e.metadata).reportedByRole).sort()).toEqual(['investigator', 'patient']);
    expect((await get(`/adverse-events/${byStaff.body.data.id}`, s.coord)).body.data.id).toBe(byStaff.body.data.id);
    expect((await get(`/patients/${pid}/adverse-events`, s.admin)).body.meta.total).toBe(2);
    expect((await get(`/patients/${pid}/adverse-events`, s.patientUser)).body.data).toHaveLength(2);
  });

  it('validates the request; no severity, type or free text is accepted because the schema has none', async () => {
    const s = await makeScenario(h); const { pid, eid } = ids(s);
    for (const bad of [
      {}, { enrollmentId: 'nope' }, { enrollmentId: eid, reportedAt: 'soon' }, { enrollmentId: eid, severity: 'severe' }, { enrollmentId: eid, description: 'headache' },
      { enrollmentId: eid, eventType: 'nausea' },
    ]) expect((await post(`/patients/${pid}/adverse-events`, s.coord, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await post(`/patients/nope/adverse-events`, s.coord, { enrollmentId: eid })).status).toBe(400);
    expect((await patch(`/adverse-events/${randomUUID()}`, s.admin, { reportedAt: PAST() })).status).toBe(404);   // append-only: there is no update route
    expect((await get(`/patients/${pid}/adverse-events?pageSize=0`, s.coord)).status).toBe(400);
  });

  it('404 for unknown patient or a target that is not theirs; authentication; participant isolation', async () => {
    const s = await makeScenario(h); const o = await makeScenario(h);
    expect((await post(`/patients/${randomUUID()}/adverse-events`, s.coord, { enrollmentId: s.enrollment.id })).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/adverse-events`, s.coord, { enrollmentId: o.enrollment.id })).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/adverse-events`, s.coord, { visitId: o.visit.id })).status).toBe(404);
    expect((await post(`/patients/${s.patient.id}/adverse-events`, null, { enrollmentId: s.enrollment.id })).status).toBe(401);
    // a participant cannot report for somebody else by changing the URL, whatever the body says
    expect((await post(`/patients/${o.patient.id}/adverse-events`, s.patientUser, { enrollmentId: o.enrollment.id })).status).toBe(403);
    expect((await post(`/patients/${randomUUID()}/adverse-events`, s.patientUser, { enrollmentId: s.enrollment.id })).status).toBe(403);
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM adverse_event_reports WHERE enrollment_id = ?').get(o.enrollment.id)).toEqual({ c: 0 });
    const mine = (await post(`/patients/${o.patient.id}/adverse-events`, o.patientUser, { enrollmentId: o.enrollment.id })).body.data.id as string;
    expect((await get(`/adverse-events/${mine}`, o.patientUser)).status).toBe(200);
    expect((await get(`/adverse-events/${mine}`, s.patientUser)).status).toBe(404);
    expect((await get(`/patients/${o.patient.id}/adverse-events`, s.patientUser)).status).toBe(403);
    expect((await get(`/adverse-events/${mine}`, null)).status).toBe(401);
  });
});

describe('capture APIs: cross-cutting', () => {
  const { h, post, get } = setup();

  it('every route requires a valid token (401 before anything else), including malformed and foreign-secret tokens', async () => {
    const u = randomUUID(); const bodyless: Array<['post' | 'get' | 'patch', string]> = [
      ['post', `/patients/${u}/measurements`], ['get', `/patients/${u}/measurements`], ['get', `/measurements/${u}`],
      ['post', `/patients/${u}/ecgs`], ['get', `/patients/${u}/ecgs`], ['get', `/ecgs/${u}`],
      ['post', `/patients/${u}/reminders`], ['get', `/patients/${u}/reminders`], ['get', `/reminders/${u}`], ['patch', `/reminders/${u}`],
      ['post', `/patients/${u}/adverse-events`], ['get', `/patients/${u}/adverse-events`], ['get', `/adverse-events/${u}`],
    ];
    for (const [m, p] of bodyless) {
      expect((await h.api[m](`${api}${p}`).send({})).status, `${m} ${p}`).toBe(401);
      expect((await h.api[m](`${api}${p}`).set('Authorization', 'Bearer garbage').send({})).status, `${m} ${p} garbage`).toBe(401);
    }
  });

  it('a deactivated account loses access immediately', async () => {
    const s = await makeScenario(h);
    expect((await get(`/patients/${s.patient.id}/measurements`, s.coord)).status).toBe(200);
    h.ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(s.coord.id);
    expect((await get(`/patients/${s.patient.id}/measurements`, s.coord)).status).toBe(401);
  });

  it('errors do not leak internals, and nothing breaks the database\'s references or the audit chain', async () => {
    const s = await makeScenario(h);
    const bad = await post(`/patients/${s.patient.id}/ecgs`, s.coord, { visitId: s.visit.id, fileRef: "x'; DROP TABLE visit_ecgs; --" });
    expect(bad.status).toBe(201);                                           // parameterised: the odd string is just data (and a valid relative path)
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM visit_ecgs').get()).toMatchObject({ c: expect.any(Number) });
    const err = await post(`/patients/${s.patient.id}/measurements`, s.coord, { visitId: s.visit.id, performedAt: 'x' });
    expect(JSON.stringify(err.body)).not.toMatch(/SQLITE|sqlite|stack|at Object|node_modules/);
    expect(h.ctx.db.pragma('foreign_key_check')).toEqual([]);
    expect(h.s.audit.verify(s.admin.actor).valid).toBe(true);
  });

  it('existing routes still answer (patients, visits, risk) with the capture router mounted', async () => {
    const s = await makeScenario(h);
    expect((await get(`/patients/${s.patient.id}`, s.admin)).status).toBe(200);
    expect((await get(`/visits/${s.visit.id}`, s.admin)).status).toBe(200);
    expect((await post(`/risk/assessments`, s.admin, { entityType: 'visit', entityId: s.visit.id })).status).toBe(201);
    expect((await get(`/definitely-not-a-route`, s.admin)).status).toBe(404);
    expect((await h.api.get(`${api}/definitely-not-a-route`)).status).toBe(404);
  });
});

describe('capture APIs: the captured data reaches the ML payloads (in-process recording stand-ins, NOT the live Python service)', () => {
  /** Models that just record what the backend sends. */
  function recording() {
    const risk: RiskPredictionRequest[] = []; const integrity: IntegrityScanRequest[] = [];
    const riskModel: RiskModel = {
      name: 'recorder', version: '1', async predict(req) {
        risk.push(req);
        return { contractVersion: CONTRACT_VERSION, requestId: req.requestId, modelName: 'recorder', modelVersion: '1', score: 50, factors: [], explanation: 'recorded' };
      },
    };
    const integrityModel: IntegrityModel = {
      name: 'recorder', version: '1', async detect(req) {
        integrity.push(req);
        return { contractVersion: CONTRACT_VERSION, requestId: req.requestId, modelName: 'recorder', modelVersion: '1', findings: [] };
      },
    };
    return { risk, integrity, riskModel, integrityModel };
  }

  it('reminders and adverse events: created through HTTP, they change the features of the next risk assessment', async () => {
    const rec = recording();
    const h = makeHarness({ riskModel: rec.riskModel });
    const s = await makeScenario(h); const { pid, eid } = ids(s);
    h.ctx.db.prepare('UPDATE trial_sites SET ml_site_category = ?, timezone = ? WHERE id = ?').run('SITE-A', 'Asia/Kolkata', s.site.id);
    h.ctx.db.prepare('UPDATE enrollments SET distance_to_site_km = 12 WHERE id = ?').run(eid);
    h.ctx.db.prepare('UPDATE patients SET daily_wage_worker = 0 WHERE id = ?').run(pid);
    const http = (m: 'post' | 'patch', u: string, who: TestUser, body: object) => h.api[m](`${api}${u}`).set(bearer(who)).send(body);
    const assess = () => h.api.post(`${api}/risk/assessments`).set(bearer(s.admin)).send({ entityType: 'patient', entityId: pid });

    // no resolved reminder yet: "unknown", so the backend does not send an incomplete participant (baseline answers) - nothing reached the model
    const first = await assess();
    expect(first.body.data.engine.name).toBe('baseline-rules');
    expect(rec.risk).toHaveLength(0);

    const r1 = (await http('post', `/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'sms', sentAt: PAST(48) })).body.data.id;
    const r2 = (await http('post', `/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'ivr', sentAt: PAST(24) })).body.data.id;
    const r3 = (await http('post', `/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'call', sentAt: PAST(2) })).body.data.id;
    await http('patch', `/reminders/${r1}`, s.coord, { outcome: 'missed' });
    await http('patch', `/reminders/${r2}`, s.coord, { outcome: 'missed' });
    await http('patch', `/reminders/${r3}`, s.coord, { outcome: 'acknowledged' });
    void r3;
    // an unresolved ('sent') reminder must not count
    await http('post', `/patients/${pid}/reminders`, s.coord, { enrollmentId: eid, channel: 'sms', sentAt: PAST(1) });

    const second = await assess();
    expect(second.body.data.engine.name).toBe('recorder');
    expect(rec.risk).toHaveLength(1);
    expect(rec.risk[0]!.features).toMatchObject({ site_id: 'SITE-A', distance_km: 12, daily_wage_worker: 0, missed_reminders: 2, side_effects_reported: 0 });

    await http('post', `/patients/${pid}/adverse-events`, s.patientUser, { enrollmentId: eid });
    await assess();
    expect(rec.risk[1]!.features).toMatchObject({ missed_reminders: 2, side_effects_reported: 1 });
    expect(buildFeatures(h.ctx.db, 'patient', pid)).toMatchObject({ missed_reminders: 2, side_effects_reported: 1 });
  });

  it('measurements and ECG references: created through HTTP, they appear in the trialData of the next integrity scan', async () => {
    const rec = recording();
    const h = makeHarness({ integrityModel: rec.integrityModel });
    const s = await makeScenario(h); const { pid, vid } = ids(s);
    h.ctx.db.prepare('UPDATE trial_sites SET ml_site_category = ?, timezone = ? WHERE id = ?').run('SITE-A', 'Asia/Kolkata', s.site.id);
    const scan = () => h.api.post(`${api}/integrity/scans`).set(bearer(s.admin)).send({ trialId: s.trial.id, windowHours: 168 });

    expect((await scan()).status).toBe(201);
    const before = rec.integrity.at(-1)!.trialData!.visits.find((v) => v.visitId === vid)!;
    expect(before).toMatchObject({ participantId: pid, systolicBp: null, performedAt: null, enteredAt: null, ecgRecordId: null });
    expect(rec.integrity.at(-1)!.trialData!.ecgs).toBeUndefined();                       // no ECG records: the field is omitted, not empty

    const performedAt = PAST(3);
    const m = await h.api.post(`${api}/patients/${pid}/measurements`).set(bearer(s.coord)).send({ visitId: vid, performedAt, ...V });
    const e = await h.api.post(`${api}/patients/${pid}/ecgs`).set(bearer(s.coord)).send({ visitId: vid, fileRef: 'ecgs/p1.png', recordedAt: performedAt });
    expect([m.status, e.status]).toEqual([201, 201]);

    expect((await scan()).status).toBe(201);
    const td = rec.integrity.at(-1)!.trialData!;
    const sent = td.visits.find((v) => v.visitId === vid)!;
    expect(sent).toMatchObject({ participantId: pid, siteId: s.site.id, ...V, performedAt, ecgRecordId: e.body.data.id });
    expect(sent.enteredAt).toBe(m.body.data.enteredAt);                                  // the server-stamped entry time, not a client value
    expect(td.ecgs).toEqual([{ ecgRecordId: e.body.data.id, visitId: vid, participantId: pid, siteId: s.site.id, imageRef: 'ecgs/p1.png' }]);
    expect(td.scope.trialId).toBe(s.trial.id);
  });
});
