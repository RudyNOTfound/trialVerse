import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import type { DB } from '../src/utils/db';

const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');
const T = '2026-01-01T00:00:00.000Z';

/** A migrations directory containing only 001, to reproduce a database that existed before migration 002. */
function onlyFirstMigration(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mig-'));
  fs.copyFileSync(path.join(MIGRATIONS, '001_init.sql'), path.join(dir, '001_init.sql'));
  return dir;
}

function seedLegacy(db: DB) {
  const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
  run(`INSERT INTO users (id,email,password_hash,full_name,role,created_at,updated_at) VALUES ('u1','a@b.co','h','Admin','admin',?,?)`, T, T);
  run(`INSERT INTO users (id,email,password_hash,full_name,role,created_at,updated_at) VALUES ('u2','p@b.co','h','Pat','patient',?,?)`, T, T);
  run(`INSERT INTO patients (id,subject_code,user_id,first_name,last_name,date_of_birth,sex,status,created_at,updated_at) VALUES ('p1','P-1','u2','Pat','One','1980-01-01','female','active',?,?)`, T, T);
  run(`INSERT INTO trials (id,code,title,sponsor,phase,status,created_by,created_at,updated_at) VALUES ('t1','TR-1','Trial','Acme','II','active','u1',?,?)`, T, T);
  run(`INSERT INTO trial_sites (id,trial_id,site_code,name,country,status,created_at,updated_at) VALUES ('s1','t1','S-01','Site','India','active',?,?)`, T, T);
  run(`INSERT INTO trial_sites (id,trial_id,site_code,name,country,status,created_at,updated_at) VALUES ('s2','t1','S-02','Site 2','India','active',?,?)`, T, T);
  run(`INSERT INTO enrollments (id,patient_id,trial_id,trial_site_id,status,created_at,updated_at) VALUES ('e1','p1','t1','s1','enrolled',?,?)`, T, T);
  run(`INSERT INTO visits (id,enrollment_id,patient_id,trial_id,trial_site_id,visit_type,scheduled_at,status,created_at,updated_at) VALUES ('v1','e1','p1','t1','s1','Baseline',?, 'scheduled',?,?)`, T, T, T);
  run(`INSERT INTO visits (id,enrollment_id,patient_id,trial_id,trial_site_id,visit_type,scheduled_at,status,created_at,updated_at) VALUES ('v2','e1','p1','t1','s1','Week 2',?, 'scheduled',?,?)`, T, T, T);
}

