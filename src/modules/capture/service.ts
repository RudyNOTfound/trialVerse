import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { inTransaction, mapRow, mapRows, nowIso } from '../../utils/db';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent } from '../audit/chain';
import type { PatientService } from '../patients/service';
import type {
  createAdverseEventBody, createEcgBody, createMeasurementBody, createReminderBody, listAdverseEventsQuery, listEcgsQuery,
  listMeasurementsQuery, listRemindersQuery, updateReminderBody,
} from './schemas';

/**
 * Capture of the data the ML contract v1.1 needs: visit measurements, ECG references, reminders and adverse-event reports.
 * Every record lands in the tables the ML payload builders already read (src/modules/risk/features.ts, src/modules/integrity/trialData.ts),
 * so a captured record is visible to the next risk assessment / integrity scan with no further step.
 *
 * Access model (the application has no per-staff site assignment; staff roles are trial-wide):
 *  - the patient in the URL must exist; a participant may only use their OWN patient id (otherwise 403, whether or not it exists);
 *  - any visit / enrollment named in a body must belong to THAT patient, otherwise 404;
 *  - who may write is decided by the routes (requireRole); who may read by `assertCanRead`.
 * Audit metadata carries ids and field NAMES only, never measurement values.
 */

export interface MeasurementDto {
  /** The visit id: there is at most one measurement set per visit. */
  id: string; visitId: string; patientId: string; trialId: string; performedAt: string; enteredAt: string; enteredBy: string;
  systolicBp: number | null; diastolicBp: number | null; heartRate: number | null; weightKg: number | null; glucoseMgDl: number | null;
}
export interface EcgDto {
  id: string; visitId: string; patientId: string; trialId: string; recordedAt: string | null; createdBy: string; createdAt: string;
  /** Storage details: omitted for participants. */
  fileRef?: string; fileSha256?: string | null;
}
export type ReminderOutcome = 'sent' | 'acknowledged' | 'missed';
export interface ReminderDto {
  id: string; enrollmentId: string; patientId: string; trialId: string; visitId: string | null; channel: string; sentAt: string; outcome: ReminderOutcome;
  acknowledgedAt: string | null; outcomeRecordedAt: string | null; recordedBy: string | null; createdAt: string;
}
export interface AdverseEventDto {
  id: string; enrollmentId: string; patientId: string; trialId: string; visitId: string | null; reportedAt: string; createdBy: string; createdAt: string;
}

/** sent -> acknowledged | missed; a resolved reminder is final (its outcome feeds the missed-reminders statistic and must not be rewritten). */
export const REMINDER_TRANSITIONS: TransitionMap<ReminderOutcome> = { sent: ['acknowledged', 'missed'], acknowledged: [], missed: [] };

/** No measurements or ECGs for a visit that did not take place. */
const NO_RECORDING = new Set(['cancelled', 'missed']);
const CLOCK_SKEW_MS = 5 * 60_000;

interface Page { page: number; pageSize: number }
const offset = (p: Page) => (p.page - 1) * p.pageSize;
const iso = (v: string) => new Date(v).toISOString();

