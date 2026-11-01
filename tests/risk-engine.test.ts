import { beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, FEATURE_SCHEMA_VERSION, levelForScore, type FeatureMap, type RiskEntityType } from '../src/ml/contracts';
import { BaselineRiskEngine } from '../src/modules/risk/baselineEngine';
import { resolveRiskConfig } from '../src/modules/risk/rules';
import { bearer, makeHarness, makeScenario } from './helpers';

const req = (entityType: RiskEntityType, features: FeatureMap) => ({
  contractVersion: CONTRACT_VERSION, requestId: 'r1', entityType, entityId: 'e1', featureSchemaVersion: FEATURE_SCHEMA_VERSION, features, requestedAt: new Date().toISOString(),
});

describe('baseline risk engine (pure)', () => {
  const engine = new BaselineRiskEngine();

  it('returns a structured, zero-risk result when nothing triggers', async () => {
    const r = await engine.assess(req('visit', { visit_status: 'verified', visit_is_verified: true, visit_hours_past_scheduled: 2, visit_otp_failed_attempts: 0, visit_otp_locked_count: 0, visit_otp_issue_count: 1 }));
    expect(r).toMatchObject({ entityType: 'visit', entityId: 'e1', score: 0, level: 'low', triggeredRules: [], fallback: { used: false }, engine: { name: 'baseline-rules' } });
    expect(r.explanation).toMatch(/No risk rules/);
    expect(new Date(r.assessedAt).toISOString()).toBe(r.assessedAt);
  });

  it('flags repeated failed OTP attempts and locked OTPs with an explanation', async () => {
    const r = await engine.assess(req('visit', { visit_status: 'otp_pending', visit_is_verified: false, visit_hours_past_scheduled: 1, visit_otp_failed_attempts: 5, visit_otp_locked_count: 1, visit_otp_issue_count: 1 }));
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['visit.otp_failed_attempts', 'visit.otp_locked']);
    expect(r.score).toBe(55);
    expect(r.level).toBe('high');
    expect(r.explanation).toContain('5 incorrect OTP attempts');
    expect(r.triggeredRules[0]).toMatchObject({ weight: 30, name: expect.any(String), detail: expect.stringContaining('threshold 3') });
  });

  it('flags missing verification only for unverified, past-due visits', async () => {
    const f = { visit_status: 'scheduled', visit_is_verified: false, visit_otp_failed_attempts: 0, visit_otp_locked_count: 0, visit_otp_issue_count: 0 };
    expect((await engine.assess(req('visit', { ...f, visit_hours_past_scheduled: 30 }))).triggeredRules.map((t) => t.ruleId)).toEqual(['visit.missing_verification']);
    expect((await engine.assess(req('visit', { ...f, visit_hours_past_scheduled: 5 }))).score).toBe(0);
    expect((await engine.assess(req('visit', { ...f, visit_hours_past_scheduled: null }))).score).toBe(0);
    expect((await engine.assess(req('visit', { ...f, visit_status: 'verified', visit_is_verified: true, visit_hours_past_scheduled: 90 }))).score).toBe(0);
  });

  it('detects unusual visit patterns, duplicate claims and high claim volume for a patient', async () => {
    const r = await engine.assess(req('patient', {
      patient_failed_otp_24h: 6, patient_visits_7d: 5, patient_missed_90d: 2, patient_unverified_overdue: 0,
      patient_duplicate_reimbursements: 1, patient_reimbursement_total_30d_cents: 120000,
    }));
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual([
      'patient.failed_otp_burst', 'patient.visit_frequency', 'patient.missed_visits', 'patient.duplicate_reimbursements', 'patient.reimbursement_volume']);
    expect(r.score).toBe(100); // capped
    expect(r.level).toBe('critical');
  });

  it('evaluates reimbursement rules, including absolute and relative amount outliers', async () => {
    const base = { reimb_duplicate_count: 0, reimb_visit_status: 'completed', reimb_visit_verified: true, reimb_patient_count_24h: 1, reimb_category: 'travel' };
    const ids = async (f: FeatureMap) => (await engine.assess(req('reimbursement', { ...base, ...f }))).triggeredRules.map((t) => t.ruleId);
    expect(await ids({ reimb_amount_cents: 1000, reimb_amount_ratio_to_category_avg: 1 })).toEqual([]);
    expect(await ids({ reimb_amount_cents: 60000, reimb_amount_ratio_to_category_avg: null })).toEqual(['reimbursement.amount_outlier']);
    expect(await ids({ reimb_amount_cents: 9000, reimb_amount_ratio_to_category_avg: 3.5 })).toEqual(['reimbursement.amount_outlier']);
    expect(await ids({ reimb_amount_cents: 1000, reimb_amount_ratio_to_category_avg: 1, reimb_duplicate_count: 2 })).toEqual(['reimbursement.duplicate']);
    expect(await ids({ reimb_amount_cents: 1000, reimb_amount_ratio_to_category_avg: 1, reimb_visit_verified: false, reimb_visit_status: 'scheduled' })).toEqual(['reimbursement.unverified_visit']);
    expect(await ids({ reimb_amount_cents: 1000, reimb_amount_ratio_to_category_avg: 1, reimb_patient_count_24h: 3 })).toEqual(['reimbursement.rapid_submission']);
  });

  it('only applies rules relevant to the entity type', async () => {
    const r = await engine.assess(req('patient', { visit_otp_failed_attempts: 99, reimb_duplicate_count: 9 }));
    expect(r.triggeredRules).toEqual([]);
  });

  it('maps scores to levels at the configured boundaries', () => {
    expect([0, 24.9, 25, 49.9, 50, 74.9, 75, 100].map((s) => levelForScore(s))).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
    expect(levelForScore(40, { medium: 10, high: 30, critical: 60 })).toBe('high');
  });

  it('supports configurable thresholds, weights, disabling, and level cut-offs', async () => {
    const custom = new BaselineRiskEngine({
      levels: { medium: 10, high: 20, critical: 30 },
      rules: { 'visit.otp_failed_attempts': { threshold: 1, weight: 12 }, 'visit.otp_locked': { enabled: false } },
    });
    const r = await custom.assess(req('visit', { visit_status: 'otp_pending', visit_is_verified: false, visit_hours_past_scheduled: 0, visit_otp_failed_attempts: 1, visit_otp_locked_count: 3, visit_otp_issue_count: 0 }));
    expect(r.triggeredRules.map((t) => t.ruleId)).toEqual(['visit.otp_failed_attempts']);
    expect(r).toMatchObject({ score: 12, level: 'medium' });
  });

  it('rejects invalid rule overrides', () => {
    expect(() => resolveRiskConfig({ rules: { 'no.such.rule': { weight: 5 } } })).toThrow(/Unknown risk rule/);
    expect(() => resolveRiskConfig({ levels: { medium: 60, high: 50 } })).toThrow(/increasing/);
    expect(() => resolveRiskConfig({ rules: { 'visit.otp_locked': { weight: 500 } } })).toThrow();
  });

  it('refuses an incompatible contract major version', async () => {
    await expect(engine.assess({ ...req('visit', {}), contractVersion: '2.0' })).rejects.toThrow(/contractVersion/);
  });
});

