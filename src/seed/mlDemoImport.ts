/**
 * Loads Person B's synthetic GLU-301 dataset (ml-service/generated_data/demo, produced by
 * `python -m app.data_generation.generate_all`) into a backend database, so the TypeScript backend and the Python ML service can be
 * exercised together on realistic data, including the injected Site C anomalies.
 *
 * Safe to run on a fresh database, on a database that already holds the regular `npm run seed` data, and repeatedly:
 *  - every row it creates gets a DETERMINISTIC UUID (`mlDemoId`) derived from the generator's own id (e.g. 'P-A-001'), so the HTTP routes
 *    that validate UUIDs accept them, and re-running finds the same rows instead of creating duplicates (INSERT OR IGNORE);
 *  - the human-readable id is kept in `patients.subject_code` / `trial_sites.site_code`;
 *  - the demo accounts are the same as the regular seed's (admin@/coordinator1@/investigator1@trialguard.demo): an existing account is
 *    reused untouched, a missing one is created with a real bcrypt hash of the demo password, so every account can log in;
 *  - nothing existing is updated or deleted; a real conflict (another trial already using the code, another patient already using a
 *    subject code, an account with the wrong role) is reported as an error instead of being merged.
 * Refuses to run in production (see `demoDataAllowed`). Synthetic data only. Participants get opaque ids/pseudonymous names from the generator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { DB } from '../utils/db';
import { inTransaction } from '../utils/db';
import { appendAuditEvent } from '../modules/audit/chain';
import { demoDataAllowed } from '../config/env';
import { DEMO_PASSWORD } from './seed';

type Row = Record<string, string>;

/** Minimal RFC-4180 CSV reader (quoted fields, escaped quotes). */
export function readCsv(file: string): Row[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = ''; let row: string[] = []; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

const utc = (v: string): string | null => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
const num = (v: string): number | null => (v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export const ML_DEMO_TRIAL_CODE = 'GLU-301';
const NAMESPACE = Buffer.from('6f1c2d3e4a5b4c7d8e9f0a1b2c3d4e5f', 'hex');   // fixed namespace of the ML demo data (never change: ids derive from it)

/**
 * Deterministic RFC-4122 version-5 style UUID for a record of the ML demo dataset. `kind` is the record type ('patient', 'visit', ...)
 * and `sourceId` the generator's own id ('P-A-001', 'V-A-001-01', ...). The same input always gives the same UUID, on every machine.
 */
export function mlDemoId(kind: string, sourceId: string): string {
  const h = createHash('sha1').update(NAMESPACE).update(`${kind}:${sourceId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The demo accounts: same addresses as the regular seed, so both datasets share one set of logins. */
const DEMO_ACCOUNTS = {
  admin: { email: 'admin@trialguard.demo', fullName: 'Alex Admin', role: 'admin' },
  coordinator: { email: 'coordinator1@trialguard.demo', fullName: 'Casey Coordinator', role: 'coordinator' },
  investigator: { email: 'investigator1@trialguard.demo', fullName: 'Dr. Priya Raman', role: 'investigator' },
} as const;

export interface ImportOptions {
  dataDir: string;
  /** bcrypt cost for accounts that have to be created (use the application's BCRYPT_ROUNDS). Default 12 = the application default. */
  bcryptRounds?: number;
  /** Password of newly created demo accounts. Default: the regular seed's demo password. */
  password?: string;
  /** Visits of these SOURCE ids ('V-C-001-02', ...; all completed, unverified) get a DOCUMENTED OTP exception instead of an undocumented one. */
  documentedOtpExceptionVisitIds?: string[];
}
/** Counts are rows CREATED by this run: a repeat run reports zeros and `alreadyImported: true`. `sites` maps the source site code ('SITE-C') to its UUID. */
export interface ImportResult {
  trialId: string; users: { admin: string; coordinator: string; investigator: string }; createdUsers: string[]; sites: Record<string, string>;
  participants: number; visits: number; ecgs: number; measurements: number; exceptions: number; reimbursements: number; alreadyImported: boolean;
}

export function importMlDemo(db: DB, opts: ImportOptions): ImportResult {
  // First statement, before any file or database access: synthetic demo data (with demo logins) must never be written in production,
  // whoever calls this function. The CLI has its own check as well (defence in depth); there is deliberately no option to override this.
  if (!demoDataAllowed()) {
    throw new Error(`ML demo import is disabled in production (NODE_ENV=${process.env.NODE_ENV ?? ''}). It writes synthetic data and demo accounts.`);
  }
  const dir = path.join(opts.dataDir, 'demo');
  const sitesCsv = readCsv(path.join(dir, 'sites.csv'));
  const participants = readCsv(path.join(dir, 'participants.csv'));
  const visits = readCsv(path.join(dir, 'visits.csv'));
  const ecgMeta = readCsv(path.join(dir, 'ecg_metadata.csv'));
  const reimbursementsCsv = readCsv(path.join(dir, 'reimbursements.csv'));
  const now = new Date().toISOString();
  const D = mlDemoId;
  /** INSERT OR IGNORE: the deterministic id is the identity, so an existing row is left exactly as it is. Returns 1 if a row was created. */
  const ins = (sql: string, ...params: unknown[]): number => db.prepare(sql.replace(/^\s*INSERT /, 'INSERT OR IGNORE ')).run(...params).changes;

  return inTransaction(db, () => {
    // ---- accounts: reuse the regular seed's, create the missing ones with a real password hash ------------------
    const users = {} as ImportResult['users']; const createdUsers: string[] = [];
    let hash: string | null = null;
    for (const [key, a] of Object.entries(DEMO_ACCOUNTS) as Array<[keyof ImportResult['users'], (typeof DEMO_ACCOUNTS)[keyof typeof DEMO_ACCOUNTS]]>) {
      const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(a.email) as { id: string; role: string } | undefined;
      if (existing) {
        if (existing.role !== a.role) throw new Error(`Cannot import: ${a.email} already exists with role '${existing.role}', expected '${a.role}'.`);
        users[key] = existing.id; continue;
      }
      hash ??= bcrypt.hashSync(opts.password ?? DEMO_PASSWORD, opts.bcryptRounds ?? 12);
      const uid = D('user', a.email); users[key] = uid; createdUsers.push(a.email);
      db.prepare(`INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(uid, a.email, hash, a.fullName, a.role, now, now);
      appendAuditEvent(db, { actorId: uid, action: 'user.created', entityType: 'user', entityId: uid, metadata: { role: a.role, selfRegistered: false, source: 'ml_demo' } });
    }

    // ---- trial ---------------------------------------------------------------------------------------------------
    const trialId = D('trial', ML_DEMO_TRIAL_CODE);
    const sameCode = db.prepare('SELECT id FROM trials WHERE code = ?').get(ML_DEMO_TRIAL_CODE) as { id: string } | undefined;
    if (sameCode && sameCode.id !== trialId) throw new Error(`Cannot import: a different trial already uses the code ${ML_DEMO_TRIAL_CODE}.`);
    const trialCreated = ins(`INSERT INTO trials (id, code, title, sponsor, phase, status, created_by, created_at, updated_at) VALUES (?, ?, 'GLU-301 synthetic diabetes trial', 'Synthetic sponsor', 'III', 'active', ?, ?, ?)`,
      trialId, ML_DEMO_TRIAL_CODE, users.admin, now, now);

    // ---- sites: ml_site_category is the explicit mapping the retention model needs; every site is in India (Asia/Kolkata) ----
    const siteIdByCode: Record<string, string> = {};
    for (const s of sitesCsv) {
      const sid = D('site', s.site_id!); siteIdByCode[s.site_id!] = sid;
      ins(`INSERT INTO trial_sites (id, trial_id, site_code, name, city, country, status, timezone, ml_site_category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 'Asia/Kolkata', ?, ?, ?)`,
        sid, trialId, s.site_id, s.name, s.city || null, s.country || 'India', s.site_id, now, now);
    }

    // ---- participants / enrollments (the generator's id stays in subject_code) ---------------------------------------
    const patientIds = new Set<string>(); let newParticipants = 0;
    const codeOwner = db.prepare('SELECT id FROM patients WHERE subject_code = ?');
    for (const p of participants) {
      const pid = D('patient', p.participant_id!); const eid = D('enrollment', p.participant_id!);
      const owner = codeOwner.get(p.participant_id!) as { id: string } | undefined;
      if (owner && owner.id !== pid) throw new Error(`Cannot import: subject code ${p.participant_id} already belongs to a different patient.`);
      const dobYear = 2026 - Number(p.age || 40);
      const [first, ...rest] = (p.participant_name || p.participant_id!).split(' ');
      const created = ins(`INSERT INTO patients (id, subject_code, first_name, last_name, date_of_birth, sex, status, daily_wage_worker, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pid, p.participant_id, first, rest.join(' ') || '-', `${dobYear}-01-01`, p.sex === 'female' ? 'female' : p.sex === 'male' ? 'male' : 'unknown',
        p.dropped_out === '1' ? 'withdrawn' : 'active', p.daily_wage_worker === '' ? null : Number(p.daily_wage_worker), now, now);
      patientIds.add(p.participant_id!);
      ins(`INSERT INTO enrollments (id, patient_id, trial_id, trial_site_id, status, enrolled_at, ended_at, distance_to_site_km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eid, pid, trialId, siteIdByCode[p.site_id!], p.dropped_out === '1' ? 'withdrawn' : (p.status === 'completed' ? 'completed' : 'enrolled'),
        utc(`${p.enrollment_date}T04:30:00.000Z`), p.dropped_out === '1' ? now : null, num(p.distance_km!), now, now);
      if (created && p.phone_changed === '1') appendAuditEvent(db, { actorId: users.coordinator, action: 'patient.updated', entityType: 'patient', entityId: pid, metadata: { changedFields: ['phone'] } });
      newParticipants += created;
    }

    // ---- visits, measurements, OTP exceptions, ECG references ----------------------------------------------------------
    const ecgByVisit = new Map(ecgMeta.map((e) => [e.visit_id!, e]));
    const documented = new Set(opts.documentedOtpExceptionVisitIds ?? []);
    let newVisits = 0; let measurements = 0; let ecgs = 0; let exceptions = 0;
    for (const v of visits) {
      if (!patientIds.has(v.participant_id!)) continue;
      const vid = D('visit', v.visit_id!);
      const scheduledAt = `${v.scheduled_date}T04:30:00.000Z`;   // 10:00 Asia/Kolkata
      const completed = v.status === 'completed';
      const verified = completed && v.otp_verified === '1';
      const performed = utc(v.device_timestamp!); const entered = utc(v.entry_timestamp!);
      newVisits += ins(`INSERT INTO visits (id, enrollment_id, patient_id, trial_id, trial_site_id, visit_type, scheduled_at, status, verified_at, verified_by, completed_at, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        vid, D('enrollment', v.participant_id!), D('patient', v.participant_id!), trialId, siteIdByCode[v.site_id!], v.visit_type, scheduledAt, v.status,
        verified ? performed : null, verified ? users.coordinator : null, completed ? (entered ?? performed ?? scheduledAt) : null, users.coordinator, now, now);
      if (completed && (performed || entered)) {
        measurements += ins(`INSERT INTO visit_measurements (visit_id, performed_at, entered_at, entered_by, systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          vid, performed ?? entered, entered ?? performed, users.coordinator, num(v.systolic_bp!), num(v.diastolic_bp!), num(v.heart_rate!), num(v.weight_kg!), num(v.glucose_mg_dl!));
      }
      if (completed && !verified && documented.has(v.visit_id!)) {
        exceptions += ins(`INSERT INTO visit_otp_exceptions (id, visit_id, reason_code, note, recorded_by, recorded_at) VALUES (?, ?, 'device_offline', 'Imported: tablet offline at the visit', ?, ?)`,
          D('otp-exception', v.visit_id!), vid, users.investigator, now);
      }
      const e = ecgByVisit.get(v.visit_id!);
      if (e) {
        ecgs += ins(`INSERT INTO visit_ecgs (id, visit_id, file_ref, file_sha256, recorded_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          D('ecg', e.ecg_record_id!), vid, e.image_file, e.image_sha256 && e.image_sha256.length === 64 ? e.image_sha256 : null, utc(e.recorded_at!), users.coordinator, now);
      }
    }

    // ---- participant history feeding the retention model (missed_reminders / side_effects_reported / reimbursement delay) ----
    const rem = `INSERT INTO visit_reminders (id, enrollment_id, channel, sent_at, outcome, acknowledged_at, outcome_recorded_at, recorded_by, created_at) VALUES (?, ?, 'sms', ?, ?, ?, ?, ?, ?)`;
    for (const p of participants) {
      const eid = D('enrollment', p.participant_id!);
      const sent = utc(`${p.enrollment_date}T04:30:00.000Z`) ?? now;
      for (let i = 0; i < Number(p.missed_reminders || 0); i++) ins(rem, D('reminder', `${p.participant_id}:missed:${i}`), eid, sent, 'missed', null, sent, users.coordinator, now);
      ins(rem, D('reminder', `${p.participant_id}:ack`), eid, sent, 'acknowledged', sent, sent, users.coordinator, now);   // at least one RESOLVED reminder, so 0 missed is a known 0
      if (p.side_effects_reported === '1') ins(`INSERT INTO adverse_event_reports (id, enrollment_id, reported_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)`, D('adverse-event', p.participant_id!), eid, sent, users.coordinator, now);
    }
    let reimbursements = 0;
    const paid = reimbursementsCsv.filter((r) => r.status === 'paid' && r.paid_date && patientIds.has(r.participant_id!));
    for (const r of paid) {
      reimbursements += ins(`INSERT INTO reimbursements (id, patient_id, visit_id, trial_id, category, amount_cents, currency, status, payment_status, requested_by, reviewed_by, reviewed_at, paid_at, transaction_ref, created_at, updated_at)
                              VALUES (?, ?, ?, ?, 'travel', ?, ?, 'approved', 'paid', ?, ?, ?, ?, 'IMPORT', ?, ?)`,
        D('reimbursement', r.reimbursement_id!), D('patient', r.participant_id!), D('visit', r.visit_id!), trialId, Math.round(Number(r.amount_inr) * 100), r.currency || 'INR', users.coordinator, users.investigator,
        utc(`${r.paid_date}T06:00:00.000Z`), utc(`${r.paid_date}T06:00:00.000Z`), utc(`${r.claim_date}T06:00:00.000Z`), now);
    }

    if (trialCreated) appendAuditEvent(db, { actorId: users.admin, action: 'ml_demo.imported', entityType: 'trial', entityId: trialId, metadata: { participants: participants.length, visits: visits.length, ecgs } });
    return { trialId, users, createdUsers, sites: siteIdByCode, participants: newParticipants, visits: newVisits, ecgs, measurements, exceptions, reimbursements, alreadyImported: !trialCreated && newParticipants === 0 && newVisits === 0 };
  });
}
