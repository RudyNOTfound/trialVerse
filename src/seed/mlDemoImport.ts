/**
 * Loads Person B's synthetic GLU-301 dataset (ml-service/generated_data/demo, produced by
 * `python -m app.data_generation.generate_all`) into a backend database, so the TypeScript backend and the Python ML service can be
 * exercised together on realistic data, including the injected Site C anomalies.
 *
 * It is a development/test tool: it only writes into an EMPTY database (no patients) and refuses anything else, so it can never
 * touch the regular demo data. Synthetic data only. Participants get opaque ids/pseudonymous names from the generator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from '../utils/db';
import { inTransaction } from '../utils/db';
import { appendAuditEvent } from '../modules/audit/chain';

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

export interface ImportOptions {
  dataDir: string;
  trialCode?: string;
  /** Visits of these ids (all completed, unverified) get a DOCUMENTED OTP exception instead of an undocumented one. */
  documentedOtpExceptionVisitIds?: string[];
}
export interface ImportResult { trialId: string; users: { admin: string; coordinator: string; investigator: string }; sites: Record<string, string>; participants: number; visits: number; ecgs: number; measurements: number; exceptions: number }

export function importMlDemo(db: DB, opts: ImportOptions): ImportResult {
  if ((db.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c > 0) {
    throw new Error('Refusing to import: the database already contains patients. Use a new, empty database.');
  }
  const dir = path.join(opts.dataDir, 'demo');
  const sitesCsv = readCsv(path.join(dir, 'sites.csv'));
  const participants = readCsv(path.join(dir, 'participants.csv'));
  const visits = readCsv(path.join(dir, 'visits.csv'));
  const ecgMeta = readCsv(path.join(dir, 'ecg_metadata.csv'));
  const now = new Date().toISOString();
  const id = () => randomUUID();
  const users = { admin: id(), coordinator: id(), investigator: id() };

  return inTransaction(db, () => {
    for (const [role, uid] of Object.entries(users)) {
      db.prepare(`INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, '!', ?, ?, 1, ?, ?)`)
        .run(uid, `${role}@ml-demo.local`, `ML demo ${role}`, role, now, now);
    }
    const trialId = id();
    db.prepare(`INSERT INTO trials (id, code, title, sponsor, phase, status, created_by, created_at, updated_at) VALUES (?, ?, 'GLU-301 synthetic diabetes trial', 'Synthetic sponsor', 'III', 'active', ?, ?, ?)`)
      .run(trialId, opts.trialCode ?? 'GLU-301', users.admin, now, now);

    // Sites: ml_site_category is the explicit mapping the retention model needs; every site is in India (Asia/Kolkata).
    const siteIdByCode: Record<string, string> = {};
    for (const s of sitesCsv) {
      const sid = id(); siteIdByCode[s.site_id!] = sid;
      db.prepare(`INSERT INTO trial_sites (id, trial_id, site_code, name, city, country, status, timezone, ml_site_category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 'Asia/Kolkata', ?, ?, ?)`)
        .run(sid, trialId, s.site_id, s.name, s.city || null, s.country || 'India', s.site_id, now, now);
    }

    const patientIds = new Set<string>(); const enrollmentByParticipant = new Map<string, string>();
    for (const p of participants) {
      const dobYear = 2026 - Number(p.age || 40);
      const [first, ...rest] = (p.participant_name || p.participant_id!).split(' ');
      db.prepare(`INSERT INTO patients (id, subject_code, first_name, last_name, date_of_birth, sex, status, daily_wage_worker, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.participant_id, p.participant_id, first, rest.join(' ') || '-', `${dobYear}-01-01`, p.sex === 'female' ? 'female' : p.sex === 'male' ? 'male' : 'unknown',
          p.dropped_out === '1' ? 'withdrawn' : 'active', p.daily_wage_worker === '' ? null : Number(p.daily_wage_worker), now, now);
      patientIds.add(p.participant_id!);
      const eid = id(); enrollmentByParticipant.set(p.participant_id!, eid);
      db.prepare(`INSERT INTO enrollments (id, patient_id, trial_id, trial_site_id, status, enrolled_at, ended_at, distance_to_site_km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eid, p.participant_id, trialId, siteIdByCode[p.site_id!], p.dropped_out === '1' ? 'withdrawn' : (p.status === 'completed' ? 'completed' : 'enrolled'),
          utc(`${p.enrollment_date}T04:30:00.000Z`), p.dropped_out === '1' ? now : null, num(p.distance_km!), now, now);
    }

    const ecgByVisit = new Map(ecgMeta.map((e) => [e.visit_id!, e]));
    const documented = new Set(opts.documentedOtpExceptionVisitIds ?? []);
    let measurements = 0; let ecgs = 0; let exceptions = 0;
    for (const v of visits) {
      if (!patientIds.has(v.participant_id!)) continue;
      const scheduledAt = `${v.scheduled_date}T04:30:00.000Z`;   // 10:00 Asia/Kolkata
      const completed = v.status === 'completed';
      const verified = completed && v.otp_verified === '1';
      const performed = utc(v.device_timestamp!); const entered = utc(v.entry_timestamp!);
      db.prepare(`INSERT INTO visits (id, enrollment_id, patient_id, trial_id, trial_site_id, visit_type, scheduled_at, status, verified_at, verified_by, completed_at, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.visit_id, enrollmentByParticipant.get(v.participant_id!), v.participant_id, trialId, siteIdByCode[v.site_id!], v.visit_type, scheduledAt, v.status,
          verified ? performed : null, verified ? users.coordinator : null, completed ? (entered ?? performed ?? scheduledAt) : null, users.coordinator, now, now);
      if (completed && (performed || entered)) {
        db.prepare(`INSERT INTO visit_measurements (visit_id, performed_at, entered_at, entered_by, systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(v.visit_id, performed ?? entered, entered ?? performed, users.coordinator, num(v.systolic_bp!), num(v.diastolic_bp!), num(v.heart_rate!), num(v.weight_kg!), num(v.glucose_mg_dl!));
        measurements++;
      }
      if (completed && !verified && documented.has(v.visit_id!)) {
        db.prepare(`INSERT INTO visit_otp_exceptions (id, visit_id, reason_code, note, recorded_by, recorded_at) VALUES (?, ?, 'device_offline', 'Imported: tablet offline at the visit', ?, ?)`).run(id(), v.visit_id, users.investigator, now);
        exceptions++;
      }
      const e = ecgByVisit.get(v.visit_id!);
      if (e) {
        db.prepare(`INSERT INTO visit_ecgs (id, visit_id, file_ref, file_sha256, recorded_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(e.ecg_record_id, v.visit_id, e.image_file, e.image_sha256 && e.image_sha256.length === 64 ? e.image_sha256 : null, utc(e.recorded_at!), users.coordinator, now);
        ecgs++;
      }
    }
    // Participant history feeding the retention model (missed_reminders / side_effects_reported / phone_changed / reimbursement delay).
    const rem = db.prepare(`INSERT INTO visit_reminders (id, enrollment_id, channel, sent_at, outcome, acknowledged_at, outcome_recorded_at, recorded_by, created_at) VALUES (?, ?, 'sms', ?, ?, ?, ?, ?, ?)`);
    const adverse = db.prepare(`INSERT INTO adverse_event_reports (id, enrollment_id, reported_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const p of participants) {
      const eid = enrollmentByParticipant.get(p.participant_id!)!;
      const sent = utc(`${p.enrollment_date}T04:30:00.000Z`) ?? now;
      for (let i = 0; i < Number(p.missed_reminders || 0); i++) rem.run(id(), eid, sent, 'missed', null, sent, users.coordinator, now);
      rem.run(id(), eid, sent, 'acknowledged', sent, sent, users.coordinator, now);   // at least one RESOLVED reminder, so 0 missed is a known 0
      if (p.side_effects_reported === '1') adverse.run(id(), eid, sent, users.coordinator, now);
      if (p.phone_changed === '1') appendAuditEvent(db, { actorId: users.coordinator, action: 'patient.updated', entityType: 'patient', entityId: p.participant_id!, metadata: { changedFields: ['phone'] } });
    }
    const paid = readCsv(path.join(dir, 'reimbursements.csv')).filter((r) => r.status === 'paid' && r.paid_date && patientIds.has(r.participant_id!));
    const claim = db.prepare(`INSERT INTO reimbursements (id, patient_id, visit_id, trial_id, category, amount_cents, currency, status, payment_status, requested_by, reviewed_by, reviewed_at, paid_at, transaction_ref, created_at, updated_at)
                              VALUES (?, ?, ?, ?, 'travel', ?, ?, 'approved', 'paid', ?, ?, ?, ?, 'IMPORT', ?, ?)`);
    for (const r of paid) claim.run(r.reimbursement_id, r.participant_id, r.visit_id, trialId, Math.round(Number(r.amount_inr) * 100), r.currency || 'INR', users.coordinator, users.investigator,
      utc(`${r.paid_date}T06:00:00.000Z`), utc(`${r.paid_date}T06:00:00.000Z`), utc(`${r.claim_date}T06:00:00.000Z`), now);

    appendAuditEvent(db, { actorId: users.admin, action: 'ml_demo.imported', entityType: 'trial', entityId: trialId, metadata: { participants: participants.length, visits: visits.length, ecgs } });
    return { trialId, users, sites: siteIdByCode, participants: participants.length, visits: visits.length, ecgs, measurements, exceptions };
  });
}
