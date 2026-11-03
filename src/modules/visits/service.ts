import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { changedKeys, inTransaction, mapRow, mapRows, nowIso, orderBy, updateRow } from '../../utils/db';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent } from '../audit/chain';
import { createLookups } from '../../utils/lookups';
import type { PatientService } from '../patients/service';
import type { createVisitBody, listVisitsQuery, updateVisitBody } from './schemas';

export type VisitStatus = 'scheduled' | 'otp_pending' | 'verified' | 'completed' | 'missed' | 'cancelled';

export interface VisitDto {
  id: string; enrollmentId: string; patientId: string; trialId: string; trialSiteId: string; visitType: string;
  scheduledAt: string; status: VisitStatus; otpIssuedAt: string | null; verifiedAt: string | null; verifiedBy: string | null;
  completedAt: string | null; notes: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
  /** Embedded display names (additive, read-only). */
  patientName?: string | null; patientCode?: string | null; trialCode?: string | null; trialTitle?: string | null;
  siteName?: string | null; verifiedByName?: string | null;
  /** `verified_at IS NOT NULL`. False for a visit completed through the OTP-exception path. */
  otpVerified?: boolean;
  /** Present when the visit was completed without OTP verification. `note` is for investigator/admin only (stripped by the routes). */
  otpException?: { reasonCode: string; recordedBy: string; recordedByName: string | null; recordedAt: string; note?: string } | null;
}

/** `otp_pending` and `verified` are reachable only through the OTP flow, never via the status endpoint. */
export const VISIT_TRANSITIONS: TransitionMap<VisitStatus> = {
  scheduled: ['otp_pending', 'missed', 'cancelled'],
  otp_pending: ['verified', 'missed', 'cancelled'],
  verified: ['completed', 'cancelled'],
  completed: [],
  missed: [],
  cancelled: [],
};

const COLS = `id, enrollment_id, patient_id, trial_id, trial_site_id, visit_type, scheduled_at, status, otp_issued_at,
  verified_at, verified_by, completed_at, notes, created_by, created_at, updated_at`;

