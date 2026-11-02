import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { changedKeys, inTransaction, mapRow, mapRows, nowIso, orderBy, updateRow } from '../../utils/db';
import { createLookups } from '../../utils/lookups';
import { appendAuditEvent } from '../audit/chain';
import type { createPatientBody, listPatientsQuery, updatePatientBody } from './schemas';

/** Registered patient-role account that has no patient record yet. */
export interface LinkableAccount { id: string; fullName: string; email: string; createdAt: string }

export interface PatientDto {
  id: string; subjectCode: string; userId: string | null; firstName: string; lastName: string;
  dateOfBirth: string; sex: string; email: string | null; phone: string | null; status: string;
  createdAt: string; updatedAt: string;
  /** Embedded display name of the linked portal account (additive, read-only). */
  portalAccountName?: string | null;
}

const COLS = 'id, subject_code, user_id, first_name, last_name, date_of_birth, sex, email, phone, status, created_at, updated_at';

export function createPatientService(ctx: Ctx) {
  const { db } = ctx;

  const find = (id: string): PatientDto | undefined =>
    mapRow<PatientDto>(db.prepare(`SELECT ${COLS} FROM patients WHERE id = ? AND deleted_at IS NULL`).get(id) as any);

  const lookups = createLookups(db);
  const withAccountNames = (items: PatientDto[]): PatientDto[] => {
    const u = lookups.users(items.map((p) => p.userId));
    return items.map((p) => ({ ...p, portalAccountName: p.userId ? u.get(p.userId)?.name ?? null : null }));
  };

  const get = (id: string): PatientDto => {
    const p = find(id);
    if (!p) throw AppError.notFound('Patient');
    return withAccountNames([p])[0]!;
  };

  function assertLinkableUser(userId: string, exceptPatientId?: string) {
    const u = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(userId) as { role: string; is_active: number } | undefined;
    if (!u) throw AppError.validation('userId does not reference an existing user');
    if (u.role !== 'patient') throw AppError.validation('Only users with the patient role can be linked to a patient record');
    if (!u.is_active) throw AppError.validation('This account is deactivated and cannot be linked');
    const taken = db.prepare('SELECT id FROM patients WHERE user_id = ? AND id != ?').get(userId, exceptPatientId ?? '') as any;
    if (taken) throw AppError.conflict('This user is already linked to another patient');
  }

  return {
    get,
    find,

    /** Returns the patient record linked to a patient-role user, or throws 404. */
    getByUserId(userId: string): PatientDto {
      const p = mapRow<PatientDto>(db.prepare(`SELECT ${COLS} FROM patients WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as any);
      if (!p) throw AppError.notFound('Patient record for this account');
      return withAccountNames([p])[0]!;
    },

    create(input: z.infer<typeof createPatientBody>, actor: Actor): PatientDto {
      const id = randomUUID();
      const now = nowIso();
      try {
        inTransaction(db, () => {
          if (input.userId) assertLinkableUser(input.userId);
          let code = input.subjectCode;
          if (!code) {
            let n = (db.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c + 1;
            do { code = `P-${String(n++).padStart(4, '0')}`; } while (db.prepare('SELECT 1 FROM patients WHERE subject_code = ?').get(code));
          }
          db.prepare(
            `INSERT INTO patients (id, subject_code, user_id, first_name, last_name, date_of_birth, sex, email, phone, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          ).run(id, code, input.userId ?? null, input.firstName, input.lastName, input.dateOfBirth, input.sex, input.email ?? null, input.phone ?? null, now, now);
          // Audit metadata deliberately excludes direct identifiers (names, DOB, contact details).
          appendAuditEvent(db, { actorId: actor.id, action: 'patient.created', entityType: 'patient', entityId: id, metadata: { subjectCode: code } });
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw AppError.conflict('A patient with this subject code already exists');
        throw err;
      }
      return get(id);
    },

    list(q: z.infer<typeof listPatientsQuery>) {
      const where = ['p.deleted_at IS NULL'];
      const params: unknown[] = [];
      if (q.status) { where.push('p.status = ?'); params.push(q.status); }
      if (q.search) {
        where.push('(p.first_name LIKE ? OR p.last_name LIKE ? OR p.subject_code LIKE ? OR p.email LIKE ?)');
        params.push(...Array(4).fill(`%${q.search}%`));
      }
      if (q.trialId) { where.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.patient_id = p.id AND e.trial_id = ?)'); params.push(q.trialId); }
      const w = `WHERE ${where.join(' AND ')}`;
      const total = (db.prepare(`SELECT COUNT(*) c FROM patients p ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'p.created_at', lastName: 'p.last_name', subjectCode: 'p.subject_code' }, 'p.created_at');
      const cols = COLS.split(', ').map((c) => `p.${c}`).join(', ');
      const rows = db.prepare(`SELECT ${cols} FROM patients p ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: withAccountNames(mapRows<PatientDto>(rows)), total };
    },

    update(id: string, patch: z.infer<typeof updatePatientBody>, actor: Actor): PatientDto {
      inTransaction(db, () => {
        const existing = get(id);
        if (patch.userId) assertLinkableUser(patch.userId, id);
        const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const keys = changedKeys(existing as unknown as Record<string, unknown>, changes);
        if (keys.length === 0) return;
        updateRow(db, 'patients', id, Object.fromEntries(keys.map((k) => [k, changes[k]])));
        appendAuditEvent(db, {
          actorId: actor.id, action: 'patient.updated', entityType: 'patient', entityId: id,
          metadata: { changedFields: keys, ...(keys.includes('status') ? { status: { from: existing.status, to: patch.status } } : {}) },
        });
      });
      return get(id);
    },

    /**
     * Registered portal accounts that are still waiting to be linked: active, patient role, no patient record.
     * Coordinators get this narrow view instead of the full (admin-only) user list. Email is included only so staff
     * can match the account to the right person.
     */
    linkableAccounts(q: { page: number; pageSize: number; order: 'asc' | 'desc'; search?: string }) {
      const where = [`u.role = 'patient'`, 'u.is_active = 1', 'NOT EXISTS (SELECT 1 FROM patients p WHERE p.user_id = u.id)'];
      const params: unknown[] = [];
      if (q.search) { where.push('(u.full_name LIKE ? OR u.email LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
      const w = `WHERE ${where.join(' AND ')}`;
      const total = (db.prepare(`SELECT COUNT(*) c FROM users u ${w}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT u.id, u.full_name, u.email, u.created_at FROM users u ${w} ORDER BY u.created_at ${q.order === 'asc' ? 'ASC' : 'DESC'}, u.id LIMIT ? OFFSET ?`)
        .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<LinkableAccount>(rows), total };
    },

    /** Links a registered portal account to this patient record. Rejects wrong role, inactive, already-linked user, or already-linked patient. */
    linkAccount(id: string, userId: string, actor: Actor): PatientDto {
      inTransaction(db, () => {
        const existing = get(id);
        if (existing.userId) throw AppError.conflict(existing.userId === userId ? 'This account is already linked to this patient' : 'This patient is already linked to a portal account; unlink it first');
        assertLinkableUser(userId, id);
        updateRow(db, 'patients', id, { userId });
        appendAuditEvent(db, { actorId: actor.id, action: 'patient.account_linked', entityType: 'patient', entityId: id, metadata: { userId } });
      });
      return get(id);
    },

    /** Removes the portal link (the participant loses access to their data until re-linked). */
    unlinkAccount(id: string, actor: Actor): PatientDto {
      inTransaction(db, () => {
        const existing = get(id);
        if (!existing.userId) throw AppError.conflict('This patient has no linked portal account');
        updateRow(db, 'patients', id, { userId: null });
        appendAuditEvent(db, { actorId: actor.id, action: 'patient.account_unlinked', entityType: 'patient', entityId: id, metadata: { userId: existing.userId } });
      });
      return get(id);
    },

    /** Soft delete: clinical records are retained, but the patient disappears from the API. */
    remove(id: string, actor: Actor): void {
      inTransaction(db, () => {
        get(id);
        const refs = db.prepare('SELECT COUNT(*) c FROM enrollments WHERE patient_id = ?').get(id) as { c: number };
        if (refs.c > 0) throw AppError.conflict('Patient has trial enrollments; set status to "withdrawn" instead of deleting');
        const now = nowIso();
        db.prepare('UPDATE patients SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
        appendAuditEvent(db, { actorId: actor.id, action: 'patient.deleted', entityType: 'patient', entityId: id, metadata: {} });
      });
    },
  };
}

export type PatientService = ReturnType<typeof createPatientService>;
