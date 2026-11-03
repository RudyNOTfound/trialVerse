import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_VERSION, FEATURE_SCHEMA_VERSION, describeIntegrityRequestProblem, describeRiskRequestProblem, featureSchemaVersionFor,
  trialDataSchema, type IntegrityScanRequest, type RiskPredictionRequest,
} from '../src/ml/contracts';
import { summarizeModelError } from '../src/ml/httpModels';
import { buildFeatures } from '../src/modules/risk/features';
import { buildTrialData, listScannableTrials } from '../src/modules/integrity/trialData';
import { completeModelInputs, makeHarness, makeScenario, type Harness } from './helpers';

const T = (d = 0) => new Date(Date.now() + d * 864e5).toISOString();
async function ready() { const h = makeHarness(); const sc = await makeScenario(h); return { h, sc }; }
const addMeasure = (h: Harness, visitId: string, over: Record<string, unknown> = {}) => {
  const m = { performed_at: '2026-03-01T04:00:00.000Z', entered_at: '2026-03-01T06:00:00.000Z', systolic_bp: 120, diastolic_bp: 80, heart_rate: 72, weight_kg: 70.5, glucose_mg_dl: 110, ...over };
  h.ctx.db.prepare(`INSERT INTO visit_measurements (visit_id, performed_at, entered_at, entered_by, systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl) VALUES (?, ?, ?, (SELECT id FROM users LIMIT 1), ?, ?, ?, ?, ?)`)
    .run(visitId, m.performed_at, m.entered_at, m.systolic_bp, m.diastolic_bp, m.heart_rate, m.weight_kg, m.glucose_mg_dl);
};

describe('contract constants', () => {
  it('declare contract 1.1 / feature schema 2 (visit & reimbursement keep schema 1)', () => {
    expect(CONTRACT_VERSION).toBe('1.1');
    expect(FEATURE_SCHEMA_VERSION).toBe('2');
    expect(featureSchemaVersionFor('patient')).toBe('2');
    expect(featureSchemaVersionFor('visit')).toBe('1');
    expect(featureSchemaVersionFor('reimbursement')).toBe('1');
  });
});

