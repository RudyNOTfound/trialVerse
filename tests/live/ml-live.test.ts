/**
 * LIVE backend <-> Python integration tests (contract v1.1). Nothing here is mocked: the TypeScript backend builds real requests from
 * real database rows and sends them over HTTP to Person B's FastAPI service, which runs the trained model and the integrity engine.
 *
 * Skipped unless the service is running. To run them:
 *   1. python -m app.data_generation.generate_all           (in ml-service/; once)
 *   2. ML_API_KEY=<test key> ML_ECG_DIR=<abs>/ml-service/generated_data uvicorn app.main:app --port 8011   (in ml-service/)
 *   3. ML_LIVE_URL=http://127.0.0.1:8011 ML_LIVE_KEY=<test key> ML_LIVE_DATA=<abs>/ml-service/generated_data \
 *      ML_LIVE_LOG=<service stderr log file> npx vitest run tests/live
 * (see docs/ML_INTEGRATION.md). The Python service's own request log is used as independent evidence that it processed each call.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, type IntegrityScanRequest } from '../../src/ml/contracts';
import { HttpIntegrityModel, HttpRiskModel } from '../../src/ml/httpModels';
import { buildTrialData } from '../../src/modules/integrity/trialData';
import { buildFeatures } from '../../src/modules/risk/features';
import { importMlDemo, readCsv } from '../../src/seed/mlDemoImport';
import { makeHarness } from '../helpers';

const URL = process.env.ML_LIVE_URL;
const KEY = process.env.ML_LIVE_KEY ?? '';
const DATA = process.env.ML_LIVE_DATA ?? '';
const LOG = process.env.ML_LIVE_LOG;
const live = !!URL && !!DATA && fs.existsSync(`${DATA}/demo/visits.csv`);

/** Ground truth injected by the data generator (Site C only). */
const truth = live ? readCsv(`${DATA}/metadata/fraud_ground_truth.csv`) : [];
const gt = (type: string) => new Set(truth.filter((r) => r.anomaly_type === type).map((r) => r.visit_id!));

function fresh(env: Record<string, string> = {}, imp: { documentedOtpExceptionVisitIds?: string[] } = {}) {
  const h = makeHarness({
    env: {
      ML_RISK_ENABLED: 'true', ML_RISK_URL: URL!, ML_INTEGRITY_ENABLED: 'true', ML_INTEGRITY_URL: URL!, ML_API_KEY: KEY, ML_ECG_DIR: DATA,
      ML_TIMEOUT_MS: '10000', ML_INTEGRITY_TIMEOUT_MS: '60000', ...env,
    },
  });
  const r = importMlDemo(h.ctx.db, { dataDir: DATA, ...imp });
  return { h, r, actor: { id: r.users.admin, role: 'admin' as const } };
}
const alerts = (h: ReturnType<typeof fresh>['h'], where = '1=1', ...p: unknown[]) =>
  h.ctx.db.prepare(`SELECT rule_id, entity_type, entity_id, severity, message, details, source FROM integrity_alerts WHERE ${where}`).all(...p) as Array<{ rule_id: string; entity_type: string; entity_id: string; severity: string; message: string; details: string; source: string }>;

