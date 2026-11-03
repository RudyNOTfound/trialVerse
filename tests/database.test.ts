import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { makeHarness, makeScenario } from './helpers';

describe('database & migrations', () => {
  it('applies migrations once and is idempotent', () => {
    const db = openDatabase(':memory:');
    const first = runMigrations(db);
    expect(first).toEqual(['001_init.sql', '002_ml_inputs.sql']); // new migrations are appended; 001 is never edited
    expect(runMigrations(db)).toEqual([]);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['users', 'patients', 'trials', 'trial_sites', 'enrollments', 'visits', 'otp_records', 'audit_logs', 'audit_chain_head',
      'reimbursements', 'actions', 'status_history', 'risk_assessments', 'integrity_alerts',
      'visit_otp_exceptions', 'visit_reminders', 'adverse_event_reports', 'visit_measurements', 'visit_ecgs']) expect(tables).toContain(t);
  });

  it('persists to a file and reopens with data intact', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'x.db');
    const db = openDatabase(file);
    runMigrations(db);
    db.prepare(`INSERT INTO users (id,email,password_hash,full_name,role,created_at,updated_at) VALUES ('u1','a@b.co','h','A','admin','t','t')`).run();
    db.close();
    const again = openDatabase(file);
    expect(runMigrations(again)).toEqual([]);
    expect((again.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
    again.close();
  });

  const h = makeHarness();

  it('enforces foreign keys', () => {
    expect(() => h.ctx.db.prepare(
      `INSERT INTO enrollments (id,patient_id,trial_id,trial_site_id,status,created_at,updated_at) VALUES ('e','nope','nope','nope','screening','t','t')`).run()).toThrow(/FOREIGN KEY/);
  });

  it('enforces unique constraints and CHECK constraints', async () => {
    const sc = await makeScenario(h);
    const ins = (role: string, email = 'dup@x.co') => h.ctx.db.prepare(
      `INSERT INTO users (id,email,password_hash,full_name,role,created_at,updated_at) VALUES (lower(hex(randomblob(8))),?,'h','n',?,'t','t')`).run(email, role);
    ins('admin');
    expect(() => ins('admin', 'DUP@x.co')).toThrow(/UNIQUE/);            // NOCASE unique email
    expect(() => ins('superuser', 'other@x.co')).toThrow(/CHECK/);        // role enum
    expect(() => h.s.trials.createEnrollment({ patientId: sc.patient.id, trialId: sc.trial.id, trialSiteId: sc.site.id }, sc.coord.actor)).toThrow(/already enrolled/);
    expect(() => h.ctx.db.prepare(`UPDATE reimbursements SET amount_cents = -5`).run()).not.toThrow(); // no rows yet
    const v = sc.newVisit();
    expect(() => h.ctx.db.prepare(
      `INSERT INTO reimbursements (id,patient_id,visit_id,trial_id,category,amount_cents,requested_by,created_at,updated_at) VALUES ('r',?,?,?,'travel',0,?,'t','t')`)
      .run(sc.patient.id, v.id, sc.trial.id, sc.coord.id)).toThrow(/CHECK/);
  });

  it('allows only one active OTP per visit at the database level', async () => {
    const sc = await makeScenario(h);
    const ins = () => h.ctx.db.prepare(
      `INSERT INTO otp_records (id,visit_id,code_hash,status,max_attempts,expires_at,created_at,updated_at) VALUES (lower(hex(randomblob(8))),?,'x','active',5,'t','t','t')`).run(sc.visit.id);
    ins();
    expect(() => ins()).toThrow(/UNIQUE/);
  });

  it('blocks UPDATE and DELETE on audit_logs via triggers', async () => {
    await makeScenario(h);
    expect(() => h.ctx.db.prepare(`UPDATE audit_logs SET action = 'x'`).run()).toThrow(/append-only/);
    expect(() => h.ctx.db.prepare(`DELETE FROM audit_logs`).run()).toThrow(/append-only/);
  });

  it('keeps created/updated timestamps as ISO strings and bumps updated_at on update', async () => {
    const sc = await makeScenario(h);
    const before = h.s.patients.get(sc.patient.id);
    expect(before.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await new Promise((r) => setTimeout(r, 5));
    const after = h.s.patients.update(sc.patient.id, { phone: '+1-555-0000' }, sc.coord.actor);
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it('rolls back business changes when the audit append fails (atomicity)', async () => {
    const sc = await makeScenario(h);
    h.ctx.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON audit_logs WHEN NEW.action = 'patient.created' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expect(() => h.s.patients.create({ firstName: 'X', lastName: 'Y', dateOfBirth: '1990-01-01', sex: 'male' }, sc.coord.actor)).toThrow(/boom/);
    expect((h.ctx.db.prepare(`SELECT COUNT(*) c FROM patients WHERE first_name = 'X'`).get() as { c: number }).c).toBe(0);
    h.ctx.db.exec('DROP TRIGGER boom');
  });
});