const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe('migration 002 (ML inputs)', () => {
  it('upgrades an existing database without touching any existing record', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db, onlyFirstMigration())).toEqual(['001_init.sql']);
    seedLegacy(db);
    const before = ['users', 'patients', 'trials', 'trial_sites', 'enrollments', 'visits'].map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())]);

    expect(runMigrations(db)).toEqual(['002_ml_inputs.sql']);

    // every pre-existing column value is identical; only the new nullable columns appear, all NULL ("unknown")
    for (const [table, snapshot] of before) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
      const stripped = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !['timezone', 'ml_site_category', 'distance_to_site_km', 'daily_wage_worker'].includes(k))));
      expect(JSON.stringify(stripped), table).toBe(snapshot);
    }
    expect(db.prepare('SELECT timezone, ml_site_category FROM trial_sites').all()).toEqual([
      { timezone: null, ml_site_category: null }, { timezone: null, ml_site_category: null }]);
    expect(db.prepare('SELECT distance_to_site_km d FROM enrollments').get()).toEqual({ d: null });
    expect(db.prepare('SELECT daily_wage_worker w FROM patients').get()).toEqual({ w: null });
    for (const t of ['visit_otp_exceptions', 'visit_reminders', 'adverse_event_reports', 'visit_measurements', 'visit_ecgs']) expect(count(db, t)).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('is idempotent and recorded in schema_migrations', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect((db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name)).toEqual(['001_init.sql', '002_ml_inputs.sql']);
  });

  describe('constraints', () => {
    const fresh = () => { const db = openDatabase(':memory:'); runMigrations(db); seedLegacy(db); return db; };

    it('limits distance to 0..2000 km and wage status to 0/1/NULL', () => {
      const db = fresh();
      const dist = db.prepare(`UPDATE enrollments SET distance_to_site_km = ? WHERE id = 'e1'`);
      for (const ok of [0, 40.5, 2000, null]) expect(() => dist.run(ok)).not.toThrow();
      for (const bad of [-0.1, 2000.1]) expect(() => dist.run(bad)).toThrow(/CHECK/);
      const wage = db.prepare(`UPDATE patients SET daily_wage_worker = ? WHERE id = 'p1'`);
      for (const ok of [0, 1, null]) expect(() => wage.run(ok)).not.toThrow();
      expect(() => wage.run(2)).toThrow(/CHECK/);
    });

    it('allows one model category per trial (but many sites without one)', () => {
      const db = fresh();
      const set = db.prepare(`UPDATE trial_sites SET ml_site_category = ? WHERE id = ?`);
      set.run('SITE-A', 's1');
      expect(() => set.run('SITE-A', 's2')).toThrow(/UNIQUE/);
      expect(() => set.run('SITE-B', 's2')).not.toThrow();
      db.prepare(`UPDATE trial_sites SET ml_site_category = NULL`).run(); // NULLs never collide
      expect(() => set.run(null, 's1')).not.toThrow();
    });

    it('restricts OTP exception reasons, requires a 1-500 char note, and allows one exception per visit', () => {
      const db = fresh();
      const ins = db.prepare(`INSERT INTO visit_otp_exceptions (id,visit_id,reason_code,note,recorded_by,recorded_at) VALUES (?,?,?,?,'u1',?)`);
      expect(() => ins.run('x1', 'v1', 'device_offline', 'Tablet had no signal', T)).not.toThrow();
      expect(() => ins.run('x2', 'v1', 'other', 'again', T)).toThrow(/UNIQUE/);
      expect(() => ins.run('x3', 'v2', 'because', 'n', T)).toThrow(/CHECK/);
      expect(() => ins.run('x4', 'v2', 'other', '', T)).toThrow(/CHECK/);
      expect(() => ins.run('x5', 'v2', 'other', 'x'.repeat(501), T)).toThrow(/CHECK/);
      expect(() => ins.run('x6', 'ghost', 'other', 'n', T)).toThrow(/FOREIGN KEY/);
    });

    it('keeps reminder outcomes consistent with their timestamps', () => {
      const db = fresh();
      const ins = db.prepare(`INSERT INTO visit_reminders (id,enrollment_id,channel,sent_at,outcome,acknowledged_at,outcome_recorded_at,created_at) VALUES (?,'e1',?,?,?,?,?,?)`);
      expect(() => ins.run('r1', 'sms', T, 'sent', null, null, T)).not.toThrow();
      expect(() => ins.run('r2', 'ivr', T, 'missed', null, T, T)).not.toThrow();
      expect(() => ins.run('r3', 'call', T, 'acknowledged', T, T, T)).not.toThrow();
      expect(() => ins.run('r4', 'sms', T, 'acknowledged', null, T, T)).toThrow(/CHECK/);   // acknowledged without a time
      expect(() => ins.run('r5', 'sms', T, 'missed', T, T, T)).toThrow(/CHECK/);            // acknowledged_at on a non-acknowledged row
      expect(() => ins.run('r6', 'sms', T, 'missed', null, null, T)).toThrow(/CHECK/);       // resolved outcome without a recorded time
      expect(() => ins.run('r7', 'sms', T, 'sent', null, T, T)).toThrow(/CHECK/);            // unresolved but has a recorded time
      expect(() => ins.run('r8', 'email', T, 'sent', null, null, T)).toThrow(/CHECK/);       // unknown channel
      expect(() => ins.run('r9', 'sms', T, 'delivered', null, null, T)).toThrow(/CHECK/);    // unknown outcome
    });

    it('stores adverse-event reports against an enrollment', () => {
      const db = fresh();
      db.prepare(`INSERT INTO adverse_event_reports (id,enrollment_id,visit_id,reported_at,created_by,created_at) VALUES ('a1','e1','v1',?,'u1',?)`).run(T, T);
      expect(() => db.prepare(`INSERT INTO adverse_event_reports (id,enrollment_id,reported_at,created_by,created_at) VALUES ('a2','ghost',?,'u1',?)`).run(T, T)).toThrow(/FOREIGN KEY/);
    });

    it('accepts implausible-but-possible measurements, rejects structurally invalid ones, one row per visit', () => {
      const db = fresh();
      const ins = db.prepare(`INSERT INTO visit_measurements (visit_id,performed_at,entered_at,entered_by,systolic_bp,diastolic_bp,heart_rate,weight_kg,glucose_mg_dl) VALUES (?,?,?,'u1',?,?,?,?,?)`);
      expect(() => ins.run('v1', T, T, 400, 20, 300, 5, 2000)).not.toThrow();   // absurd but storable: the engine flags it
      expect(() => ins.run('v1', T, T, 120, 80, 70, 70, 100)).toThrow(/UNIQUE|PRIMARY/);
      expect(() => ins.run('v2', T, T, 0, 80, 70, 70, 100)).toThrow(/CHECK/);
      expect(() => ins.run('v2', T, T, -5, 80, 70, 70, 100)).toThrow(/CHECK/);
      expect(() => ins.run('v2', T, T, null, null, null, null, null)).not.toThrow(); // every measurement is optional
    });

    it('stores ECG references: one per visit, the same image file may be referenced by several records', () => {
      const db = fresh();
      const ins = db.prepare(`INSERT INTO visit_ecgs (id,visit_id,file_ref,file_sha256,created_by,created_at) VALUES (?,?,?,?, 'u1',?)`);
      expect(() => ins.run('g1', 'v1', 'ecgs/ecg_028.png', 'a'.repeat(64), T)).not.toThrow();
      expect(() => ins.run('g2', 'v1', 'ecgs/other.png', null, T)).toThrow(/UNIQUE/);                // one ECG per visit
      expect(() => ins.run('g3', 'v2', 'ecgs/ecg_028.png', null, T)).not.toThrow();                  // re-used image: must be storable
      expect(() => ins.run('g4', 'ghost', 'x.png', null, T)).toThrow(/FOREIGN KEY/);
      expect(() => ins.run('g5', 'v2', '', null, T)).toThrow();
      expect(() => ins.run('g6', 'v2', 'ecgs/x.png', 'short', T)).toThrow();
    });
  });

  it('keeps the audit hash chain valid after the upgrade (existing audit rows are untouched)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, onlyFirstMigration());
    const auditBefore = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
    runMigrations(db);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_logs').all())).toBe(auditBefore);
  });
});