describe('risk request: participant features (schema 2)', () => {
  it('derives every model input from stored records', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    const now = Date.now();
    // 3 extra visits: 1 missed (past), 1 cancelled (not counted)
    const past = sc.newVisit('Missed one', T(-10)); h.ctx.db.prepare(`UPDATE visits SET status = 'missed' WHERE id = ?`).run(past.id);
    const cancelled = sc.newVisit('Cancelled', T(5)); h.ctx.db.prepare(`UPDATE visits SET status = 'cancelled' WHERE id = ?`).run(cancelled.id);
    // an adverse event, a phone change, one paid claim that took 12 days
    h.ctx.db.prepare(`INSERT INTO adverse_event_reports (id, enrollment_id, reported_at, created_by, created_at) VALUES ('ae1', ?, ?, ?, ?)`).run(sc.enrollment.id, T(), sc.admin.id, T());
    h.s.patients.update(sc.patient.id, { phone: '555-0100' }, sc.coord.actor);
    h.ctx.db.prepare(`INSERT INTO reimbursements (id, patient_id, visit_id, trial_id, category, amount_cents, currency, status, payment_status, requested_by, paid_at, created_at, updated_at)
                      VALUES ('r1', ?, ?, ?, 'travel', 1000, 'USD', 'approved', 'paid', ?, ?, ?, ?)`)
      .run(sc.patient.id, sc.visit.id, sc.trial.id, sc.patient.userId ?? sc.admin.id, new Date(Date.now() - 2 * 864e5).toISOString(), new Date(Date.now() - 14 * 864e5).toISOString(), T());
    const f = buildFeatures(h.ctx.db, 'patient', sc.patient.id, now);
    expect(f).toMatchObject({
      site_id: 'SITE-A', distance_km: 40, daily_wage_worker: 1,
      scheduled_visits: 2,                 // baseline visit + missed one; the cancelled one is excluded
      visits_missed: 1, missed_reminders: 1, side_effects_reported: 1, phone_changed: 1, reimbursement_delay_days: 12,
    });
    expect(f.age).toBe(Math.floor((now - Date.parse('1980-01-01')) / (365.25 * 864e5)));
    expect(f).toHaveProperty('patient_failed_otp_24h'); // v1 keys are still sent: the baseline engine reads them
  });

  it('sends null (never 0) for everything it cannot establish', async () => {
    const { h, sc } = await ready();                 // no model inputs captured at all
    const f = buildFeatures(h.ctx.db, 'patient', sc.patient.id);
    expect(f).toMatchObject({ site_id: null, distance_km: null, daily_wage_worker: null, missed_reminders: null, reimbursement_delay_days: null });
    expect(f.side_effects_reported).toBe(0);         // "no report" is a known 0, unlike unknown inputs
    expect(f.phone_changed).toBe(0);
    expect(f.scheduled_visits).toBe(1);
  });

  it('treats "no resolved reminder" as unknown, but a resolved-and-acknowledged history as a real 0', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    h.ctx.db.prepare('DELETE FROM visit_reminders').run();
    expect(buildFeatures(h.ctx.db, 'patient', sc.patient.id).missed_reminders).toBeNull();
    h.ctx.db.prepare(`INSERT INTO visit_reminders (id, enrollment_id, channel, sent_at, outcome, acknowledged_at, outcome_recorded_at, created_at) VALUES ('a', ?, 'sms', ?, 'sent', NULL, NULL, ?)`).run(sc.enrollment.id, T(), T());
    expect(buildFeatures(h.ctx.db, 'patient', sc.patient.id).missed_reminders).toBeNull();   // still unresolved
    h.ctx.db.prepare(`UPDATE visit_reminders SET outcome = 'acknowledged', acknowledged_at = ?, outcome_recorded_at = ? WHERE id = 'a'`).run(T(), T());
    expect(buildFeatures(h.ctx.db, 'patient', sc.patient.id).missed_reminders).toBe(0);
  });

  it('does not send an incomplete participant: baseline with a precise, value-free reason', async () => {
    const req = (features: RiskPredictionRequest['features']): RiskPredictionRequest => ({ contractVersion: CONTRACT_VERSION, requestId: 'r', entityType: 'patient', entityId: 'p', featureSchemaVersion: '2', features, requestedAt: T() });
    const complete = { site_id: 'SITE-A', distance_km: 40, daily_wage_worker: 1, scheduled_visits: 8, missed_reminders: 2, side_effects_reported: 1, phone_changed: 0, visits_missed: 1, age: 52, reimbursement_delay_days: 12 };
    expect(describeRiskRequestProblem(req(complete))).toBeNull();
    expect(describeRiskRequestProblem(req({ ...complete, distance_km: null, site_id: null }))).toBe('missing required features: site_id, distance_km');
    expect(describeRiskRequestProblem(req({ ...complete, daily_wage_worker: 2, distance_km: 5000 }))).toMatch(/invalid feature values: .*distance_km.*daily_wage_worker|invalid feature values: .*daily_wage_worker.*distance_km/);
    expect(describeRiskRequestProblem(req({ ...complete, visits_missed: 9 }))).toMatch(/visits_missed/);
    expect(describeRiskRequestProblem(req({ ...complete, age: null, reimbursement_delay_days: null }))).toBeNull(); // optional inputs may be null
    expect(describeRiskRequestProblem({ ...req(complete), featureSchemaVersion: '1', features: {} })).toBeNull();    // v1 requests are not pre-checked
  });

  it('end to end: an incomplete participant gets the baseline engine with that reason; a complete one reaches the model', async () => {
    const sent: RiskPredictionRequest[] = [];
    const h = makeHarness({ riskModel: { name: 'stub', version: '1', async predict(r) { sent.push(r); return { contractVersion: CONTRACT_VERSION, requestId: r.requestId, modelName: 'stub', modelVersion: '1', score: 55, factors: [], explanation: 'x' }; } } });
    const sc = await makeScenario(h);
    const a = await h.s.risk.assess({ entityType: 'patient', entityId: sc.patient.id }, sc.admin.actor);
    expect(sent).toHaveLength(0);
    expect(a.fallback).toMatchObject({ used: true });
    expect(a.fallback.reason).toMatch(/^invalid_request: missing required features: site_id, distance_km, daily_wage_worker, missed_reminders$/);
    expect(a.engine.name).toBe('baseline-rules');
    completeModelInputs(h, sc);
    const b = await h.s.risk.assess({ entityType: 'patient', entityId: sc.patient.id }, sc.admin.actor);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ contractVersion: '1.1', featureSchemaVersion: '2', entityType: 'patient' });
    expect(b).toMatchObject({ engine: { name: 'stub' }, fallback: { used: false } });
    // visit assessments keep schema 1 and are unaffected
    await h.s.risk.assess({ entityType: 'visit', entityId: sc.visit.id }, sc.admin.actor);
  });
});

