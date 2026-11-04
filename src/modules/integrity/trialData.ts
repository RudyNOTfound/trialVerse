import {
  TRIAL_DATA_LIMITS, trialDataSchema,
  type OtpExceptionReason, type TrialData, type TrialEcgRef, type TrialParticipantRef, type TrialVisit,
} from '../../ml/contracts';
import type { DB } from '../../utils/db';
import { isCanonicalIanaTimezone } from '../../utils/timezone';

/** Participants whose enrollment reached at least "enrolled" take part in site statistics (screening / screen_failed are not sent). */
const SCANNABLE_ENROLLMENT = `('enrolled','completed','withdrawn')`;

export interface TrialDataMeta {
  trialId: string;
  sitesSkippedNoTimezone: string[];
  sitesSkippedInvalidTimezone: string[];
  sitesSkippedOverCap: string[];
  participants: number;
  visits: number;
  ecgs: number;
  /** Set when a size cap was hit and the oldest visits / ECGs were left out. */
  truncated: { visits?: number; ecgs?: number; participants?: number } | null;
}
/** `trialData` is null when nothing can be sent for the trial (see `meta` for why: skipped sites, no participants). */
export interface TrialDataBuild { trialData: TrialData | null; meta: TrialDataMeta }

interface VisitRow {
  id: string; patient_id: string; trial_site_id: string; visit_type: string | null; status: string; scheduled_at: string; verified_at: string | null; rn: number;
  performed_at: string | null; entered_at: string | null; systolic_bp: number | null; diastolic_bp: number | null; heart_rate: number | null;
  weight_kg: number | null; glucose_mg_dl: number | null; reason_code: string | null; ecg_id: string | null; file_ref: string | null;
}

const asIso = (v: string | null): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Trials that have at least one enrolled/completed/withdrawn participant: the only ones a trial scan can say anything about. */
export function listScannableTrials(db: DB): string[] {
  return (db.prepare(
    `SELECT DISTINCT e.trial_id AS id FROM enrollments e JOIN trials t ON t.id = e.trial_id
     WHERE t.deleted_at IS NULL AND e.status IN ${SCANNABLE_ENROLLMENT} ORDER BY e.trial_id`,
  ).all() as { id: string }[]).map((r) => r.id);
}

/**
 * Builds the contract v1.1 `trialData` for ONE trial from stored records, using a fixed number of queries (sites, participants,
 * one joined visits query) no matter how many visits there are. `trialData` is null when nothing can be sent (no site with a valid
 * timezone, or no participants/visits). Nothing is guessed: unknown measurements stay null, a site without a timezone is left
 * out TOGETHER with its participants, visits and ECGs (the service refuses dangling references).
 *
 * Privacy (decision D11): opaque ids only. No names, dates of birth, contact data, free text or file contents; ECGs are sent as a
 * relative `imageRef`, never as bytes or an absolute filesystem path.
 */