describe('risk assessment API (database-backed)', () => {
  let h: ReturnType<typeof makeHarness>;
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeEach(async () => { h = makeHarness(); sc = await makeScenario(h); });
  const assess = (entityType: string, entityId: string, who = sc.admin) => h.api.post('/api/v1/risk/assessments').set(bearer(who)).send({ entityType, entityId });

  it('assesses a visit with failed OTP attempts from real data', async () => {
    h.s.otp.issue(sc.visit.id, sc.coord.actor, { code: '482913' });
    for (let i = 0; i < 3; i++) try { h.s.otp.verify(sc.visit.id, '000000', sc.coord.actor); } catch { /* expected */ }
    const res = await assess('visit', sc.visit.id);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ entityType: 'visit', entityId: sc.visit.id, engine: { name: 'baseline-rules' }, fallback: { used: false, reason: null } });
    expect(res.body.data.triggeredRules.map((t: { ruleId: string }) => t.ruleId)).toContain('visit.otp_failed_attempts');
    expect(res.body.data.score).toBeGreaterThanOrEqual(30);
  });

  it('assesses a patient with duplicate reimbursements and a reimbursement with a duplicate', async () => {
    const mk = () => h.s.reimbursements.create({ visitId: sc.visit.id, category: 'travel', amountCents: 7500, currency: 'USD' }, sc.coord.actor);
    const r1 = mk(); const r2 = mk();
    const p = await assess('patient', sc.patient.id);
    expect(p.body.data.triggeredRules.map((t: { ruleId: string }) => t.ruleId)).toContain('patient.duplicate_reimbursements');
    const r = await assess('reimbursement', r2.id);
    const ids = r.body.data.triggeredRules.map((t: { ruleId: string }) => t.ruleId);
    expect(ids).toContain('reimbursement.duplicate');
    expect(ids).toContain('reimbursement.unverified_visit');
    expect(r1.id).not.toBe(r2.id);
    // cancelled duplicates no longer count
    h.s.reimbursements.cancel(r1.id, undefined, sc.admin.actor);
    expect((await assess('reimbursement', r2.id)).body.data.triggeredRules.map((t: { ruleId: string }) => t.ruleId)).not.toContain('reimbursement.duplicate');
  });

  it('stores assessments, audits them, and supports list/get/filter', async () => {
    const a = (await assess('patient', sc.patient.id)).body.data;
    await assess('visit', sc.visit.id, sc.inv);
    expect((await h.api.get(`/api/v1/risk/assessments/${a.id}`).set(bearer(sc.coord))).body.data.id).toBe(a.id);
    const list = await h.api.get(`/api/v1/risk/assessments?entityType=patient&entityId=${sc.patient.id}`).set(bearer(sc.coord));
    expect(list.body.data).toHaveLength(1);
    expect((await h.api.get('/api/v1/risk/assessments?sort=score&order=desc&pageSize=1').set(bearer(sc.coord))).body.meta.total).toBe(2);
    const ev = h.ctx.db.prepare(`SELECT metadata FROM audit_logs WHERE action = 'risk.assessed' AND entity_id = ?`).get(sc.patient.id) as { metadata: string };
    expect(JSON.parse(ev.metadata)).toMatchObject({ assessmentId: a.id, engine: 'baseline-rules' });
  });

  it('validates input and handles unknown entities', async () => {
    expect((await assess('trial', sc.trial.id)).status).toBe(400);
    expect((await assess('patient', 'nope')).status).toBe(400);
    expect((await assess('patient', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await assess('visit', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await assess('patient', sc.patient.id, sc.patientUser)).status).toBe(403);
  });

  it('exposes the active rule configuration', async () => {
    const res = await h.api.get('/api/v1/risk/rules').set(bearer(sc.coord));
    expect(res.body.data.engine.name).toBe('baseline-rules');
    expect(res.body.data.baselineConfig.rules['visit.otp_locked']).toMatchObject({ enabled: true, weight: 25 });
  });

  it('applies env-provided rule overrides', async () => {
    const t = makeHarness({ env: { RISK_RULES_OVERRIDES: JSON.stringify({ rules: { 'visit.otp_failed_attempts': { threshold: 1 } } }) } });
    const s2 = await makeScenario(t);
    t.s.otp.issue(s2.visit.id, s2.coord.actor);
    try { t.s.otp.verify(s2.visit.id, '999999', s2.coord.actor); } catch { /* expected */ }
    const r = await t.s.risk.assess({ entityType: 'visit', entityId: s2.visit.id }, s2.admin.actor);
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('visit.otp_failed_attempts');
  });
});