describe('integrity request: trialData', () => {
  it('maps stored records to the contract (ids, timezones, dropout, OTP exception, measurements, ECG refs)', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc, { category: 'SITE-C', timezone: 'Asia/Kolkata' });
    const db = h.ctx.db;
    // visit A: completed + verified via OTP, with measurements and an ECG; visit B: completed through the exception path
    const a = sc.visit; db.prepare(`UPDATE visits SET status = 'completed', verified_at = ?, completed_at = ? WHERE id = ?`).run(T(-3), T(-3), a.id);
    addMeasure(h, a.id);
    db.prepare(`INSERT INTO visit_ecgs (id, visit_id, file_ref, file_sha256, created_by, created_at) VALUES ('ecg-a', ?, 'ecgs/ecg_001.png', NULL, ?, ?)`).run(a.id, sc.admin.id, T());
    const b = sc.newVisit('Exception', T(-2));
    await h.s.visits.changeStatus(b.id, 'completed', undefined, sc.inv.actor, { reasonCode: 'device_offline', note: 'secret free text' });
    const c = sc.newVisit('Future', T(10));

    const built = buildTrialData(db, sc.trial.id, new Date('2026-11-01T12:00:00.000Z'));
    expect(built.meta).toMatchObject({ participants: 1, visits: 3, ecgs: 1, truncated: null, sitesSkippedNoTimezone: [] });
    const td = built.trialData!;
    expect(trialDataSchema.safeParse(td).success).toBe(true);
    expect(td.scope).toEqual({ trialId: sc.trial.id, asOf: '2026-11-01T12:00:00.000Z' });
    expect(td.sites).toEqual([{ siteId: sc.site.id, siteCode: 'S-01', timezone: 'Asia/Kolkata' }]);
    expect(td.participants).toEqual([{ participantId: sc.patient.id, siteId: sc.site.id, droppedOut: false }]);
    const byId = new Map(td.visits.map((v) => [v.visitId, v]));
    expect(byId.get(a.id)).toMatchObject({
      visitNumber: expect.any(Number), status: 'completed', otpVerified: true, otpExceptionReason: null, ecgRecordId: 'ecg-a',
      performedAt: '2026-03-01T04:00:00.000Z', enteredAt: '2026-03-01T06:00:00.000Z', systolicBp: 120, diastolicBp: 80, heartRate: 72, weightKg: 70.5, glucoseMgDl: 110,
    });
    expect(byId.get(b.id)).toMatchObject({ status: 'completed', otpVerified: false, otpExceptionReason: 'device_offline', ecgRecordId: null, systolicBp: null });
    expect(byId.get(c.id)).toMatchObject({ status: 'scheduled', otpVerified: null, otpExceptionReason: null });
    expect(td.ecgs).toEqual([{ ecgRecordId: 'ecg-a', visitId: a.id, participantId: sc.patient.id, siteId: sc.site.id, imageRef: 'ecgs/ecg_001.png' }]);
    // visit numbers follow scheduled order within the enrollment
    expect([...td.visits].sort((x, y) => x.visitNumber - y.visitNumber).map((v) => v.visitId)).toEqual([...td.visits].sort((x, y) => Date.parse(x.scheduledAt) - Date.parse(y.scheduledAt)).map((v) => v.visitId));
    // privacy: nothing but opaque ids, codes and numbers
    const json = JSON.stringify(td);
    for (const leak of ['Tester', 'Pat', '1980', 'secret free text', '@test.local', 'Site One']) expect(json).not.toContain(leak);
    expect(json).not.toMatch(/\/(tmp|home|mnt)\//);
  });

  it('marks withdrawn participants as dropped out and leaves screening ones out together with their visits', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    const p2 = h.s.patients.create({ firstName: 'Screening', lastName: 'Only', dateOfBirth: '1990-01-01', sex: 'male' }, sc.coord.actor);
    const e2 = h.s.trials.createEnrollment({ patientId: p2.id, trialId: sc.trial.id, trialSiteId: sc.site.id }, sc.coord.actor);   // stays in screening
    h.s.visits.create({ enrollmentId: e2.id, visitType: 'Screen', scheduledAt: T(1) }, sc.coord.actor);
    h.s.trials.updateEnrollmentStatus(sc.enrollment.id, 'withdrawn', sc.inv.actor);
    const td = buildTrialData(h.ctx.db, sc.trial.id, new Date()).trialData!;
    expect(td.participants).toEqual([{ participantId: sc.patient.id, siteId: sc.site.id, droppedOut: true }]);
    expect(td.visits.every((v) => v.participantId === sc.patient.id)).toBe(true);
  });

  it('omits a site without a timezone TOGETHER with its participants, visits and ECGs, and reports it', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    const second = h.s.trials.createSite(sc.trial.id, { siteCode: 'S-02', name: 'No tz', country: 'India' }, sc.admin.actor);   // timezone NULL
    const p2 = h.s.patients.create({ firstName: 'Other', lastName: 'Site', dateOfBirth: '1990-01-01', sex: 'male' }, sc.coord.actor);
    const e2 = h.s.trials.createEnrollment({ patientId: p2.id, trialId: sc.trial.id, trialSiteId: second.id }, sc.coord.actor);
    h.s.trials.updateEnrollmentStatus(e2.id, 'enrolled', sc.inv.actor);
    h.s.visits.create({ enrollmentId: e2.id, visitType: 'Elsewhere', scheduledAt: T(1) }, sc.coord.actor);
    const built = buildTrialData(h.ctx.db, sc.trial.id, new Date());
    expect(built.meta.sitesSkippedNoTimezone).toEqual([second.id]);
    expect(built.trialData!.sites.map((s) => s.siteId)).toEqual([sc.site.id]);
    expect(built.trialData!.participants.map((p) => p.participantId)).toEqual([sc.patient.id]);
    expect(built.trialData!.visits.every((v) => v.siteId === sc.site.id)).toBe(true);
    expect(trialDataSchema.safeParse(built.trialData).success).toBe(true);   // no dangling references
  });

  it('rejects an invalid stored timezone instead of sending it, and sends nothing when no site qualifies', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    h.ctx.db.prepare(`UPDATE trial_sites SET timezone = 'IST' WHERE id = ?`).run(sc.site.id);
    const built = buildTrialData(h.ctx.db, sc.trial.id, new Date());
    expect(built.trialData).toBeNull();
    expect(built.meta.sitesSkippedInvalidTimezone).toEqual([sc.site.id]);
    h.ctx.db.prepare(`UPDATE trial_sites SET timezone = NULL WHERE id = ?`).run(sc.site.id);
    expect(buildTrialData(h.ctx.db, sc.trial.id, new Date()).meta.sitesSkippedNoTimezone).toEqual([sc.site.id]);
  });

  it('lists only trials that have enrolled participants', async () => {
    const { h, sc } = await ready();
    const empty = h.s.trials.createTrial({ code: 'EMPTY-1', title: 'Empty trial', sponsor: 'Acme', phase: 'I' }, sc.admin.actor);
    expect(listScannableTrials(h.ctx.db)).toEqual([sc.trial.id]);
    expect(listScannableTrials(h.ctx.db)).not.toContain(empty.id);
  });

  it('uses a constant number of queries however many visits there are', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc);
    const count = () => { const spy = vi.spyOn(h.ctx.db, 'prepare'); buildTrialData(h.ctx.db, sc.trial.id, new Date()); const n = spy.mock.calls.length; spy.mockRestore(); return n; };
    const small = count();
    for (let i = 0; i < 60; i++) sc.newVisit(`Bulk ${i}`, T(i - 30));
    expect(buildTrialData(h.ctx.db, sc.trial.id, new Date()).meta.visits).toBeGreaterThan(60);
    expect(count()).toBe(small);
  });

  it('keeps timestamps as UTC instants (the site timezone travels separately)', async () => {
    const { h, sc } = await ready();
    completeModelInputs(h, sc, { timezone: 'America/New_York' });
    const td = buildTrialData(h.ctx.db, sc.trial.id, new Date()).trialData!;
    expect(td.sites[0]!.timezone).toBe('America/New_York');
    for (const v of td.visits) expect(v.scheduledAt).toMatch(/Z$/);
  });
});