export function createCaptureService(ctx: Ctx, patients: PatientService) {
  const { db } = ctx;

  // ------------------------------------------------------------------------------------------ access
  /** The patient named in the URL. A participant gets 403 for anything but their own record (no existence oracle). */
  function patientFor(patientId: string, actor: Actor) {
    const p = patients.find(patientId);
    if (actor.role === 'patient') {
      if (!p || p.userId !== actor.id) throw AppError.forbidden();
      return p;
    }
    if (!p) throw AppError.notFound('Patient');
    return p;
  }
  /** Record-level read: a participant asking for somebody else's record gets the same 404 as for one that does not exist. */
  function assertCanRead(patientId: string, actor: Actor, what: string) {
    if (actor.role !== 'patient') return;
    const p = patients.find(patientId);
    if (!p || p.userId !== actor.id) throw AppError.notFound(what);
  }
  const visitOf = (patientId: string, visitId: string) => {
    const v = db.prepare('SELECT id, patient_id, enrollment_id, trial_id, status FROM visits WHERE id = ? AND patient_id = ?').get(visitId, patientId) as
      | { id: string; patient_id: string; enrollment_id: string; trial_id: string; status: string } | undefined;
    if (!v) throw AppError.notFound('Visit for this patient');
    return v;
  };
  /** Which enrollment (and visit, if any) a reminder / adverse event is about; both must belong to the patient and agree with each other. */
  function resolveTarget(patientId: string, t: { enrollmentId?: string; visitId?: string }) {
    let enrollmentId = t.enrollmentId; let visitId: string | null = null;
    if (t.visitId) {
      const v = visitOf(patientId, t.visitId);
      if (enrollmentId && enrollmentId !== v.enrollment_id) throw AppError.validation('visitId does not belong to enrollmentId');
      enrollmentId = v.enrollment_id; visitId = v.id;
    }
    const e = db.prepare('SELECT id, trial_id FROM enrollments WHERE id = ? AND patient_id = ?').get(enrollmentId, patientId) as { id: string; trial_id: string } | undefined;
    if (!e) throw AppError.notFound('Enrollment for this patient');
    return { enrollmentId: e.id, trialId: e.trial_id, visitId };
  }

  // ------------------------------------------------------------------------------------------ measurements
  const MEAS_SELECT = `SELECT m.visit_id AS id, m.visit_id, v.patient_id, v.trial_id, m.performed_at, m.entered_at, m.entered_by,
      m.systolic_bp, m.diastolic_bp, m.heart_rate, m.weight_kg, m.glucose_mg_dl FROM visit_measurements m JOIN visits v ON v.id = m.visit_id`;
  const measurement = (visitId: string) => mapRow<MeasurementDto>(db.prepare(`${MEAS_SELECT} WHERE m.visit_id = ?`).get(visitId) as any);

  // ------------------------------------------------------------------------------------------ ecgs
  const ECG_SELECT = `SELECT g.id, g.visit_id, v.patient_id, v.trial_id, g.file_ref, g.file_sha256, g.recorded_at, g.created_by, g.created_at FROM visit_ecgs g JOIN visits v ON v.id = g.visit_id`;
  const shapeEcg = (e: EcgDto, actor: Actor): EcgDto => {
    if (actor.role !== 'patient') return e;
    const { fileRef: _f, fileSha256: _s, ...rest } = e;
    return rest;
  };

  // ------------------------------------------------------------------------------------------ reminders / adverse events
  const REM_SELECT = `SELECT r.id, r.enrollment_id, e.patient_id, e.trial_id, r.visit_id, r.channel, r.sent_at, r.outcome, r.acknowledged_at,
      r.outcome_recorded_at, r.recorded_by, r.created_at FROM visit_reminders r JOIN enrollments e ON e.id = r.enrollment_id`;
  const reminder = (id: string) => mapRow<ReminderDto>(db.prepare(`${REM_SELECT} WHERE r.id = ?`).get(id) as any);
  const AE_SELECT = `SELECT a.id, a.enrollment_id, e.patient_id, e.trial_id, a.visit_id, a.reported_at, a.created_by, a.created_at FROM adverse_event_reports a JOIN enrollments e ON e.id = a.enrollment_id`;
  const adverseEvent = (id: string) => mapRow<AdverseEventDto>(db.prepare(`${AE_SELECT} WHERE a.id = ?`).get(id) as any);

  function page<T>(select: string, where: string[], params: unknown[], order: string, q: Page & { order: 'asc' | 'desc' }, countFrom: string) {
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) c ${countFrom} ${w}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`${select} ${w} ORDER BY ${order} ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).all(...params, q.pageSize, offset(q)) as any[];
    return { items: mapRows<T>(rows), total };
  }

  return {
    // ====================================================================== measurements
    createMeasurement(patientId: string, input: z.infer<typeof createMeasurementBody>, actor: Actor): MeasurementDto {
      patientFor(patientId, actor);
      inTransaction(db, () => {
        const v = visitOf(patientId, input.visitId);
        if (NO_RECORDING.has(v.status)) throw AppError.conflict(`Measurements cannot be recorded for a visit with status '${v.status}'`);
        if (db.prepare('SELECT 1 FROM visit_measurements WHERE visit_id = ?').get(v.id)) throw AppError.conflict('This visit already has a measurement set');
        const entries = ([['systolicBp', input.systolicBp], ['diastolicBp', input.diastolicBp], ['heartRate', input.heartRate], ['weightKg', input.weightKg], ['glucoseMgDl', input.glucoseMgDl]] as const)
          .filter(([, x]) => x !== undefined).map(([k]) => k);
        // entered_at is stamped by the SERVER: a client-supplied entry time could be forged, and the integrity engine compares it with performed_at.
        db.prepare(`INSERT INTO visit_measurements (visit_id, performed_at, entered_at, entered_by, systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(v.id, iso(input.performedAt), nowIso(), actor.id, input.systolicBp ?? null, input.diastolicBp ?? null, input.heartRate ?? null, input.weightKg ?? null, input.glucoseMgDl ?? null);
        appendAuditEvent(db, { actorId: actor.id, action: 'measurement.recorded', entityType: 'measurement', entityId: v.id,
          metadata: { patientId, trialId: v.trial_id, visitId: v.id, fields: entries } });
      });
      return measurement(input.visitId)!;
    },
    listMeasurements(patientId: string, q: z.infer<typeof listMeasurementsQuery>, actor: Actor) {
      patientFor(patientId, actor);
      const where = ['v.patient_id = ?']; const params: unknown[] = [patientId];
      if (q.visitId) { where.push('m.visit_id = ?'); params.push(q.visitId); }
      return page<MeasurementDto>(MEAS_SELECT, where, params, 'm.performed_at', q, 'FROM visit_measurements m JOIN visits v ON v.id = m.visit_id');
    },
    getMeasurement(id: string, actor: Actor): MeasurementDto {
      const m = measurement(id);
      if (!m) throw AppError.notFound('Measurement');
      assertCanRead(m.patientId, actor, 'Measurement');
      return m;
    },

    // ====================================================================== ECG references
    registerEcg(patientId: string, input: z.infer<typeof createEcgBody>, actor: Actor): EcgDto {
      patientFor(patientId, actor);
      const id = randomUUID();
      inTransaction(db, () => {
        const v = visitOf(patientId, input.visitId);
        if (NO_RECORDING.has(v.status)) throw AppError.conflict(`An ECG cannot be registered for a visit with status '${v.status}'`);
        if (db.prepare('SELECT 1 FROM visit_ecgs WHERE visit_id = ?').get(v.id)) throw AppError.conflict('This visit already has an ECG record');
        // A fileRef that other records already use is accepted on purpose: detecting re-used images is the integrity engine's job.
        db.prepare('INSERT INTO visit_ecgs (id, visit_id, file_ref, file_sha256, recorded_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, v.id, input.fileRef, input.fileSha256 ?? null, input.recordedAt ? iso(input.recordedAt) : null, actor.id, nowIso());
        appendAuditEvent(db, { actorId: actor.id, action: 'ecg.registered', entityType: 'ecg', entityId: id,
          metadata: { patientId, trialId: v.trial_id, visitId: v.id, hasSha256: input.fileSha256 !== undefined } });
      });
      return shapeEcg(mapRow<EcgDto>(db.prepare(`${ECG_SELECT} WHERE g.id = ?`).get(id) as any)!, actor);
    },
    listEcgs(patientId: string, q: z.infer<typeof listEcgsQuery>, actor: Actor) {
      patientFor(patientId, actor);
      const where = ['v.patient_id = ?']; const params: unknown[] = [patientId];
      if (q.visitId) { where.push('g.visit_id = ?'); params.push(q.visitId); }
      const r = page<EcgDto>(ECG_SELECT, where, params, 'g.created_at', q, 'FROM visit_ecgs g JOIN visits v ON v.id = g.visit_id');
      return { ...r, items: r.items.map((e) => shapeEcg(e, actor)) };
    },
    getEcg(id: string, actor: Actor): EcgDto {
      const e = mapRow<EcgDto>(db.prepare(`${ECG_SELECT} WHERE g.id = ?`).get(id) as any);
      if (!e) throw AppError.notFound('ECG record');
      assertCanRead(e.patientId, actor, 'ECG record');
      return shapeEcg(e, actor);
    },

    // ====================================================================== reminders
    createReminder(patientId: string, input: z.infer<typeof createReminderBody>, actor: Actor): ReminderDto {
      patientFor(patientId, actor);
      const id = randomUUID();
      inTransaction(db, () => {
        const t = resolveTarget(patientId, input);
        const now = nowIso();
        db.prepare(`INSERT INTO visit_reminders (id, enrollment_id, visit_id, channel, sent_at, outcome, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`)
          .run(id, t.enrollmentId, t.visitId, input.channel, iso(input.sentAt), actor.id, now);
        appendAuditEvent(db, { actorId: actor.id, action: 'reminder.created', entityType: 'reminder', entityId: id,
          metadata: { patientId, trialId: t.trialId, enrollmentId: t.enrollmentId, visitId: t.visitId, channel: input.channel } });
      });
      return reminder(id)!;
    },
    listReminders(patientId: string, q: z.infer<typeof listRemindersQuery>, actor: Actor) {
      patientFor(patientId, actor);
      const where = ['e.patient_id = ?']; const params: unknown[] = [patientId];
      if (q.outcome) { where.push('r.outcome = ?'); params.push(q.outcome); }
      if (q.enrollmentId) { where.push('r.enrollment_id = ?'); params.push(q.enrollmentId); }
      return page<ReminderDto>(REM_SELECT, where, params, 'r.sent_at', q, 'FROM visit_reminders r JOIN enrollments e ON e.id = r.enrollment_id');
    },
    getReminder(id: string, actor: Actor): ReminderDto {
      const r = reminder(id);
      if (!r) throw AppError.notFound('Reminder');
      assertCanRead(r.patientId, actor, 'Reminder');
      return r;
    },
    /** Resolve a reminder once. The outcome is written explicitly (never computed at read time), so `missed_reminders` stays reproducible. */
    updateReminder(id: string, input: z.infer<typeof updateReminderBody>, actor: Actor): ReminderDto {
      inTransaction(db, () => {
        const r = reminder(id);
        if (!r) throw AppError.notFound('Reminder');
        assertTransition('Reminder', REMINDER_TRANSITIONS, r.outcome, input.outcome);
        const now = nowIso();
        let acknowledgedAt: string | null = null;
        if (input.outcome === 'acknowledged') {
          acknowledgedAt = input.acknowledgedAt ? iso(input.acknowledgedAt) : now;
          if (Date.parse(acknowledgedAt) < Date.parse(r.sentAt)) throw AppError.validation('acknowledgedAt cannot be earlier than the time the reminder was sent');
          if (Date.parse(acknowledgedAt) > Date.now() + CLOCK_SKEW_MS) throw AppError.validation('acknowledgedAt cannot be in the future');
        }
        db.prepare('UPDATE visit_reminders SET outcome = ?, acknowledged_at = ?, outcome_recorded_at = ?, recorded_by = ? WHERE id = ?').run(input.outcome, acknowledgedAt, now, actor.id, id);
        appendAuditEvent(db, { actorId: actor.id, action: 'reminder.outcome_recorded', entityType: 'reminder', entityId: id,
          metadata: { patientId: r.patientId, trialId: r.trialId, enrollmentId: r.enrollmentId, from: r.outcome, to: input.outcome } });
      });
      return reminder(id)!;
    },

    // ====================================================================== adverse events
    reportAdverseEvent(patientId: string, input: z.infer<typeof createAdverseEventBody>, actor: Actor): AdverseEventDto {
      patientFor(patientId, actor);
      const id = randomUUID();
      inTransaction(db, () => {
        const t = resolveTarget(patientId, input);
        const now = nowIso();
        db.prepare('INSERT INTO adverse_event_reports (id, enrollment_id, visit_id, reported_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, t.enrollmentId, t.visitId, input.reportedAt ? iso(input.reportedAt) : now, actor.id, now);
        appendAuditEvent(db, { actorId: actor.id, action: 'adverse_event.reported', entityType: 'adverse_event', entityId: id,
          metadata: { patientId, trialId: t.trialId, enrollmentId: t.enrollmentId, visitId: t.visitId, reportedByRole: actor.role } });
      });
      return adverseEvent(id)!;
    },
    listAdverseEvents(patientId: string, q: z.infer<typeof listAdverseEventsQuery>, actor: Actor) {
      patientFor(patientId, actor);
      const where = ['e.patient_id = ?']; const params: unknown[] = [patientId];
      if (q.enrollmentId) { where.push('a.enrollment_id = ?'); params.push(q.enrollmentId); }
      return page<AdverseEventDto>(AE_SELECT, where, params, 'a.reported_at', q, 'FROM adverse_event_reports a JOIN enrollments e ON e.id = a.enrollment_id');
    },
    getAdverseEvent(id: string, actor: Actor): AdverseEventDto {
      const a = adverseEvent(id);
      if (!a) throw AppError.notFound('Adverse event');
      assertCanRead(a.patientId, actor, 'Adverse event');
      return a;
    },
  };
}

export type CaptureService = ReturnType<typeof createCaptureService>;