export function buildTrialData(db: DB, trialId: string, asOf: Date): TrialDataBuild {
  const siteRows = db.prepare('SELECT id, site_code, timezone FROM trial_sites WHERE trial_id = ? ORDER BY site_code').all(trialId) as { id: string; site_code: string; timezone: string | null }[];
  const noTz: string[] = []; const badTz: string[] = []; const overCap: string[] = [];
  let sites = siteRows.filter((s) => {
    if (s.timezone == null) { noTz.push(s.id); return false; }
    if (!isCanonicalIanaTimezone(s.timezone)) { badTz.push(s.id); return false; }
    return true;
  });
  if (sites.length > TRIAL_DATA_LIMITS.sites) { overCap.push(...sites.slice(TRIAL_DATA_LIMITS.sites).map((s) => s.id)); sites = sites.slice(0, TRIAL_DATA_LIMITS.sites); }
  const siteIds = new Set(sites.map((s) => s.id));
  const empty = (): TrialDataBuild => ({ trialData: null, meta: { trialId, sitesSkippedNoTimezone: noTz, sitesSkippedInvalidTimezone: badTz, sitesSkippedOverCap: overCap, participants: 0, visits: 0, ecgs: 0, truncated: null } });
  if (siteIds.size === 0) return empty();

  const enrollments = db.prepare(
    `SELECT patient_id, trial_site_id, status FROM enrollments WHERE trial_id = ? AND status IN ${SCANNABLE_ENROLLMENT}`,
  ).all(trialId) as { patient_id: string; trial_site_id: string; status: string }[];
  const participantsAll: TrialParticipantRef[] = enrollments.filter((e) => siteIds.has(e.trial_site_id))
    .map((e) => ({ participantId: e.patient_id, siteId: e.trial_site_id, droppedOut: e.status === 'withdrawn' }));
  const participantIds = new Set(participantsAll.map((p) => p.participantId));
  if (participantIds.size === 0) return empty();

  // One joined query for visits + measurements + OTP exception + ECG reference. ROW_NUMBER numbers visits within an enrollment.
  const rows = db.prepare(
    `SELECT v.id, v.patient_id, v.trial_site_id, v.visit_type, v.status, v.scheduled_at, v.verified_at,
            ROW_NUMBER() OVER (PARTITION BY v.enrollment_id ORDER BY v.scheduled_at, v.rowid) AS rn,
            m.performed_at, m.entered_at, m.systolic_bp, m.diastolic_bp, m.heart_rate, m.weight_kg, m.glucose_mg_dl,
            x.reason_code, g.id AS ecg_id, g.file_ref
     FROM visits v
     JOIN enrollments e ON e.id = v.enrollment_id
     LEFT JOIN visit_measurements m ON m.visit_id = v.id
     LEFT JOIN visit_otp_exceptions x ON x.visit_id = v.id
     LEFT JOIN visit_ecgs g ON g.visit_id = v.id
     WHERE e.trial_id = ? AND e.status IN ${SCANNABLE_ENROLLMENT}
     ORDER BY v.scheduled_at DESC, v.rowid DESC`,
  ).all(trialId) as VisitRow[];

  const truncated: NonNullable<TrialDataMeta['truncated']> = {};
  let usable = rows.filter((r) => siteIds.has(r.trial_site_id) && participantIds.has(r.patient_id) && r.rn <= 100 && asIso(r.scheduled_at) !== null);
  if (usable.length > TRIAL_DATA_LIMITS.visits) { truncated.visits = usable.length - TRIAL_DATA_LIMITS.visits; usable = usable.slice(0, TRIAL_DATA_LIMITS.visits); }

  // ECG references: most recent first, capped. A visit whose ECG was dropped by the cap simply carries no ecgRecordId.
  const ecgRows = usable.filter((r) => r.ecg_id && r.file_ref);
  const keepEcg = new Set(ecgRows.slice(0, TRIAL_DATA_LIMITS.ecgs).map((r) => r.ecg_id as string));
  if (ecgRows.length > TRIAL_DATA_LIMITS.ecgs) truncated.ecgs = ecgRows.length - TRIAL_DATA_LIMITS.ecgs;

  let participants = participantsAll;
  if (participants.length > TRIAL_DATA_LIMITS.participants) {
    // Keep the participants of the most recent visits (visits are already newest-first), then drop visits of the others.
    const keep = new Set<string>();
    for (const r of usable) { if (keep.size >= TRIAL_DATA_LIMITS.participants) break; keep.add(r.patient_id); }
    truncated.participants = participants.length - keep.size;
    participants = participants.filter((p) => keep.has(p.participantId));
    usable = usable.filter((r) => keep.has(r.patient_id));
  }

  const visits: TrialVisit[] = []; const ecgs: TrialEcgRef[] = [];
  for (const r of usable.slice().reverse()) {          // oldest first, like the stored order
    const completed = r.status === 'completed';
    const otpVerified = completed ? r.verified_at != null : null;
    const ecgId = r.ecg_id && keepEcg.has(r.ecg_id) ? r.ecg_id : null;
    visits.push({
      visitId: r.id, participantId: r.patient_id, siteId: r.trial_site_id, visitNumber: r.rn,
      ...(r.visit_type ? { visitType: r.visit_type.slice(0, 60) } : {}),
      status: r.status as TrialVisit['status'],
      scheduledAt: asIso(r.scheduled_at)!,
      performedAt: asIso(r.performed_at), enteredAt: asIso(r.entered_at),
      otpVerified,
      otpExceptionReason: otpVerified === false && r.reason_code ? (r.reason_code as OtpExceptionReason) : null,
      systolicBp: r.systolic_bp, diastolicBp: r.diastolic_bp, heartRate: r.heart_rate, weightKg: r.weight_kg, glucoseMgDl: r.glucose_mg_dl,
      ecgRecordId: ecgId,
    });
    if (ecgId) ecgs.push({ ecgRecordId: ecgId, visitId: r.id, participantId: r.patient_id, siteId: r.trial_site_id, imageRef: r.file_ref as string });
  }

  const trialData: TrialData = {
    scope: { trialId, asOf: asOf.toISOString() },
    sites: sites.map((s) => ({ siteId: s.id, siteCode: s.site_code, timezone: s.timezone as string })),
    participants,
    visits,
    // `ecgs` is sent only when ECG records exist; omitting it makes the service skip the ECG step (it does not mean "no ECGs").
    ...(ecgs.length ? { ecgs } : {}),
  };
  // Never send what the service would reject: a malformed trial is skipped (reported by the caller), the audit scan still runs.
  if (!trialDataSchema.safeParse(trialData).success) return empty();
  return {
    trialData,
    meta: {
      trialId, sitesSkippedNoTimezone: noTz, sitesSkippedInvalidTimezone: badTz, sitesSkippedOverCap: overCap,
      participants: participants.length, visits: visits.length, ecgs: ecgs.length, truncated: Object.keys(truncated).length ? truncated : null,
    },
  };
}