describe('pre-send validation mirrors the service (it answers 422 for the whole call)', () => {
  const base = (): IntegrityScanRequest => ({
    contractVersion: '1.1', requestId: 'r', windowStart: T(-1), windowEnd: T(), events: [], reimbursements: [], openVisits: [],
    chain: { valid: true, eventsChecked: 0, errorCount: 0, firstError: null },
    trialData: {
      scope: { trialId: 't', asOf: '2026-11-01T12:00:00.000Z' },
      sites: [{ siteId: 's1', siteCode: 'A', timezone: 'Asia/Kolkata' }],
      participants: [{ participantId: 'p1', siteId: 's1', droppedOut: false }],
      visits: [{ visitId: 'v1', participantId: 'p1', siteId: 's1', visitNumber: 1, status: 'completed', scheduledAt: '2026-10-01T04:30:00.000Z', otpVerified: false, otpExceptionReason: 'device_offline', ecgRecordId: 'g1' }],
      ecgs: [{ ecgRecordId: 'g1', visitId: 'v1', participantId: 'p1', siteId: 's1', imageRef: 'ecgs/a.png' }],
    },
  });
  const problem = (mut: (r: IntegrityScanRequest) => void) => { const r = base(); mut(r); return describeIntegrityRequestProblem(r); };
  it('accepts a well-formed request and a request without trialData', () => {
    expect(describeIntegrityRequestProblem(base())).toBeNull();
    expect(problem((r) => { delete r.trialData; })).toBeNull();
  });
  it.each([
    ['non-IANA timezone', (r: IntegrityScanRequest) => { r.trialData!.sites[0]!.timezone = 'IST'; }, /timezone/],
    ['offset timezone', (r: IntegrityScanRequest) => { r.trialData!.sites[0]!.timezone = '+05:30'; }, /timezone/],
    ['scheduledAt without an offset', (r: IntegrityScanRequest) => { r.trialData!.visits[0]!.scheduledAt = '2026-10-01T04:30:00'; }, /scheduledAt/],
    ['otpExceptionReason with otpVerified true', (r: IntegrityScanRequest) => { r.trialData!.visits[0]!.otpVerified = true; }, /otpExceptionReason/],
    ['unknown reason code', (r: IntegrityScanRequest) => { (r.trialData!.visits[0] as any).otpExceptionReason = 'lazy'; }, /otpExceptionReason/],
    ['dangling site reference', (r: IntegrityScanRequest) => { r.trialData!.participants[0]!.siteId = 'nope'; }, /unknown siteId/],
    ['duplicate visit id', (r: IntegrityScanRequest) => { r.trialData!.visits.push({ ...r.trialData!.visits[0]!, ecgRecordId: null }); }, /duplicate visitId/],
    ['ECG that disagrees with its visit', (r: IntegrityScanRequest) => { r.trialData!.ecgs![0]!.participantId = 'p2'; r.trialData!.participants.push({ participantId: 'p2', siteId: 's1', droppedOut: false }); }, /disagrees/],
    ['visit pointing at a missing ECG record', (r: IntegrityScanRequest) => { r.trialData!.visits[0]!.ecgRecordId = 'ghost'; }, /ecgRecordId/],
    ['non-numeric measurement', (r: IntegrityScanRequest) => { (r.trialData!.visits[0] as any).systolicBp = '120'; }, /systolicBp/],
    ['too many visits', (r: IntegrityScanRequest) => { r.trialData!.visits = Array.from({ length: 20001 }, (_, i) => ({ ...r.trialData!.visits[0]!, visitId: `v${i}`, ecgRecordId: null })); }, /visits/],
  ])('refuses %s before sending', (_name, mutate, re) => {
    const p = problem(mutate);
    expect(p).not.toBeNull();
    expect(p).toMatch(re);
  });
});

