import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION, MlError, riskPredictionResponseSchema,
  type IntegrityModel, type IntegrityScanRequest, type RiskModel, type RiskPredictionRequest,
} from '../src/ml/contracts';
import { HttpRiskModel } from '../src/ml/httpModels';
import { bearer, completeModelInputs, makeHarness, makeScenario, type Harness } from './helpers';

/** A throw-away model service speaking the documented HTTP contract. Behaviour is switchable per test. */
type Mode = 'ok' | 'http500' | 'badjson' | 'badschema' | 'wrongid' | 'slow' | 'integrity-ok';
let mode: Mode = 'ok';
let lastBody: any = null;
let lastAuth: string | undefined;
let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : null;
      lastAuth = req.headers.authorization;
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      if (mode === 'http500') return send(500, { error: 'boom' });
      if (mode === 'badjson') return send(200, 'not json at all');
      if (mode === 'slow') return void setTimeout(() => send(200, {}), 1500);
      if (req.url === '/v1/risk/predict') {
        if (mode === 'badschema') return send(200, { contractVersion: '1.0', requestId: lastBody.requestId, modelName: 'm', modelVersion: '1', score: 250, explanation: 'x' });
        return send(200, {
          contractVersion: CONTRACT_VERSION, requestId: mode === 'wrongid' ? 'other' : lastBody.requestId, modelName: 'gbm-risk', modelVersion: '0.3.1', score: 82.46, confidence: 0.9,
          factors: [{ name: 'otp_failure_rate', contribution: 41.2, detail: 'high' }, { name: 'claim_velocity', contribution: 12 }], explanation: 'Model flagged elevated OTP failure rate.',
        });
      }
      if (req.url === '/v1/integrity/predict') {
        return send(200, {
          contractVersion: CONTRACT_VERSION, requestId: lastBody.requestId, modelName: 'iso-forest', modelVersion: '2.0.0',
          findings: [{ ruleId: 'ml.anomalous_actor', entityType: 'user', entityId: 'u-1', severity: 'high', score: 0.97, message: 'Actor behaviour is anomalous', details: { z: 4.2 }, dedupeKey: 'w1' }],
        });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** makeScenario + complete v1.1 participant inputs, so the ML path (not the "incomplete participant" fallback) is exercised. */
async function scenario(h: Harness) { const sc = await makeScenario(h); completeModelInputs(h, sc); return sc; }

const mlEnv = (extra: Record<string, string> = {}) => ({ ML_RISK_ENABLED: 'true', ML_RISK_URL: url, ML_INTEGRITY_ENABLED: 'true', ML_INTEGRITY_URL: url, ML_TIMEOUT_MS: '400', ...extra });

describe('ML integration contracts', () => {
  it('uses the baseline engines by default (ML disabled) and says so', async () => {
    const h = makeHarness();
    const sc = await scenario(h);
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: sc.patient.id }, sc.admin.actor);
    expect(r.engine.name).toBe('baseline-rules');
    expect(r.fallback.used).toBe(false);
  });

  it('requires a URL when an ML engine is enabled', () => {
    expect(() => makeHarness({ env: { ML_RISK_ENABLED: 'true' } })).toThrow(/ML_RISK_URL/);
  });

  it('sends the documented request envelope and stores the model response through the HTTP model service', async () => {
    mode = 'ok';
    const h = makeHarness({ env: mlEnv({ ML_API_KEY: 'secret-key' }) });
    const sc = await scenario(h);
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: sc.patient.id }, sc.admin.actor);
    expect(lastBody).toMatchObject({ contractVersion: CONTRACT_VERSION, entityType: 'patient', entityId: sc.patient.id, featureSchemaVersion: '2' });
    expect(lastBody.requestId).toEqual(expect.any(String));
    expect(Object.keys(lastBody.features)).toEqual(expect.arrayContaining(['patient_failed_otp_24h', 'patient_visits_7d', 'patient_missed_90d']));
    expect(lastAuth).toBe('Bearer secret-key');
    expect(r).toMatchObject({ engine: { name: 'gbm-risk', version: '0.3.1' }, score: 82.5, level: 'critical', fallback: { used: false, reason: null } });
    expect(r.triggeredRules[0]).toMatchObject({ ruleId: 'ml:otp_failure_rate', weight: 41.2 });
    expect(r.explanation).toMatch(/Model flagged/);
  });

  it.each<[Mode, RegExp]>([
    ['http500', /model_error/],
    ['badjson', /invalid_response/],
    ['badschema', /invalid_response.*score/],
    ['wrongid', /invalid_response.*requestId/],
    ['slow', /timeout/],
  ])('falls back to the baseline engine when the model service misbehaves (%s)', async (m, reasonRe) => {
    mode = m;
    const h = makeHarness({ env: mlEnv() });
    const sc = await scenario(h);
    const r = await h.s.risk.assess({ entityType: 'patient', entityId: sc.patient.id }, sc.admin.actor);
    expect(r.engine.name).toBe('baseline-rules');
    expect(r.fallback.used).toBe(true);
    expect(r.fallback.reason).toMatch(reasonRe);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('falls back when the model service is unreachable, never failing the API request', async () => {
    const h = makeHarness({ env: mlEnv({ ML_RISK_URL: 'http://127.0.0.1:1' }) });
    const sc = await scenario(h);
    const res = await h.api.post('/api/v1/risk/assessments').set(bearer(sc.admin)).send({ entityType: 'patient', entityId: sc.patient.id });
    expect(res.status).toBe(201);
    expect(res.body.data.fallback).toMatchObject({ used: true });
    expect(res.body.data.fallback.reason).toMatch(/unavailable/);
  });

  it('integrates an in-process RiskModel without touching business logic', async () => {
    const calls: RiskPredictionRequest[] = [];
    const model: RiskModel = {
      name: 'stub-risk', version: '9.9.9',
      async predict(req) { calls.push(req); return { contractVersion: CONTRACT_VERSION, requestId: req.requestId, modelName: 'stub-risk', modelVersion: '9.9.9', score: 61, factors: [], explanation: 'stub' }; },
    };
    const h = makeHarness({ riskModel: model });
    const sc = await scenario(h);
    const res = await h.api.post('/api/v1/risk/assessments').set(bearer(sc.admin)).send({ entityType: 'visit', entityId: sc.visit.id });
    expect(res.body.data).toMatchObject({ engine: { name: 'stub-risk' }, score: 61, level: 'high', fallback: { used: false } });
    expect(calls[0].features).toHaveProperty('visit_otp_failed_attempts');
  });

  it('falls back when an in-process model throws', async () => {
    const model: RiskModel = { name: 'bad', version: '1', async predict() { throw new Error('GPU on fire'); } };
    const h = makeHarness({ riskModel: model });
    const sc = await scenario(h);
    const r = await h.s.risk.assess({ entityType: 'visit', entityId: sc.visit.id }, sc.admin.actor);
    expect(r.fallback.used).toBe(true);
    expect(r.fallback.reason).toMatch(/GPU on fire/);
    expect(r.engine.name).toBe('baseline-rules');
  });

  it('integrates an ML integrity model: findings become de-duplicated alerts attributed to the model', async () => {
    mode = 'integrity-ok';
    const h = makeHarness({ env: mlEnv() });
    const sc = await scenario(h);
    const first = await h.api.post('/api/v1/integrity/scans').set(bearer(sc.admin)).send({});
    expect(first.body.data).toMatchObject({ engine: { name: 'iso-forest' }, fallback: { used: false }, newAlerts: 1 });
    expect(first.body.data.alerts[0]).toMatchObject({ ruleId: 'ml.anomalous_actor', severity: 'high', source: 'iso-forest' });
    // The request carries the documented payload.
    expect(lastBody).toMatchObject({ contractVersion: CONTRACT_VERSION });
    expect(lastBody.events.length).toBeGreaterThan(0);
    expect(lastBody.chain).toMatchObject({ valid: true });
    expect(Object.keys(lastBody)).toEqual(expect.arrayContaining(['windowStart', 'windowEnd', 'events', 'reimbursements', 'openVisits', 'chain']));
    const second = await h.api.post('/api/v1/integrity/scans').set(bearer(sc.admin)).send({});
    expect(second.body.data).toMatchObject({ newAlerts: 0, existingAlerts: 1 });
  });

  it('falls back to the baseline integrity engine when the ML integrity model fails', async () => {
    const model: IntegrityModel = { name: 'bad-int', version: '1', async detect(_r: IntegrityScanRequest) { throw new MlError('unavailable', 'down'); } };
    const h = makeHarness({ integrityModel: model });
    const sc = await scenario(h);
    const res = await h.api.post('/api/v1/integrity/scans').set(bearer(sc.admin)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.engine.name).toBe('baseline-integrity-rules');
    expect(res.body.data.fallback.used).toBe(true);
    expect(res.body.data.fallback.reason).toMatch(/unavailable/);
  });

  it('validates model responses against the published schema', () => {
    const ok = { contractVersion: '1.0', requestId: 'r', modelName: 'm', modelVersion: '1', score: 10, explanation: 'e' };
    expect(riskPredictionResponseSchema.parse(ok).factors).toEqual([]);
    expect(riskPredictionResponseSchema.safeParse({ ...ok, score: -1 }).success).toBe(false);
    expect(riskPredictionResponseSchema.safeParse({ ...ok, confidence: 2 }).success).toBe(false);
    expect(riskPredictionResponseSchema.safeParse({ ...ok, modelName: '' }).success).toBe(false);
  });

  it('rejects incompatible contract major versions from a model', async () => {
    const model = new HttpRiskModel({ baseUrl: url, timeoutMs: 400, fetchImpl: async () => new Response(JSON.stringify({ contractVersion: '2.0', requestId: 'r', modelName: 'm', modelVersion: '1', score: 1, explanation: '' }), { status: 200 }) });
    await expect(model.predict({ contractVersion: '1.0', requestId: 'r', entityType: 'visit', entityId: 'v', featureSchemaVersion: '1', features: {}, requestedAt: '' }))
      .rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
