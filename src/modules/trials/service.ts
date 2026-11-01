import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { changedKeys, inTransaction, mapRow, mapRows, nowIso, orderBy, updateRow } from '../../utils/db';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent } from '../audit/chain';
import type { createEnrollmentBody, createSiteBody, createTrialBody, listEnrollmentsQuery, listTrialsQuery, updateSiteBody, updateTrialBody } from './schemas';

export interface TrialDto {
  id: string; code: string; title: string; description: string | null; sponsor: string; phase: string; status: string;
  startDate: string | null; endDate: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface SiteDto {
  id: string; trialId: string; siteCode: string; name: string; city: string | null; country: string;
  principalInvestigatorId: string | null; status: string; createdAt: string; updatedAt: string;
}
export interface EnrollmentDto {
  id: string; patientId: string; trialId: string; trialSiteId: string; status: string; arm: string | null;
  enrolledAt: string | null; endedAt: string | null; createdAt: string; updatedAt: string;
}

type TrialStatus = 'draft' | 'active' | 'suspended' | 'completed' | 'terminated';
export const TRIAL_TRANSITIONS: TransitionMap<TrialStatus> = {
  draft: ['active', 'terminated'],
  active: ['suspended', 'completed', 'terminated'],
  suspended: ['active', 'terminated'],
  completed: [],
  terminated: [],
};

type EnrollmentStatus = 'screening' | 'enrolled' | 'completed' | 'withdrawn' | 'screen_failed';
export const ENROLLMENT_TRANSITIONS: TransitionMap<EnrollmentStatus> = {
  screening: ['enrolled', 'screen_failed', 'withdrawn'],
  enrolled: ['completed', 'withdrawn'],
  completed: [],
  withdrawn: [],
  screen_failed: [],
};

const TRIAL_COLS = 'id, code, title, description, sponsor, phase, status, start_date, end_date, created_by, created_at, updated_at';
const SITE_COLS = 'id, trial_id, site_code, name, city, country, principal_investigator_id, status, created_at, updated_at';
const ENR_COLS = 'id, patient_id, trial_id, trial_site_id, status, arm, enrolled_at, ended_at, created_at, updated_at';

const isUnique = (err: unknown) => (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

export function createTrialService(ctx: Ctx) {
  const { db } = ctx;

  const getTrial = (id: string): TrialDto => {
    const t = mapRow<TrialDto>(db.prepare(`SELECT ${TRIAL_COLS} FROM trials WHERE id = ? AND deleted_at IS NULL`).get(id) as any);
    if (!t) throw AppError.notFound('Trial');
    return t;
  };
  const getSite = (trialId: string, siteId: string): SiteDto => {
    const s = mapRow<SiteDto>(db.prepare(`SELECT ${SITE_COLS} FROM trial_sites WHERE id = ? AND trial_id = ?`).get(siteId, trialId) as any);
    if (!s) throw AppError.notFound('Trial site');
    return s;
  };
  const getEnrollment = (id: string): EnrollmentDto => {
    const e = mapRow<EnrollmentDto>(db.prepare(`SELECT ${ENR_COLS} FROM enrollments WHERE id = ?`).get(id) as any);
    if (!e) throw AppError.notFound('Enrollment');
    return e;
  };
  const assertInvestigator = (userId: string) => {
    const u = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(userId) as { role: string; is_active: number } | undefined;
    if (!u || !u.is_active || u.role !== 'investigator') throw AppError.validation('principalInvestigatorId must reference an active investigator');
  };

  return {
    getTrial, getSite, getEnrollment,

    createTrial(input: z.infer<typeof createTrialBody>, actor: Actor): TrialDto {
      const id = randomUUID();
      const now = nowIso();
      try {
        inTransaction(db, () => {
          db.prepare(
            `INSERT INTO trials (id, code, title, description, sponsor, phase, status, start_date, end_date, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
          ).run(id, input.code, input.title, input.description ?? null, input.sponsor, input.phase, input.startDate ?? null, input.endDate ?? null, actor.id, now, now);
          appendAuditEvent(db, { actorId: actor.id, action: 'trial.created', entityType: 'trial', entityId: id, metadata: { code: input.code } });
        });
      } catch (err) {
        if (isUnique(err)) throw AppError.conflict('A trial with this code already exists');
        throw err;
      }
      return getTrial(id);
    },

    listTrials(q: z.infer<typeof listTrialsQuery>) {
      const where = ['deleted_at IS NULL'];
      const params: unknown[] = [];
      if (q.status) { where.push('status = ?'); params.push(q.status); }
      if (q.phase) { where.push('phase = ?'); params.push(q.phase); }
      if (q.search) { where.push('(code LIKE ? OR title LIKE ? OR sponsor LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)); }
      const w = `WHERE ${where.join(' AND ')}`;
      const total = (db.prepare(`SELECT COUNT(*) c FROM trials ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'created_at', code: 'code', title: 'title', startDate: 'start_date' }, 'created_at');
      const rows = db.prepare(`SELECT ${TRIAL_COLS} FROM trials ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<TrialDto>(rows), total };
    },

    updateTrial(id: string, patch: z.infer<typeof updateTrialBody>, actor: Actor): TrialDto {
      inTransaction(db, () => {
        const existing = getTrial(id);
        const start = patch.startDate ?? existing.startDate;
        const end = patch.endDate ?? existing.endDate;
        if (start && end && end < start) throw AppError.validation('endDate must not be before startDate');
        if (patch.status && patch.status !== existing.status) assertTransition('Trial', TRIAL_TRANSITIONS, existing.status as TrialStatus, patch.status);
        const keys = changedKeys(existing as unknown as Record<string, unknown>, patch);
        if (keys.length === 0) return;
        updateRow(db, 'trials', id, Object.fromEntries(keys.map((k) => [k, (patch as Record<string, unknown>)[k]])));
        appendAuditEvent(db, {
          actorId: actor.id, action: 'trial.updated', entityType: 'trial', entityId: id,
          metadata: { changedFields: keys, ...(keys.includes('status') ? { status: { from: existing.status, to: patch.status } } : {}) },
        });
      });
      return getTrial(id);
    },

    removeTrial(id: string, actor: Actor): void {
      inTransaction(db, () => {
        getTrial(id);
        const n = (db.prepare('SELECT COUNT(*) c FROM enrollments WHERE trial_id = ?').get(id) as { c: number }).c;
        if (n > 0) throw AppError.conflict('Trial has enrollments and cannot be deleted; terminate it instead');
        const now = nowIso();
        db.prepare('UPDATE trials SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
        appendAuditEvent(db, { actorId: actor.id, action: 'trial.deleted', entityType: 'trial', entityId: id, metadata: {} });
      });
    },

    // ---- sites ----
    createSite(trialId: string, input: z.infer<typeof createSiteBody>, actor: Actor): SiteDto {
      const id = randomUUID();
      const now = nowIso();
      try {
        inTransaction(db, () => {
          getTrial(trialId);
          if (input.principalInvestigatorId) assertInvestigator(input.principalInvestigatorId);
          db.prepare(
            `INSERT INTO trial_sites (id, trial_id, site_code, name, city, country, principal_investigator_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          ).run(id, trialId, input.siteCode, input.name, input.city ?? null, input.country, input.principalInvestigatorId ?? null, now, now);
          appendAuditEvent(db, { actorId: actor.id, action: 'trial_site.created', entityType: 'trial_site', entityId: id, metadata: { trialId, siteCode: input.siteCode } });
        });
      } catch (err) {
        if (isUnique(err)) throw AppError.conflict('This trial already has a site with that siteCode');
        throw err;
      }
      return getSite(trialId, id);
    },

    listSites(trialId: string): SiteDto[] {
      getTrial(trialId);
      return mapRows<SiteDto>(db.prepare(`SELECT ${SITE_COLS} FROM trial_sites WHERE trial_id = ? ORDER BY site_code`).all(trialId) as any[]);
    },

    updateSite(trialId: string, siteId: string, patch: z.infer<typeof updateSiteBody>, actor: Actor): SiteDto {
      inTransaction(db, () => {
        const existing = getSite(trialId, siteId);
        if (patch.principalInvestigatorId) assertInvestigator(patch.principalInvestigatorId);
        const keys = changedKeys(existing as unknown as Record<string, unknown>, patch);
        if (keys.length === 0) return;
        updateRow(db, 'trial_sites', siteId, Object.fromEntries(keys.map((k) => [k, (patch as Record<string, unknown>)[k]])));
        appendAuditEvent(db, { actorId: actor.id, action: 'trial_site.updated', entityType: 'trial_site', entityId: siteId, metadata: { trialId, changedFields: keys } });
      });
      return getSite(trialId, siteId);
    },

    // ---- enrollments ----
    createEnrollment(input: z.infer<typeof createEnrollmentBody>, actor: Actor): EnrollmentDto {
      const id = randomUUID();
      const now = nowIso();
      try {
        inTransaction(db, () => {
          const trial = getTrial(input.trialId);
          if (!['draft', 'active'].includes(trial.status)) throw AppError.conflict(`Cannot enrol into a trial with status '${trial.status}'`);
          const patient = db.prepare('SELECT status FROM patients WHERE id = ? AND deleted_at IS NULL').get(input.patientId) as { status: string } | undefined;
          if (!patient) throw AppError.notFound('Patient');
          if (patient.status !== 'active') throw AppError.conflict(`Patient status is '${patient.status}'`);
          const site = getSite(input.trialId, input.trialSiteId);
          if (site.status !== 'active') throw AppError.conflict('Trial site is not active');
          db.prepare(
            `INSERT INTO enrollments (id, patient_id, trial_id, trial_site_id, status, arm, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'screening', ?, ?, ?)`,
          ).run(id, input.patientId, input.trialId, input.trialSiteId, input.arm ?? null, now, now);
          appendAuditEvent(db, {
            actorId: actor.id, action: 'enrollment.created', entityType: 'enrollment', entityId: id,
            metadata: { patientId: input.patientId, trialId: input.trialId, trialSiteId: input.trialSiteId },
          });
        });
      } catch (err) {
        if (isUnique(err)) throw AppError.conflict('Patient is already enrolled in this trial');
        throw err;
      }
      return getEnrollment(id);
    },

    listEnrollments(q: z.infer<typeof listEnrollmentsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [['trial_id', q.trialId], ['patient_id', q.patientId], ['trial_site_id', q.trialSiteId], ['status', q.status]] as const) {
        if (v) { where.push(`${col} = ?`); params.push(v); }
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM enrollments ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'created_at', enrolledAt: 'enrolled_at' }, 'created_at');
      const rows = db.prepare(`SELECT ${ENR_COLS} FROM enrollments ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<EnrollmentDto>(rows), total };
    },

    updateEnrollmentStatus(id: string, status: EnrollmentStatus, actor: Actor): EnrollmentDto {
      inTransaction(db, () => {
        const e = getEnrollment(id);
        assertTransition('Enrollment', ENROLLMENT_TRANSITIONS, e.status as EnrollmentStatus, status);
        const now = nowIso();
        updateRow(db, 'enrollments', id, {
          status,
          ...(status === 'enrolled' ? { enrolledAt: now } : {}),
          ...(['completed', 'withdrawn', 'screen_failed'].includes(status) ? { endedAt: now } : {}),
        });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'enrollment.status_changed', entityType: 'enrollment', entityId: id,
          metadata: { from: e.status, to: status, patientId: e.patientId, trialId: e.trialId },
        });
      });
      return getEnrollment(id);
    },
  };
}

export type TrialService = ReturnType<typeof createTrialService>;