describe('diagnosable, safe error summaries from the Python service', () => {
  it('keeps codes, feature names and field paths; drops messages and values', () => {
    expect(summarizeModelError({ error: { code: 'unsupported_feature_schema', message: 'Request lacks ... secret-patient-123', details: { missingFeatures: ['distance_km', 'site_id'] } } })).toBe('unsupported_feature_schema; missing: distance_km, site_id');
    expect(summarizeModelError({ error: { code: 'invalid_request', message: 'x', details: [{ field: 'trialData.sites.0.timezone', message: 'Value error, bad value "Mars/Olympus"' }, { field: 'trialData.visits.3.scheduledAt', message: 'm' }] } })).toBe('invalid_request; fields: trialData.sites.0.timezone, trialData.visits.3.scheduledAt');
    expect(summarizeModelError({ error: { code: 'unknown_site_category', details: { siteId: 'SITE-Z', knownSiteCategories: ['SITE-A'] } } })).toBe('unknown_site_category');
  });
  it('ignores hostile or malformed bodies', () => {
    expect(summarizeModelError(null)).toBe('');
    expect(summarizeModelError('oops')).toBe('');
    expect(summarizeModelError({ error: { code: 'Bad Code!', details: { missingFeatures: ['a b', 'x;rm -rf'] } } })).toBe('');
    expect(summarizeModelError({ error: { code: 'x', details: [{ field: 'a\nb' }] } })).toBe('x'); // valid code kept, hostile field name dropped
  });
});