/** The Python service's own access log: [{path, status}] appended since `offset` bytes. */
const logSize = () => (LOG && fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
function pythonRequestsSince(offset: number): Array<{ path: string; status: number }> {
  if (!LOG) return [];
  const text = fs.readFileSync(LOG).subarray(offset).toString('utf8');
  return text.split('\n').flatMap((l) => { try { const j = JSON.parse(l); return j.event === 'request' ? [{ path: j.path as string, status: j.status as number }] : []; } catch { return []; } });
}

describe.skipIf(!live)('LIVE: TypeScript backend -> Python ML service (contract v1.1)', () => {
  it('the service is up, speaks contract 1.1, has the trained Logistic Regression model, and enforces authentication', async () => {
    const ready = await (await fetch(`${URL}/ready`)).json() as any;
    expect(ready).toMatchObject({ ready: true, contractVersion: '1.1' });
    expect(ready.components.retention_model.modelVersion).toMatch(/logistic_regression/);
    expect(ready.components.retention_model.knownSiteCategories).toEqual(['SITE-A', 'SITE-B', 'SITE-C', 'SITE-D', 'SITE-E']);
    expect((await fetch(`${URL}/v1/risk/predict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  // ---------------------------------------------------------------- risk
  it('RISK: a participant with complete v1.1 features is scored by the trained Logistic Regression model (not the baseline)', async () => {
    const { h, actor } = fresh();
    const before = logSize();
    const now = Date.now();
    const result = await h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, actor);
    expect(result.fallback).toEqual({ used: false, reason: null });
    expect(result.engine.name).toBe('retention-dropout-risk');
    expect(result.engine.version).toMatch(/^1\.0\.0\+logistic_regression\./);
    expect(result.triggeredRules.length).toBeGreaterThan(0);
    expect(result.triggeredRules.every((r) => r.ruleId.startsWith('ml:'))).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.explanation).toMatch(/retention model category/);       // the model's own scale is labelled, never relabelled
    // independent proof: Python logged exactly one 200 for this call, and answering it directly with the same features gives the same score
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/risk/predict', status: 200 }]);
    const features = buildFeatures(h.ctx.db, 'patient', 'P-A-001', now);
    expect(features).toMatchObject({ site_id: 'SITE-A', distance_km: 40, daily_wage_worker: 1 });
    const direct = await new HttpRiskModel({ baseUrl: URL!, timeoutMs: 10000, apiKey: KEY })
      .predict({ contractVersion: CONTRACT_VERSION, requestId: 'direct-1', entityType: 'patient', entityId: 'P-A-001', featureSchemaVersion: '2', features, requestedAt: new Date(now).toISOString() });
    expect(direct.contractVersion).toBe('1.1');
    expect(Math.round(direct.score * 10) / 10).toBe(result.score);
    expect(direct.retentionRiskLevel).toMatch(/low|medium|high/);
  });

  it('RISK: a participant from every site is scored by the model (each site maps to a known category)', async () => {
    const { h, actor } = fresh();
    for (const id of ['P-A-001', 'P-B-001', 'P-C-001', 'P-D-001', 'P-E-001']) {
      const r = await h.s.risk.assess({ entityType: 'patient', entityId: id }, actor);
      expect(r.fallback.used, id).toBe(false);
      expect(r.engine.name, id).toBe('retention-dropout-risk');
    }
  });

  it('RISK: a participant whose site has no model category is NOT sent; the baseline answers with a precise reason', async () => {
    const { h, actor } = fresh();
    h.ctx.db.prepare(`UPDATE trial_sites SET ml_site_category = NULL WHERE site_code = 'SITE-A'`).run();
    const before = logSize();
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, actor);
    expect(r.fallback).toMatchObject({ used: true, reason: 'invalid_request: missing required features: site_id' });
    expect(r.engine.name).toBe('baseline-rules');
    expect(pythonRequestsSince(before)).toEqual([]);                       // nothing reached Python
  });

  it('RISK: a site category the model does not know is refused by Python with HTTP 422, and the reason is diagnosable (no internals)', async () => {
    const { h, actor } = fresh();
    h.ctx.db.prepare(`UPDATE trial_sites SET ml_site_category = 'SITE-Z' WHERE site_code = 'SITE-A'`).run();
    const before = logSize();
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, actor);
    expect(r.fallback.used).toBe(true);
    expect(r.fallback.reason).toBe('model_error: Model service rejected the request (HTTP 422: unknown_site_category)');
    expect(r.engine.name).toBe('baseline-rules');
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/risk/predict', status: 422 }]);   // it really reached Python, which really said 422
    expect(r.fallback.reason).not.toMatch(/SITE-|Traceback|File "/);
  });

  it('RISK: wrong ML_API_KEY -> HTTP 401 -> baseline, with a reason that does not leak the key', async () => {
    const { h, actor } = fresh({ ML_API_KEY: 'definitely-not-the-key' });
    const before = logSize();
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, actor);
    expect(r.fallback).toMatchObject({ used: true });
    expect(r.fallback.reason).toMatch(/^unauthorized: Model service rejected the credentials \(HTTP 401/);
    expect(r.fallback.reason).not.toContain('definitely-not-the-key');
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/risk/predict', status: 401 }]);
  });

  it('RISK: Python service unavailable -> baseline fallback, the API call itself still succeeds', async () => {
    const { h, actor } = fresh({ ML_RISK_URL: 'http://127.0.0.1:1' });
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, actor);
    expect(r.fallback).toMatchObject({ used: true });
    expect(r.fallback.reason).toMatch(/^unavailable: Model service is unreachable/);
    expect(r.engine.name).toBe('baseline-rules');
    expect(h.ctx.db.prepare(`SELECT fallback_used FROM risk_assessments WHERE id = ?`).get(r.entityId) ?? true).toBeTruthy();
  });

  // ---------------------------------------------------------------- integrity
  it('INTEGRITY: a full trialData scan is accepted (no 422), contract 1.1, and detects the injected Site C anomalies', async () => {
    const { h, r, actor } = fresh();
    const before = logSize();
    const t0 = Date.now();
    const scan = await h.s.integrity.scan({ windowHours: 168 }, actor);
    const ms = Date.now() - t0;
    expect(scan.fallback).toEqual({ used: false });
    expect(scan.engine.name).toBe('trialguard-integrity');
    expect(scan.coverage).toMatchObject({ trialsScanned: 1, sitesSkippedNoTimezone: [] });
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/integrity/predict', status: 200 }]);   // no unexpected 422
    console.log(`[live] full scan of 2400 visits / 300 participants / 48 ECGs took ${ms} ms`);

    // Site C's injected late-night unverified batch: exactly the ground-truth visits, nothing else, are flagged as multi-signal
    const flagged = new Set(alerts(h, `rule_id = 'visit.multiple_integrity_signals'`).map((a) => a.entity_id));
    expect(flagged).toEqual(gt('unverified_batch_late_night_entry'));
    // re-used ECG images: every cluster consists only of ground-truth visits, and they are all found
    const clusters = alerts(h, `rule_id = 'ecg.duplicate_image'`);
    expect(clusters.length).toBeGreaterThanOrEqual(6);
    const clusterVisits = new Set(clusters.flatMap((c) => (JSON.parse(c.details).visitIds as string[])));
    expect(clusterVisits).toEqual(gt('reused_ecg_image'));
    for (const c of clusters) expect(JSON.parse(c.details)).toMatchObject({ crossParticipant: true });
    // the site-level verdict names Site C only, by the backend's own site id
    const siteLevel = alerts(h, `entity_type = 'site'`);
    expect(new Set(siteLevel.map((a) => a.entity_id))).toEqual(new Set([r.sites['SITE-C']]));
    expect(siteLevel.find((a) => a.rule_id === 'site.multiple_integrity_signals')).toMatchObject({ severity: 'high' });
    for (const id of ['site.bp_digit_preference', 'site.low_bp_variance', 'site.late_night_entries', 'site.delayed_entries', 'site.missing_otp_rate', 'site.rapid_entry_cluster']) {
      expect(siteLevel.map((a) => a.rule_id), id).toContain(id);
    }
    // wording: review prompts, never accusations
    // (a negation such as "not proof of fraud" is fine; an assertion of fraud/guilt is not)
    const text = JSON.stringify(h.ctx.db.prepare('SELECT message FROM integrity_alerts').all()).toLowerCase();
    expect(text).not.toMatch(/fraudulent|committed fraud|is fraud|guilty|cheat/);
    // honest sites produce no site-level findings and no multi-signal visits
    expect([...flagged].every((id) => id.startsWith('V-C-'))).toBe(true);
  });

  it('INTEGRITY: findings are persisted de-duplicated, so scanning again raises nothing new', async () => {
    const { h, actor } = fresh();
    const first = await h.s.integrity.scan({ windowHours: 168 }, actor);
    const second = await h.s.integrity.scan({ windowHours: 168 }, actor);
    expect(first.newAlerts).toBe(44);
    expect(second.newAlerts).toBe(0);
    expect(second.existingAlerts).toBe(44);
  });

  it('TIMEZONE: the same timestamps are judged on the SITE-LOCAL clock (Asia/Kolkata flags late-night entries, UTC does not)', async () => {
    const kolkata = fresh();
    await kolkata.h.s.integrity.scan({ windowHours: 168 }, kolkata.actor);
    expect(alerts(kolkata.h, `rule_id = 'site.late_night_entries'`)).toHaveLength(1);
    const utc = fresh();
    utc.h.ctx.db.prepare(`UPDATE trial_sites SET timezone = 'UTC'`).run();
    await utc.h.s.integrity.scan({ windowHours: 168 }, utc.actor);
    expect(alerts(utc.h, `rule_id = 'site.late_night_entries'`)).toHaveLength(0);
    // the visit-level 'late night' signal disappears too (the other signals still flag those visits)
    const lateNight = (x: typeof kolkata) => alerts(x.h, `rule_id = 'visit.multiple_integrity_signals'`).filter((a) => /late at night/.test(JSON.stringify(a))).length;
    expect(lateNight(kolkata)).toBeGreaterThan(0);
    expect(lateNight(utc)).toBe(0);
  });

  it('DROPOUT: participants[].droppedOut comes from enrollment status and drives the retention statistic', async () => {
    const real = fresh();
    await real.h.s.integrity.scan({ windowHours: 168 }, real.actor);
    expect(alerts(real.h, `rule_id = 'site.high_retention'`)).toHaveLength(1);          // Site C: 0 dropouts vs 13-23 elsewhere
    const none = fresh();
    none.h.ctx.db.prepare(`UPDATE enrollments SET status = 'completed' WHERE status = 'withdrawn'`).run();   // nobody dropped out anywhere
    const td = buildTrialData(none.h.ctx.db, none.r.trialId, new Date()).trialData!;
    expect(td.participants.every((p) => p.droppedOut === false)).toBe(true);
    await none.h.s.integrity.scan({ windowHours: 168 }, none.actor);
    expect(alerts(none.h, `rule_id = 'site.high_retention'`)).toHaveLength(0);
    const sent = buildTrialData(real.h.ctx.db, real.r.trialId, new Date()).trialData!;
    expect(sent.participants.filter((p) => p.droppedOut)).toHaveLength(70);              // 16 + 18 + 23 + 13 from the dataset
  });

  it('OTP EXCEPTION: a documented exception reaches Python as otpVerified=false + reason (evidence only); undocumented ones stay undocumented', async () => {
    const documented = [...gt('unverified_batch_late_night_entry')].slice(0, 3);
    const { h, actor } = fresh({}, { documentedOtpExceptionVisitIds: documented });
    const td = buildTrialData(h.ctx.db, h.ctx.db.prepare('SELECT id FROM trials').get() ? (h.ctx.db.prepare('SELECT id FROM trials').get() as { id: string }).id : '', new Date()).trialData!;
    const byId = new Map(td.visits.map((v) => [v.visitId, v]));
    for (const id of documented) expect(byId.get(id)).toMatchObject({ status: 'completed', otpVerified: false, otpExceptionReason: 'device_offline' });
    const undocumented = [...gt('unverified_batch_late_night_entry')].find((id) => !documented.includes(id))!;
    expect(byId.get(undocumented)).toMatchObject({ otpVerified: false, otpExceptionReason: null });
    expect(byId.get('V-A-001-01')).toMatchObject({ otpVerified: true, otpExceptionReason: null });
    await h.s.integrity.scan({ windowHours: 168 }, actor);
    // a documented exception never hides or lowers the finding: all 18 are still flagged
    expect(new Set(alerts(h, `rule_id = 'visit.multiple_integrity_signals'`).map((a) => a.entity_id))).toEqual(gt('unverified_batch_late_night_entry'));
    expect(JSON.stringify(alerts(h).map((a) => a.details))).toContain('device_offline');
  });

  it('ECG: missing, unreadable and path-traversal image references become ecg.file_unavailable findings; the scan carries on', async () => {
    const { h, actor } = fresh();
    h.ctx.db.prepare(`UPDATE visit_ecgs SET file_ref = 'ecgs/does_not_exist.png' WHERE id = 'ECGR-0001'`).run();
    h.ctx.db.prepare(`UPDATE visit_ecgs SET file_ref = '../../../../etc/passwd' WHERE id = 'ECGR-0002'`).run();
    const before = logSize();
    const scan = await h.s.integrity.scan({ windowHours: 168 }, actor);
    expect(scan.fallback.used).toBe(false);
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/integrity/predict', status: 200 }]);
    const missing = alerts(h, `rule_id = 'ecg.file_unavailable'`);
    expect(missing.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(missing)).not.toContain('/etc/passwd');              // the traversal target is neither read nor echoed
    expect(alerts(h, `rule_id = 'visit.multiple_integrity_signals'`)).toHaveLength(18);   // the rest of the scan is unaffected
  });

  it('INVALID PAYLOAD: the backend refuses to send a request Python would reject, and Python itself answers 422 to the same request', async () => {
    const { h, r } = fresh();
    const td = buildTrialData(h.ctx.db, r.trialId, new Date()).trialData!;
    const bad: IntegrityScanRequest = {
      contractVersion: CONTRACT_VERSION, requestId: 'bad-1', windowStart: new Date(Date.now() - 1000).toISOString(), windowEnd: new Date().toISOString(), events: [], reimbursements: [], openVisits: [],
      chain: { valid: true, eventsChecked: 0, errorCount: 0, firstError: null }, trialData: { ...td, sites: td.sites.map((s) => ({ ...s, timezone: 'Mars/Olympus' })) },
    };
    // (1) backend: validated before sending -> baseline with a precise reason, nothing sent
    const before = logSize();
    const viaBackend = await h.ctx.ml.integrity.scan(bad);
    expect(viaBackend.fallback.used).toBe(true);
    expect(viaBackend.fallback.reason).toMatch(/^invalid_request: trialData failed validation \(.*timezone/);
    expect(pythonRequestsSince(before)).toEqual([]);
    // (2) Python: the same bytes are rejected with 422 invalid_request and a field path
    const raw = await fetch(`${URL}/v1/integrity/predict`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(bad) });
    expect(raw.status).toBe(422);
    const body = await raw.json() as any;
    expect(body.error.code).toBe('invalid_request');
    expect(JSON.stringify(body.error.details)).toContain('timezone');
  });

  it('LARGE SCAN: ~19,000 visits across 40 sites in one request is accepted, within the integrity timeout, and still finds the anomalies', async () => {
    const { h, r } = fresh();
    const base = buildTrialData(h.ctx.db, r.trialId, new Date()).trialData!;
    const copies = 8;
    const big = {
      scope: base.scope,
      sites: [] as typeof base.sites, participants: [] as typeof base.participants, visits: [] as typeof base.visits, ecgs: [] as NonNullable<typeof base.ecgs>,
    };
    for (let c = 0; c < copies; c++) {
      const sfx = c === 0 ? '' : `~${c}`;
      big.sites.push(...base.sites.map((s) => ({ ...s, siteId: s.siteId + sfx, siteCode: s.siteCode + sfx })));
      big.participants.push(...base.participants.map((p) => ({ ...p, participantId: p.participantId + sfx, siteId: p.siteId + sfx })));
      big.visits.push(...base.visits.map((v) => ({ ...v, visitId: v.visitId + sfx, participantId: v.participantId + sfx, siteId: v.siteId + sfx, ecgRecordId: c === 0 ? v.ecgRecordId : null })));
    }
    big.ecgs.push(...(base.ecgs ?? []));
    const request: IntegrityScanRequest = {
      contractVersion: CONTRACT_VERSION, requestId: 'large-1', windowStart: new Date(Date.now() - 1000).toISOString(), windowEnd: new Date().toISOString(), events: [], reimbursements: [], openVisits: [],
      chain: { valid: true, eventsChecked: 0, errorCount: 0, firstError: null }, trialData: big,
    };
    const bytes = Buffer.byteLength(JSON.stringify(request));
    const t0 = Date.now();
    const res = await new HttpIntegrityModel({ baseUrl: URL!, timeoutMs: 60000, apiKey: KEY }).detect(request);
    const ms = Date.now() - t0;
    console.log(`[live] large scan: ${big.visits.length} visits, ${big.sites.length} sites, ${(bytes / 1e6).toFixed(1)} MB body -> ${ms} ms, ${res.findings.length} findings`);
    expect(big.visits.length).toBeGreaterThan(19000);
    expect(res.contractVersion).toBe('1.1');
    expect(res.findings.length).toBeGreaterThan(40);
    expect(res.findings.some((f) => f.ruleId === 'site.multiple_integrity_signals')).toBe(true);
  }, 120000);

  it('INTEGRITY TIMEOUT: a call slower than the integrity budget falls back to the baseline engine, marked as fallback', async () => {
    const { h, actor } = fresh({ ML_INTEGRITY_TIMEOUT_MS: '100' });     // the real scan takes seconds
    const scan = await h.s.integrity.scan({ windowHours: 168 }, actor);
    expect(scan.fallback.used).toBe(true);
    expect(scan.fallback.reason).toMatch(/^timeout:/);
    expect(scan.engine.name).toBe('baseline-integrity-rules');
    for (const a of alerts(h)) expect(a.source).toBe('baseline-integrity-rules');
  });

  it('INTEGRITY: wrong key -> 401 -> baseline with a reason that does not leak the key; service down -> baseline', async () => {
    const wrong = fresh({ ML_API_KEY: 'wrong-integrity-key' });
    const a = await wrong.h.s.integrity.scan({ windowHours: 168 }, wrong.actor);
    expect(a.fallback.used).toBe(true);
    expect(a.fallback.reason).toMatch(/^unauthorized: .*HTTP 401/);
    expect(a.fallback.reason).not.toContain('wrong-integrity-key');
    const down = fresh({ ML_INTEGRITY_URL: 'http://127.0.0.1:1' });
    const b = await down.h.s.integrity.scan({ windowHours: 168 }, down.actor);
    expect(b.fallback).toMatchObject({ used: true });
    expect(b.fallback.reason).toMatch(/^unavailable:/);
    expect(b.engine.name).toBe('baseline-integrity-rules');
  });

  it('FALLBACK vs SUCCESS is distinguishable: ML off -> baseline with no fallback flag; ML on -> model with no fallback flag', async () => {
    const off = fresh({ ML_RISK_ENABLED: 'false', ML_INTEGRITY_ENABLED: 'false' });
    const r = await off.h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, off.actor);
    expect(r).toMatchObject({ engine: { name: 'baseline-rules' }, fallback: { used: false } });
    const s = await off.h.s.integrity.scan({ windowHours: 168 }, off.actor);
    expect(s).toMatchObject({ engine: { name: 'baseline-integrity-rules' }, fallback: { used: false } });
    const on = fresh();
    expect((await on.h.s.risk.assess({ entityType: 'patient', entityId: 'P-A-001' }, on.actor)).engine.name).toBe('retention-dropout-risk');
  });

  it('a site without a timezone is left out of the scan (with its participants/visits/ECGs) and reported, instead of making Python reject the call', async () => {
    const { h, r, actor } = fresh();
    h.ctx.db.prepare(`UPDATE trial_sites SET timezone = NULL WHERE site_code = 'SITE-A'`).run();
    const before = logSize();
    const scan = await h.s.integrity.scan({ windowHours: 168 }, actor);
    expect(scan.fallback.used).toBe(false);
    expect(pythonRequestsSince(before)).toEqual([{ path: '/v1/integrity/predict', status: 200 }]);
    expect(scan.coverage?.sitesSkippedNoTimezone).toEqual([r.sites['SITE-A']]);
    const audit = h.ctx.db.prepare(`SELECT metadata FROM audit_logs WHERE action = 'integrity.scan_completed'`).get() as { metadata: string };
    expect(JSON.parse(audit.metadata).sitesSkippedNoTimezone).toEqual([r.sites['SITE-A']]);
    expect(alerts(h, `rule_id = 'visit.multiple_integrity_signals'`)).toHaveLength(18);     // Site C unaffected
  });
});