export function createVisitService(ctx: Ctx, patients: PatientService) {
  const { db } = ctx;
  const lookups = createLookups(db);

  /** One batched query for the OTP exceptions of a page of visits. */
  const otpExceptionsFor = (ids: string[]) => {
    const out = new Map<string, { reasonCode: string; recordedBy: string; recordedByName: string | null; recordedAt: string; note: string }>();
    if (ids.length === 0) return out;
    const rows = db.prepare(`SELECT visit_id, reason_code, note, recorded_by, recorded_at FROM visit_otp_exceptions WHERE visit_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ visit_id: string; reason_code: string; note: string; recorded_by: string; recorded_at: string }>;
    for (const r of rows) out.set(r.visit_id, { reasonCode: r.reason_code, recordedBy: r.recorded_by, recordedByName: null, recordedAt: r.recorded_at, note: r.note });
    return out;
  };

  /** Adds patient / trial / site / verifier names with one batched query per related table. */
  const withNames = (items: VisitDto[]): VisitDto[] => {
    const p = lookups.patients(items.map((v) => v.patientId));
    const t = lookups.trials(items.map((v) => v.trialId));
    const s = lookups.sites(items.map((v) => v.trialSiteId));
    const exc = otpExceptionsFor(items.map((v) => v.id));
    const u = lookups.users([...items.map((v) => v.verifiedBy), ...[...exc.values()].map((e) => e.recordedBy)]);
    return items.map((v) => ({
      ...v,
      otpVerified: v.verifiedAt != null,
      otpException: exc.has(v.id) ? { ...exc.get(v.id)!, recordedByName: u.get(exc.get(v.id)!.recordedBy)?.name ?? null } : null,
      patientName: p.get(v.patientId)?.name ?? null, patientCode: p.get(v.patientId)?.code ?? null,
      trialCode: t.get(v.trialId)?.code ?? null, trialTitle: t.get(v.trialId)?.title ?? null,
      siteName: s.get(v.trialSiteId)?.name ?? null, verifiedByName: v.verifiedBy ? u.get(v.verifiedBy)?.name ?? null : null,
    }));
  };

  const get = (id: string): VisitDto => {
    const v = mapRow<VisitDto>(db.prepare(`SELECT ${COLS} FROM visits WHERE id = ?`).get(id) as any);
    if (!v) throw AppError.notFound('Visit');
    return withNames([v])[0]!;
  };

  /** Patients may access only visits that belong to their own patient record. */
  const assertAccess = (visit: VisitDto, actor: Actor) => {
    if (actor.role !== 'patient') return;
    const own = patients.find(visit.patientId);
    if (!own || own.userId !== actor.id) throw AppError.forbidden();
  };

  return {
    get,
    assertAccess,

    getForActor(id: string, actor: Actor): VisitDto {
      const v = get(id);
      assertAccess(v, actor);
      return v;
    },

    create(input: z.infer<typeof createVisitBody>, actor: Actor): VisitDto {
      const id = randomUUID();
      const now = nowIso();
      inTransaction(db, () => {
        const enr = db.prepare('SELECT patient_id, trial_id, trial_site_id, status FROM enrollments WHERE id = ?').get(input.enrollmentId) as
          | { patient_id: string; trial_id: string; trial_site_id: string; status: string } | undefined;
        if (!enr) throw AppError.notFound('Enrollment');
        if (!['screening', 'enrolled'].includes(enr.status)) throw AppError.conflict(`Cannot schedule visits for an enrolment with status '${enr.status}'`);
        const trial = db.prepare('SELECT status FROM trials WHERE id = ? AND deleted_at IS NULL').get(enr.trial_id) as { status: string } | undefined;
        if (!trial || !['draft', 'active'].includes(trial.status)) throw AppError.conflict('Trial is not accepting visits');
        db.prepare(
          `INSERT INTO visits (id, enrollment_id, patient_id, trial_id, trial_site_id, visit_type, scheduled_at, status, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
        ).run(id, input.enrollmentId, enr.patient_id, enr.trial_id, enr.trial_site_id, input.visitType, new Date(input.scheduledAt).toISOString(), input.notes ?? null, actor.id, now, now);
        appendAuditEvent(db, {
          actorId: actor.id, action: 'visit.created', entityType: 'visit', entityId: id,
          metadata: { patientId: enr.patient_id, trialId: enr.trial_id, visitType: input.visitType, scheduledAt: input.scheduledAt },
        });
      });
      return get(id);
    },

    list(q: z.infer<typeof listVisitsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [
        ['patient_id', q.patientId], ['trial_id', q.trialId], ['trial_site_id', q.trialSiteId],
        ['enrollment_id', q.enrollmentId], ['status', q.status],
      ] as const) if (v) { where.push(`${col} = ?`); params.push(v); }
      if (q.from) { where.push('scheduled_at >= ?'); params.push(new Date(q.from).toISOString()); }
      if (q.to) { where.push('scheduled_at <= ?'); params.push(new Date(q.to).toISOString()); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM visits ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { scheduledAt: 'scheduled_at', createdAt: 'created_at' }, 'scheduled_at');
      const rows = db.prepare(`SELECT ${COLS} FROM visits ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: withNames(mapRows<VisitDto>(rows)), total };
    },

    update(id: string, patch: z.infer<typeof updateVisitBody>, actor: Actor): VisitDto {
      inTransaction(db, () => {
        const v = get(id);
        if (!['scheduled', 'otp_pending'].includes(v.status)) throw AppError.conflict(`A visit with status '${v.status}' can no longer be edited`);
        const norm = { ...patch, ...(patch.scheduledAt ? { scheduledAt: new Date(patch.scheduledAt).toISOString() } : {}) };
        const keys = changedKeys(v as unknown as Record<string, unknown>, norm);
        if (keys.length === 0) return;
        updateRow(db, 'visits', id, Object.fromEntries(keys.map((k) => [k, (norm as Record<string, unknown>)[k]])));
        appendAuditEvent(db, {
          actorId: actor.id, action: 'visit.updated', entityType: 'visit', entityId: id,
          metadata: {
            changedFields: keys,
            ...(keys.includes('scheduledAt') ? { scheduledAt: { from: v.scheduledAt, to: norm.scheduledAt } } : {}),
          },
        });
      });
      return get(id);
    },

    /** Terminal transitions: completed (requires verification), missed, cancelled. */
    changeStatus(id: string, status: 'completed' | 'missed' | 'cancelled', note: string | undefined, actor: Actor, otpException?: { reasonCode: string; note: string }): VisitDto {
      inTransaction(db, () => {
        const v = get(id);
        const now = nowIso();
        if (otpException) {
          // Exception path (explicit and audited). The state machine itself is untouched: without `otpException` the usual
          // 409 INVALID_STATE_TRANSITION still applies. The visit is NEVER marked verified (verified_at stays NULL).
          if (status !== 'completed') throw AppError.otpExceptionNotApplicable("otpException only applies when status is 'completed'");
          if (!['scheduled', 'otp_pending'].includes(v.status)) throw AppError.otpExceptionNotApplicable(`otpException does not apply to a visit with status '${v.status}'`);
          db.prepare('INSERT INTO visit_otp_exceptions (id, visit_id, reason_code, note, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), id, otpException.reasonCode, otpException.note, actor.id, now);
          updateRow(db, 'visits', id, { status: 'completed', completedAt: now });
          db.prepare(`UPDATE otp_records SET status = 'superseded', updated_at = ? WHERE visit_id = ? AND status = 'active'`).run(now, id);
          appendAuditEvent(db, {
            actorId: actor.id, action: 'visit.completed_without_otp', entityType: 'visit', entityId: id,
            // The free-text note stays in the database; only the reason code enters the hash-chained audit metadata.
            metadata: { from: v.status, to: 'completed', patientId: v.patientId, trialId: v.trialId, reasonCode: otpException.reasonCode },
          });
          return;
        }
        assertTransition('Visit', VISIT_TRANSITIONS, v.status, status);
        updateRow(db, 'visits', id, { status, ...(status === 'completed' ? { completedAt: now } : {}) });
        // Any live OTP must not outlive a closed visit.
        if (status !== 'completed') {
          db.prepare(`UPDATE otp_records SET status = 'superseded', updated_at = ? WHERE visit_id = ? AND status = 'active'`).run(now, id);
        }
        appendAuditEvent(db, {
          actorId: actor.id, action: `visit.${status}`, entityType: 'visit', entityId: id,
          metadata: { from: v.status, to: status, patientId: v.patientId, trialId: v.trialId, ...(note ? { note } : {}) },
        });
      });
      return get(id);
    },
  };
}

export type VisitService = ReturnType<typeof createVisitService>;
