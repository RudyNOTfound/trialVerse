// @vitest-environment node
/**
 * LIVE contract test: the frontend's own API modules and helpers against a running TrialVerse backend that is wired to the Python ML
 * service (nothing mocked). Skipped unless TRIALVERSE_LIVE_API is set. It is a test of the DATA path the UI uses, not of the browser.
 *
 *   TRIALVERSE_LIVE_API=http://127.0.0.1:3100/api/v1 TRIALVERSE_LIVE_PASSWORD=<demo password> npm test -- src/test/live.test.ts
 *
 * Needs the seeded demo plus `npm run ml:demo-import`, the backend started with ML_RISK_ENABLED / ML_INTEGRITY_ENABLED, and the ML service.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from '@/api/audit';
import { ApiError, http, tokenStore } from '@/api/client';
import { fetchAll } from '@/api/fetchAll';
import { integrityApi } from '@/api/integrity';
import { patientsApi } from '@/api/patients';
import { riskApi } from '@/api/risk';
import { statsApi } from '@/api/stats';
import { enrollmentsApi, trialsApi } from '@/api/trials';
import { authApi } from '@/api/auth';
import { factorsOf, riskSource, scopeAlerts, summariseSites } from '@/lib/ml';
import type { Enrollment, Trial } from '@/types/api';

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BASE = env.TRIALVERSE_LIVE_API;
const PASSWORD = env.TRIALVERSE_LIVE_PASSWORD ?? '';
const live = !!BASE && !!PASSWORD;

// the API client keeps its token in localStorage; a minimal in-memory one is enough in node
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0 } as Storage;

async function loginAs(email: string) {
  tokenStore.clear();
  const res = await authApi.login(email, PASSWORD);
  tokenStore.set(res.token);
  return res.user;
}
const denied = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); expect(e).toBeInstanceOf(ApiError); return (e as ApiError).status; };

describe.skipIf(!live)('LIVE: frontend API layer -> TypeScript backend -> Python ML service', () => {
  let trial: Trial; let ramesh: Enrollment;
  beforeAll(async () => {
    http.defaults.baseURL = BASE; http.defaults.adapter = 'http';
    await loginAs('investigator1@trialguard.demo');
    trial = (await fetchAll((page) => trialsApi.list({ page, pageSize: 100 }))).find((t) => t.code === 'GLU-301')!;
    expect(trial, 'GLU-301 must be seeded (npm run ml:demo-import)').toBeTruthy();
    ramesh = (await fetchAll((page) => enrollmentsApi.list({ trialId: trial.id, page, pageSize: 100 }))).find((e) => e.patientCode === 'P-A-001')!;
    expect(ramesh, 'Ramesh (P-A-001) must be enrolled in GLU-301').toBeTruthy();
  }, 60_000);

  it('Workflow A: assessing Ramesh returns the trained model\'s HIGH result with its contributing factors', async () => {
    await loginAs('investigator1@trialguard.demo');
    const a = await riskApi.assess('patient', ramesh.patientId);
    expect(riskSource(a)).toBe('model');
    expect(a).toMatchObject({ entityName: 'Ramesh Verma', level: 'high', fallback: { used: false }, engine: { name: 'retention-dropout-risk' } });
    expect(a.score).toBeGreaterThan(60); expect(a.score).toBeLessThan(80);
    const f = factorsOf(a);
    expect(f.map((x) => x.name)).toEqual(expect.arrayContaining(['missed_reminders', 'reimbursement_delay_days', 'daily_wage_worker', 'distance_km']));
    expect(f.find((x) => x.name === 'missed_reminders')).toMatchObject({ direction: 'raises' });
    expect(a.explanation).toMatch(/not validated for clinical use/i);
    // the stored assessment is what the participant table will show
    const stored = (await riskApi.list({ entityType: 'patient', entityId: ramesh.patientId, pageSize: 5 })).items;
    expect(stored.some((s) => s.id === a.id)).toBe(true);
  }, 60_000);

  it('Workflow B: a trial scan reports Site C\'s injected anomalies from the ML integrity service', async () => {
    await loginAs('investigator1@trialguard.demo');
    const r = await integrityApi.scan(168, trial.id);
    expect(r.fallback.used).toBe(false);
    expect(r.engine.name).toBe('trialguard-integrity');
    expect(r.coverage).toMatchObject({ trialsScanned: 1, sitesSkippedNoTimezone: [] });
    const sites = await trialsApi.sites(trial.id);
    const alerts = await fetchAll((page) => integrityApi.alerts({ page, pageSize: 100, sort: 'detectedAt', order: 'desc' }));
    const { trial: mine, platform } = scopeAlerts(alerts, sites.map((s) => s.id));
    expect(mine.length).toBeGreaterThan(0);
    expect(platform.every((a) => !['ecg_cluster'].includes(a.entityType))).toBe(true);
    const rows = summariseSites(mine.filter((a) => a.status === 'open'), sites);
    expect(rows[0]!.site.siteCode).toBe('SITE-C');
    expect(rows[0]!.highest).toBe('high');
    expect(rows[0]!.rules.map((x) => x.ruleId)).toEqual(expect.arrayContaining(['site.bp_digit_preference', 'site.low_bp_variance', 'site.late_night_entries', 'ecg.duplicate_image', 'visit.multiple_integrity_signals']));
    for (const other of rows.slice(1)) expect(['low', null], other.site.siteCode).toContain(other.highest);   // the honest sites raise at most low-severity data-quality notes
    const cluster = mine.find((a) => a.entityType === 'ecg_cluster')!;
    expect(typeof cluster.details.recommendedReviewAction).toBe('string');      // evidence for the finding dialog
  }, 120_000);

  it('authorization is enforced by the backend exactly as the UI assumes', async () => {
    // a coordinator is staff: may assess risk, may NOT use integrity (so the integrity pages are not offered to that role)
    await loginAs('coordinator1@trialguard.demo');
    expect((await riskApi.assess('patient', ramesh.patientId)).entityId).toBe(ramesh.patientId);
    expect(await denied(integrityApi.scan(168, trial.id))).toBe(403);
    expect(await denied(integrityApi.alerts())).toBe(403);
    expect(await denied(statsApi.sponsor())).toBe(403);
    // a participant sees neither risk nor integrity, nor another participant's record
    const me = await loginAs('patient1@trialguard.demo');
    expect(me.role).toBe('patient');
    expect(await denied(riskApi.list())).toBe(403);
    expect(await denied(riskApi.assess('patient', ramesh.patientId))).toBe(403);
    expect(await denied(integrityApi.alerts())).toBe(403);
    expect(await denied(integrityApi.scan())).toBe(403);
    expect(await denied(auditApi.list())).toBe(403);
    expect(await denied(statsApi.sponsor())).toBe(403);
    expect(await denied(patientsApi.get(ramesh.patientId))).toBe(403);
    expect((await patientsApi.me()).id).not.toBe(ramesh.patientId);
  }, 60_000);
});
