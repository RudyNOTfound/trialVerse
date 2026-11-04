/**
 * The ML demo importer (src/seed/mlDemoImport.ts): valid UUIDs, intact references, kept subject codes, login-capable accounts,
 * idempotent re-runs, and import on top of the regular `seed`. Everything goes through the real application (database, services,
 * Express app + supertest). No Python service is needed: the model-dependent assertions (Ramesh HIGH, Site C findings) live in
 * tests/live/ml-live.test.ts, which runs the same importer against the real FastAPI service.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { demoDataAllowed } from '../src/config/env';
import { openDatabase } from '../src/db/connection';
import { DEMO_PASSWORD, seed } from '../src/seed/seed';
import { ML_DEMO_TRIAL_CODE, importMlDemo, mlDemoId, readCsv } from '../src/seed/mlDemoImport';
import { buildFeatures } from '../src/modules/risk/features';
import { makeHarness, type Harness } from './helpers';

const DATA = 'ml-service/generated_data';
const have = fs.existsSync(`${DATA}/demo/visits.csv`);
const api = '/api/v1';
const uuid = z.string().uuid();
const ACCOUNTS = ['admin@trialguard.demo', 'coordinator1@trialguard.demo', 'investigator1@trialguard.demo'];

const imp = (h: Harness, extra: Partial<Parameters<typeof importMlDemo>[1]> = {}) => importMlDemo(h.ctx.db, { dataDir: DATA, bcryptRounds: 4, ...extra });
const count = (h: Harness, table: string) => (h.ctx.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const TABLES = ['users', 'patients', 'trials', 'trial_sites', 'enrollments', 'visits', 'visit_measurements', 'visit_ecgs', 'visit_reminders', 'adverse_event_reports', 'visit_otp_exceptions', 'reimbursements', 'audit_logs'];
const snapshot = (h: Harness) => Object.fromEntries(TABLES.map((t) => [t, count(h, t)]));
const login = (h: Harness, email: string, password = DEMO_PASSWORD) => h.api.post(`${api}/auth/login`).send({ email, password });

describe.skipIf(!have)('ML demo importer', () => {
  it('every primary key it creates is a valid UUID, and the generator ids survive as subject_code / site_code', () => {
    const h = makeHarness(); imp(h);
    for (const [table, col] of [['users', 'id'], ['patients', 'id'], ['trials', 'id'], ['trial_sites', 'id'], ['enrollments', 'id'], ['visits', 'id'], ['visit_measurements', 'visit_id'],
      ['visit_ecgs', 'id'], ['visit_reminders', 'id'], ['adverse_event_reports', 'id'], ['reimbursements', 'id']] as const) {
      const ids = (h.ctx.db.prepare(`SELECT ${col} AS id FROM ${table}`).all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids.length, table).toBeGreaterThan(0);
      expect(ids.filter((i) => !uuid.safeParse(i).success), `${table}: ids that are not UUIDs`).toEqual([]);
    }
    const p = h.ctx.db.prepare(`SELECT id, subject_code FROM patients WHERE subject_code = 'P-A-001'`).get() as { id: string; subject_code: string };
    expect(p.id).toBe(mlDemoId('patient', 'P-A-001'));
    expect(h.ctx.db.prepare(`SELECT COUNT(*) c FROM patients WHERE subject_code NOT GLOB 'P-[A-E]-[0-9][0-9][0-9]'`).get()).toEqual({ c: 0 });
    expect((h.ctx.db.prepare('SELECT site_code FROM trial_sites ORDER BY site_code').all() as Array<{ site_code: string }>).map((s) => s.site_code)).toEqual(['SITE-A', 'SITE-B', 'SITE-C', 'SITE-D', 'SITE-E']);
    expect(mlDemoId('patient', 'P-A-001')).toBe('ad3d67fd-32ee-5047-8736-4e6b5be504b2');                     // pinned: the same on every machine and every run
    expect(mlDemoId('patient', 'P-A-001')).not.toBe(mlDemoId('visit', 'P-A-001'));                          // kind is part of the identity
  });

  it('references are intact: foreign keys hold, and a visit agrees with its enrollment on patient, trial and site', () => {
    const h = makeHarness(); imp(h);
    expect(h.ctx.db.pragma('foreign_key_check')).toEqual([]);
    const bad = h.ctx.db.prepare(`SELECT COUNT(*) c FROM visits v JOIN enrollments e ON e.id = v.enrollment_id
      WHERE e.patient_id != v.patient_id OR e.trial_id != v.trial_id OR e.trial_site_id != v.trial_site_id`).get() as { c: number };
    expect(bad.c).toBe(0);
    const csv = { participants: readCsv(`${DATA}/demo/participants.csv`).length, visits: readCsv(`${DATA}/demo/visits.csv`).length, ecgs: readCsv(`${DATA}/demo/ecg_metadata.csv`).length };
    expect(count(h, 'patients')).toBe(csv.participants);
    expect(count(h, 'visits')).toBe(csv.visits);
    expect(count(h, 'visit_ecgs')).toBe(csv.ecgs);
    // an ECG belongs to the visit (and so the participant) the generator says it does
    const e = readCsv(`${DATA}/demo/ecg_metadata.csv`)[0]!;
    expect(h.ctx.db.prepare('SELECT visit_id FROM visit_ecgs WHERE id = ?').get(mlDemoId('ecg', e.ecg_record_id!))).toEqual({ visit_id: mlDemoId('visit', e.visit_id!) });
    // paid claims point at real visits/patients
    expect(h.ctx.db.prepare(`SELECT COUNT(*) c FROM reimbursements r JOIN visits v ON v.id = r.visit_id WHERE v.patient_id != r.patient_id`).get()).toEqual({ c: 0 });
    expect(count(h, 'reimbursements')).toBeGreaterThan(0);
  });

  it('demo accounts are real: a bcrypt hash (never "!"), and each can log in through the normal login endpoint', async () => {
    const h = makeHarness(); const r = imp(h);
    expect(r.createdUsers.sort()).toEqual([...ACCOUNTS].sort());
    for (const email of ACCOUNTS) {
      const row = h.ctx.db.prepare('SELECT password_hash, is_active FROM users WHERE email = ?').get(email) as { password_hash: string; is_active: number };
      expect(row.password_hash).toMatch(/^\$2[aby]\$04\$/);
      expect(row.is_active).toBe(1);
      const res = await login(h, email);
      expect(res.status, email).toBe(200);
      expect(res.body.data.token).toBeTruthy();
    }
    expect((await login(h, ACCOUNTS[0]!, 'Wrong-Password1')).status).toBe(401);
    expect(h.ctx.db.prepare(`SELECT COUNT(*) c FROM users WHERE password_hash = '!'`).get()).toEqual({ c: 0 });
    expect(h.s.audit.verify({ id: r.users.admin, role: 'admin' }).valid).toBe(true);
  });

  it('sites carry a timezone and a model category; participants carry the model inputs (distance, wage status, a resolved reminder)', () => {
    const h = makeHarness(); imp(h);
    const sites = h.ctx.db.prepare('SELECT site_code, timezone, ml_site_category FROM trial_sites ORDER BY site_code').all() as Array<{ site_code: string; timezone: string; ml_site_category: string }>;
    expect(sites).toHaveLength(5);
    for (const s of sites) expect(s).toMatchObject({ timezone: 'Asia/Kolkata', ml_site_category: s.site_code });
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM enrollments WHERE distance_to_site_km IS NULL').get()).toEqual({ c: 0 });
    expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM patients WHERE daily_wage_worker IS NULL').get()).toEqual({ c: 0 });
    expect(h.ctx.db.prepare(`SELECT COUNT(*) c FROM enrollments e WHERE NOT EXISTS (SELECT 1 FROM visit_reminders r WHERE r.enrollment_id = e.id AND r.outcome != 'sent')`).get()).toEqual({ c: 0 });
    // Ramesh's feature vector is complete and carries the values the dataset says
    const row = readCsv(`${DATA}/demo/participants.csv`).find((p) => p.participant_id === 'P-A-001')!;
    const f = buildFeatures(h.ctx.db, 'patient', mlDemoId('patient', 'P-A-001'));
    expect(f).toMatchObject({ site_id: 'SITE-A', distance_km: Number(row.distance_km), daily_wage_worker: Number(row.daily_wage_worker), missed_reminders: Number(row.missed_reminders) });
    expect(Object.entries(f).filter(([, v]) => v === undefined)).toEqual([]);
  });

  it('is idempotent: a second and third import change nothing (no duplicates, no new audit events, chain still valid)', () => {
    const h = makeHarness(); const first = imp(h);
    expect(first.alreadyImported).toBe(false);
    expect(first.participants).toBe(300);
    const after1 = snapshot(h);
    const again = imp(h); const third = imp(h);
    for (const r of [again, third]) {
      expect(r).toMatchObject({ alreadyImported: true, createdUsers: [], participants: 0, visits: 0, ecgs: 0, measurements: 0, exceptions: 0, reimbursements: 0 });
      expect(r.trialId).toBe(first.trialId);
      expect(r.users).toEqual(first.users);
    }
    expect(snapshot(h)).toEqual(after1);
    expect(h.s.audit.verify({ id: first.users.admin, role: 'admin' }).valid).toBe(true);
  });

  it('a re-run completes what is missing without touching what exists (a deleted row is restored, an edited row is left alone)', () => {
    const h = makeHarness(); imp(h);
    const pid = mlDemoId('patient', 'P-B-001');
    h.ctx.db.prepare('UPDATE patients SET first_name = ? WHERE id = ?').run('Edited', pid);
    h.ctx.db.prepare('DELETE FROM visit_ecgs WHERE id = ?').run(mlDemoId('ecg', 'ECGR-0001'));
    const r = imp(h);
    expect(r.ecgs).toBe(1);
    expect((h.ctx.db.prepare('SELECT first_name FROM patients WHERE id = ?').get(pid) as { first_name: string }).first_name).toBe('Edited');
  });

  it('works on top of the regular seed: seeded rows, accounts and logins are untouched, and the ML trial sits beside the seeded trials', async () => {
    const h = makeHarness();
    await seed(h.ctx);
    const before = snapshot(h);
    const hashes = h.ctx.db.prepare('SELECT email, password_hash FROM users ORDER BY email').all();
    const seededPatients = h.ctx.db.prepare('SELECT * FROM patients ORDER BY id').all();
    const seededTrials = h.ctx.db.prepare('SELECT * FROM trials ORDER BY id').all();

    const r = imp(h);
    expect(r.createdUsers).toEqual([]);                                     // the seeded accounts are reused, not duplicated
    expect(count(h, 'users')).toBe(before.users!);
    expect(h.ctx.db.prepare('SELECT email, password_hash FROM users ORDER BY email').all()).toEqual(hashes);
    expect(h.ctx.db.prepare(`SELECT id FROM patients WHERE subject_code LIKE 'P-____' OR subject_code LIKE 'P-_-___'`).all()).not.toHaveLength(0);
    expect(h.ctx.db.prepare(`SELECT * FROM patients WHERE id IN (${seededPatients.map(() => '?').join(',')}) ORDER BY id`).all(...seededPatients.map((p: any) => p.id))).toEqual(seededPatients);
    expect(h.ctx.db.prepare(`SELECT * FROM trials WHERE id IN (${seededTrials.map(() => '?').join(',')}) ORDER BY id`).all(...seededTrials.map((t: any) => t.id))).toEqual(seededTrials);
    expect(count(h, 'trials')).toBe(before.trials! + 1);
    expect(count(h, 'patients')).toBe(before.patients! + 300);
    expect(h.ctx.db.pragma('foreign_key_check')).toEqual([]);
    for (const email of ACCOUNTS) expect((await login(h, email)).status, email).toBe(200);

    const afterImport = snapshot(h);
    imp(h);                                                                  // and again: still nothing new
    expect(snapshot(h)).toEqual(afterImport);
    expect(h.s.audit.verify({ id: r.users.admin, role: 'admin' }).valid).toBe(true);
  }, 60000);

  it('refuses real conflicts instead of merging into them, and leaves the database untouched when it does', async () => {
    const a = makeHarness();
    await a.s.users.create({ email: ACCOUNTS[0]!, password: 'Passw0rd-Strong1', fullName: 'Not an admin', role: 'patient' }, null);
    expect(() => imp(a)).toThrow(/already exists with role 'patient'/);
    expect(count(a, 'trials')).toBe(0);

    const b = makeHarness();
    b.ctx.db.prepare(`INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'x@test.local', 'x', 'X', 'admin', 1, 'now', 'now')`).run();
    b.ctx.db.prepare(`INSERT INTO trials (id, code, title, sponsor, phase, status, created_by, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', ?, 'Other', 'Other', 'II', 'active', '11111111-1111-4111-8111-111111111111', 'now', 'now')`).run(ML_DEMO_TRIAL_CODE);
    const before = snapshot(b);
    expect(() => imp(b)).toThrow(/different trial already uses the code GLU-301/);
    expect(snapshot(b)).toEqual(before);

    const c = makeHarness();
    c.ctx.db.prepare(`INSERT INTO patients (id, subject_code, first_name, last_name, date_of_birth, sex, status, created_at, updated_at) VALUES ('33333333-3333-4333-8333-333333333333', 'P-A-001', 'Someone', 'Else', '1980-01-01', 'male', 'active', 'now', 'now')`).run();
    const cBefore = snapshot(c);
    expect(() => imp(c)).toThrow(/subject code P-A-001 already belongs to a different patient/);
    expect(snapshot(c)).toEqual(cBefore);                                    // the whole import rolled back (accounts, trial, sites included)
  });

  it('HTTP: an imported participant is reachable through the real routes by UUID (UUID validation is not weakened: the source id is still a 400)', async () => {
    const h = makeHarness(); imp(h);
    const token = (await login(h, 'admin@trialguard.demo')).body.data.token as string;
    const auth = { Authorization: `Bearer ${token}` };
    const pid = mlDemoId('patient', 'P-A-001');

    const got = await h.api.get(`${api}/patients/${pid}`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ id: pid, subjectCode: 'P-A-001' });

    const assessed = await h.api.post(`${api}/risk/assessments`).set(auth).send({ entityType: 'patient', entityId: pid });
    expect(assessed.status).toBe(201);                                       // ML is off in this suite: the baseline engine answers, honestly labelled
    expect(assessed.body.data).toMatchObject({ entityType: 'patient', entityId: pid, engine: { name: 'baseline-rules' } });

    const visitId = mlDemoId('visit', 'V-A-001-01');
    expect((await h.api.get(`${api}/visits/${visitId}`).set(auth)).status).toBe(200);
    expect((await h.api.post(`${api}/risk/assessments`).set(auth).send({ entityType: 'visit', entityId: visitId })).status).toBe(201);

    const bySourceId = await h.api.post(`${api}/risk/assessments`).set(auth).send({ entityType: 'patient', entityId: 'P-A-001' });
    expect(bySourceId.status).toBe(400);
    expect((await h.api.get(`${api}/patients/P-A-001`).set(auth)).status).toBe(400);
  });

  it('HTTP: an integrity scan of the imported trial runs through the real route', async () => {
    const h = makeHarness(); const r = imp(h);
    const token = (await login(h, 'admin@trialguard.demo')).body.data.token as string;
    const scan = await h.api.post(`${api}/integrity/scans`).set({ Authorization: `Bearer ${token}` }).send({ windowHours: 168, trialId: r.trialId });
    expect(scan.status).toBe(201);
    expect(scan.body.data.engine).toBeTruthy();
    expect(scan.body.data.fallback.used).toBe(false);                        // ML integrity is simply off here: the baseline answers, no fallback
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Production guard: the import must be impossible in production, through the exported function AND through the CLI.
// The guard itself is never mocked; tests change the real process.env.NODE_ENV and always restore it.
// ---------------------------------------------------------------------------------------------------------------------
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
  try { return fn(); } finally { if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV; }
}
afterEach(() => { expect(process.env.NODE_ENV).toBe(ORIGINAL_NODE_ENV); });   // no test may leak an environment change into the next

describe('ML demo import: production guard', () => {
  it('demoDataAllowed fails closed: only unset / development / test are allowed', () => {
    for (const ok of [undefined, '', 'development', 'test']) expect(demoDataAllowed({ NODE_ENV: ok }), String(ok)).toBe(true);
    for (const no of ['production', 'Production', 'PRODUCTION', ' production', 'prod', 'staging', 'live']) expect(demoDataAllowed({ NODE_ENV: no }), no).toBe(false);
    expect(demoDataAllowed({})).toBe(true);
  });

  it.skipIf(!have)('importMlDemo() called directly in production is rejected before touching the database or the data files', async () => {
    const fresh = makeHarness();
    const seeded = makeHarness(); await seed(seeded.ctx);
    for (const h of [fresh, seeded]) {
      const before = snapshot(h);
      const schema = h.ctx.db.prepare(`SELECT COUNT(*) c FROM sqlite_master`).get();
      expect(() => withNodeEnv('production', () => imp(h))).toThrow(/ML demo import is disabled in production/);
      // the guard runs first: even with a data directory that does not exist, the answer is the production error, not ENOENT
      expect(() => withNodeEnv('production', () => importMlDemo(h.ctx.db, { dataDir: '/definitely/not/here' }))).toThrow(/disabled in production/);
      expect(snapshot(h)).toEqual(before);                                           // no row created or changed (accounts, trial, patients, audit events)
      expect(h.ctx.db.prepare(`SELECT COUNT(*) c FROM sqlite_master`).get()).toEqual(schema);
      expect(h.ctx.db.prepare('SELECT COUNT(*) c FROM trials WHERE code = ?').get(ML_DEMO_TRIAL_CODE)).toEqual({ c: 0 });
    }
    expect(count(fresh, 'users')).toBe(0);                                          // in particular, no demo login was created
  });

  it.skipIf(!have)('unrecognised environment names are refused too (a typo such as "Production" must not enable it)', () => {
    const h = makeHarness(); const before = snapshot(h);
    for (const v of ['Production', 'prod', 'staging']) expect(() => withNodeEnv(v, () => imp(h)), v).toThrow(/disabled in production/);
    expect(snapshot(h)).toEqual(before);
  });

  it.skipIf(!have)('development, test and unset environments still import, and the guard does not disturb idempotency or conflict handling', () => {
    for (const v of ['development', 'test', undefined]) {
      const h = makeHarness();
      const r = withNodeEnv(v, () => imp(h));
      expect(r.participants, String(v)).toBe(300);
      expect(withNodeEnv(v, () => imp(h)).alreadyImported, String(v)).toBe(true);
    }
    // a rejected production attempt leaves nothing behind, so a later legitimate import is unaffected
    const h = makeHarness();
    expect(() => withNodeEnv('production', () => imp(h))).toThrow();
    expect(imp(h).participants).toBe(300);
  });

  describe.skipIf(!have)('the CLI (scripts/import-ml-demo.ts), run as a real process', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-demo-cli-'));
    afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = path.join(process.cwd(), 'scripts', 'import-ml-demo.ts');
    const dataDir = path.join(process.cwd(), DATA);
    /** A minimal, explicit environment (not the developer's .env, not this process's): cwd is an empty directory so dotenv loads nothing. */
    const run = (nodeEnv: string, dbFile: string) => spawnSync(process.execPath, [tsx, script, '--data', dataDir], {
      cwd: work, encoding: 'utf8', timeout: 100_000,
      env: {
        PATH: process.env.PATH, NODE_ENV: nodeEnv, DATABASE_PATH: dbFile, LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4',
        JWT_SECRET: 'cli-test-jwt-secret-cli-test-jwt-secret-123456', OTP_PEPPER: 'cli-test-otp-pepper-cli-test-otp-pepper-123456',
        DEMO_OTP_ENABLED: 'false', CORS_ORIGINS: 'https://example.org',
      },
    });

    it('is refused in production: exit code 1, a clear message, and the database file is never even created', () => {
      const db = path.join(work, 'prod.db');
      const r = run('production', db);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Refusing to import synthetic demo data when NODE_ENV=production/);
      expect(fs.existsSync(db)).toBe(false);
      expect(fs.readdirSync(work).filter((f) => f.startsWith('prod.db'))).toEqual([]);
    }, 120_000);

    it('still works in development: imports, logs the result, and a second run reports there is nothing to do', () => {
      const dbFile = path.join(work, 'dev.db');
      const first = run('development', dbFile);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/Imported into .*dev\.db: 300 participants, 2400 visits/);
      const second = run('development', dbFile);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/Nothing to do/);
      const db = openDatabase(dbFile);
      try {
        expect(db.prepare('SELECT COUNT(*) c FROM patients').get()).toEqual({ c: 300 });
        expect(db.prepare(`SELECT COUNT(*) c FROM users WHERE password_hash = '!'`).get()).toEqual({ c: 0 });
      } finally { db.close(); }
    }, 240_000);
  });
});
