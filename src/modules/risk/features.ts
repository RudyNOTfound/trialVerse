import type { FeatureMap, RiskEntityType } from '../../ml/contracts';
import type { DB } from '../../utils/db';
import { AppError } from '../../utils/errors';

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Number of failed OTP attempts across a set of OTP records (a used OTP's last attempt was the successful one). */
const FAILED_SQL = `COALESCE(SUM(CASE WHEN o.status = 'used' THEN o.attempts - 1 ELSE o.attempts END), 0)`;

function visitFeatures(db: DB, id: string, now: number): FeatureMap {
  const v = db.prepare('SELECT status, scheduled_at, patient_id FROM visits WHERE id = ?').get(id) as { status: string; scheduled_at: string; patient_id: string } | undefined;
  if (!v) throw AppError.notFound('Visit');
  const otp = db.prepare(
    `SELECT ${FAILED_SQL} AS failed, SUM(CASE WHEN o.status = 'locked' THEN 1 ELSE 0 END) AS locked, COUNT(*) AS issued
     FROM otp_records o WHERE o.visit_id = ?`,
  ).get(id) as { failed: number; locked: number | null; issued: number };
  const sched = Date.parse(v.scheduled_at);
  return {
    visit_status: v.status,
    visit_is_verified: v.status === 'verified' || v.status === 'completed',
    visit_hours_past_scheduled: sched < now ? Math.round(((now - sched) / H) * 10) / 10 : null,
    visit_otp_failed_attempts: otp.failed,
    visit_otp_locked_count: otp.locked ?? 0,
    visit_otp_issue_count: otp.issued,
  };
}

/** Groups of reimbursements that duplicate each other (same patient, visit, category, amount; excluding cancelled/rejected). */
function duplicateCountForPatient(db: DB, patientId: string): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(n - 1), 0) AS dups FROM (
       SELECT COUNT(*) AS n FROM reimbursements
       WHERE patient_id = ? AND status IN ('pending','approved')
       GROUP BY visit_id, category, amount_cents HAVING n > 1)`,
  ).get(patientId) as { dups: number };
  return r.dups;
}

function patientFeatures(db: DB, id: string, now: number): FeatureMap {
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ? AND deleted_at IS NULL').get(id)) throw AppError.notFound('Patient');
  const failed24 = db.prepare(
    `SELECT COUNT(*) c FROM audit_logs WHERE action = 'otp.verify_failed' AND created_at >= ?
       AND json_extract(metadata, '$.patientId') = ? AND json_extract(metadata, '$.reason') = 'incorrect_code'`,
  ).get(iso(now - 24 * H), id) as { c: number };
  const visits7 = db.prepare(`SELECT COUNT(*) c FROM visits WHERE patient_id = ? AND scheduled_at >= ? AND scheduled_at <= ? AND status != 'cancelled'`).get(id, iso(now - 7 * 24 * H), iso(now)) as { c: number };
  const missed90 = db.prepare(`SELECT COUNT(*) c FROM visits WHERE patient_id = ? AND status = 'missed' AND scheduled_at >= ?`).get(id, iso(now - 90 * 24 * H)) as { c: number };
  const unverified = db.prepare(`SELECT COUNT(*) c FROM visits WHERE patient_id = ? AND status IN ('scheduled','otp_pending') AND scheduled_at < ?`).get(id, iso(now - 24 * H)) as { c: number };
  const vol = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) s FROM reimbursements WHERE patient_id = ? AND status IN ('pending','approved') AND created_at >= ?`).get(id, iso(now - 30 * 24 * H)) as { s: number };
  return {
    patient_failed_otp_24h: failed24.c,
    patient_visits_7d: visits7.c,
    patient_missed_90d: missed90.c,
    patient_unverified_overdue: unverified.c,
    patient_duplicate_reimbursements: duplicateCountForPatient(db, id),
    patient_reimbursement_total_30d_cents: vol.s,
  };
}

function reimbursementFeatures(db: DB, id: string, now: number): FeatureMap {
  const r = db.prepare('SELECT patient_id, visit_id, category, amount_cents FROM reimbursements WHERE id = ?').get(id) as
    | { patient_id: string; visit_id: string; category: string; amount_cents: number } | undefined;
  if (!r) throw AppError.notFound('Reimbursement');
  const dup = db.prepare(
    `SELECT COUNT(*) c FROM reimbursements WHERE id != ? AND visit_id = ? AND category = ? AND amount_cents = ? AND status IN ('pending','approved')`,
  ).get(id, r.visit_id, r.category, r.amount_cents) as { c: number };
  const visit = db.prepare('SELECT status FROM visits WHERE id = ?').get(r.visit_id) as { status: string };
  const recent = db.prepare(`SELECT COUNT(*) c FROM reimbursements WHERE patient_id = ? AND created_at >= ?`).get(r.patient_id, iso(now - 24 * H)) as { c: number };
  const avg = db.prepare(
    `SELECT AVG(amount_cents) a, COUNT(*) n FROM reimbursements WHERE category = ? AND id != ? AND status IN ('pending','approved')`,
  ).get(r.category, id) as { a: number | null; n: number };
  return {
    reimb_amount_cents: r.amount_cents,
    reimb_category: r.category,
    reimb_duplicate_count: dup.c,
    reimb_visit_status: visit.status,
    reimb_visit_verified: visit.status === 'verified' || visit.status === 'completed',
    reimb_patient_count_24h: recent.c,
    // Needs >= 3 comparable claims to be meaningful; otherwise null.
    reimb_amount_ratio_to_category_avg: avg.n >= 3 && avg.a ? Math.round((r.amount_cents / avg.a) * 100) / 100 : null,
  };
}

/** Builds the flat feature map shared by the baseline rules and any ML model (see docs/ML_INTEGRATION.md). */
export function buildFeatures(db: DB, entityType: RiskEntityType, entityId: string, now = Date.now()): FeatureMap {
  switch (entityType) {
    case 'visit': return visitFeatures(db, entityId, now);
    case 'patient': return patientFeatures(db, entityId, now);
    case 'reimbursement': return reimbursementFeatures(db, entityId, now);
  }
}
