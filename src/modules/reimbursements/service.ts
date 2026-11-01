import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { changedKeys, inTransaction, mapRow, mapRows, nowIso, orderBy, updateRow } from '../../utils/db';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent } from '../audit/chain';
import { listStatusHistory, recordStatus } from '../shared/history';
import type { PatientService } from '../patients/service';
import type { createReimbursementBody, listReimbursementsQuery, updateReimbursementBody } from './schemas';

export type ReimbStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type PaymentStatus = 'none' | 'unpaid' | 'processing' | 'paid' | 'failed';

export interface ReimbursementDto {
  id: string; patientId: string; visitId: string; trialId: string; category: string; amountCents: number; currency: string;
  description: string | null; status: ReimbStatus; paymentStatus: PaymentStatus; requestedBy: string; reviewedBy: string | null;
  reviewedAt: string | null; rejectionReason: string | null; paidAt: string | null; transactionRef: string | null;
  createdAt: string; updatedAt: string;
}

export const REIMBURSEMENT_TRANSITIONS: TransitionMap<ReimbStatus> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

/** `none` becomes `unpaid` automatically on approval; it is never a target of an explicit payment update. */
export const PAYMENT_TRANSITIONS: TransitionMap<PaymentStatus> = {
  none: ['unpaid'],
  unpaid: ['processing'],
  processing: ['paid', 'failed'],
  failed: ['processing'],
  paid: [],
};

const COLS = `id, patient_id, visit_id, trial_id, category, amount_cents, currency, description, status, payment_status,
  requested_by, reviewed_by, reviewed_at, rejection_reason, paid_at, transaction_ref, created_at, updated_at`;

export function createReimbursementService(ctx: Ctx, patients: PatientService) {
  const { db } = ctx;

  const get = (id: string): ReimbursementDto => {
    const r = mapRow<ReimbursementDto>(db.prepare(`SELECT ${COLS} FROM reimbursements WHERE id = ?`).get(id) as any);
    if (!r) throw AppError.notFound('Reimbursement');
    return r;
  };

  const assertAccess = (r: ReimbursementDto, actor: Actor) => {
    if (actor.role === 'patient') {
      const p = patients.find(r.patientId);
      if (!p || p.userId !== actor.id) throw AppError.forbidden();
    }
  };

  const getForActor = (id: string, actor: Actor) => {
    const r = get(id);
    assertAccess(r, actor);
    return r;
  };

  return {
    get, getForActor,

    create(input: z.infer<typeof createReimbursementBody>, actor: Actor): ReimbursementDto {
      const id = randomUUID();
      const now = nowIso();
      inTransaction(db, () => {
        const visit = db.prepare('SELECT patient_id, trial_id, status FROM visits WHERE id = ?').get(input.visitId) as
          | { patient_id: string; trial_id: string; status: string } | undefined;
        if (!visit) throw AppError.notFound('Visit');
        if (actor.role === 'patient') {
          const p = patients.find(visit.patient_id);
          if (!p || p.userId !== actor.id) throw AppError.forbidden();
        }
        if (visit.status === 'cancelled') throw AppError.conflict('Cannot request reimbursement for a cancelled visit');
        db.prepare(
          `INSERT INTO reimbursements (id, patient_id, visit_id, trial_id, category, amount_cents, currency, description, status, payment_status, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?, ?)`,
        ).run(id, visit.patient_id, input.visitId, visit.trial_id, input.category, input.amountCents, input.currency, input.description ?? null, actor.id, now, now);
        recordStatus(db, { entityType: 'reimbursement', entityId: id, from: null, to: 'pending', actorId: actor.id });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'reimbursement.created', entityType: 'reimbursement', entityId: id,
          metadata: { patientId: visit.patient_id, visitId: input.visitId, category: input.category, amountCents: input.amountCents, currency: input.currency },
        });
      });
      return get(id);
    },

    list(q: z.infer<typeof listReimbursementsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [
        ['patient_id', q.patientId], ['visit_id', q.visitId], ['trial_id', q.trialId], ['status', q.status],
        ['payment_status', q.paymentStatus], ['category', q.category],
      ] as const) if (v) { where.push(`${col} = ?`); params.push(v); }
      if (q.minAmountCents !== undefined) { where.push('amount_cents >= ?'); params.push(q.minAmountCents); }
      if (q.maxAmountCents !== undefined) { where.push('amount_cents <= ?'); params.push(q.maxAmountCents); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM reimbursements ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'created_at', amountCents: 'amount_cents' }, 'created_at');
      const rows = db.prepare(`SELECT ${COLS} FROM reimbursements ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<ReimbursementDto>(rows), total };
    },

    /** Only pending requests are editable; amount changes are called out in the audit trail. */
    update(id: string, patch: z.infer<typeof updateReimbursementBody>, actor: Actor): ReimbursementDto {
      inTransaction(db, () => {
        const r = getForActor(id, actor);
        if (actor.role === 'investigator') throw AppError.forbidden();
        if (actor.role === 'coordinator' || actor.role === 'patient') {
          if (r.requestedBy !== actor.id) throw AppError.forbidden('Only the requester or an admin can edit this request');
        }
        if (r.status !== 'pending') throw AppError.conflict(`A reimbursement with status '${r.status}' can no longer be edited`);
        const keys = changedKeys(r as unknown as Record<string, unknown>, patch);
        if (keys.length === 0) return;
        updateRow(db, 'reimbursements', id, Object.fromEntries(keys.map((k) => [k, (patch as Record<string, unknown>)[k]])));
        appendAuditEvent(db, {
          actorId: actor.id, action: 'reimbursement.updated', entityType: 'reimbursement', entityId: id,
          metadata: { changedFields: keys, ...(keys.includes('amountCents') ? { amountCents: { from: r.amountCents, to: patch.amountCents } } : {}) },
        });
      });
      return get(id);
    },

    approve(id: string, note: string | undefined, actor: Actor): ReimbursementDto {
      inTransaction(db, () => {
        const r = get(id);
        assertTransition('Reimbursement', REIMBURSEMENT_TRANSITIONS, r.status, 'approved');
        if (r.requestedBy === actor.id) throw AppError.forbidden('Segregation of duties: you cannot approve a request you created');
        const now = nowIso();
        updateRow(db, 'reimbursements', id, { status: 'approved', paymentStatus: 'unpaid', reviewedBy: actor.id, reviewedAt: now });
        recordStatus(db, { entityType: 'reimbursement', entityId: id, from: r.status, to: 'approved', actorId: actor.id, note });
        recordStatus(db, { entityType: 'reimbursement', entityId: id, field: 'payment_status', from: r.paymentStatus, to: 'unpaid', actorId: actor.id });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'reimbursement.approved', entityType: 'reimbursement', entityId: id,
          metadata: { amountCents: r.amountCents, patientId: r.patientId, requestedBy: r.requestedBy },
        });
      });
      return get(id);
    },

    reject(id: string, reason: string, actor: Actor): ReimbursementDto {
      inTransaction(db, () => {
        const r = get(id);
        assertTransition('Reimbursement', REIMBURSEMENT_TRANSITIONS, r.status, 'rejected');
        if (r.requestedBy === actor.id) throw AppError.forbidden('Segregation of duties: you cannot review a request you created');
        updateRow(db, 'reimbursements', id, { status: 'rejected', reviewedBy: actor.id, reviewedAt: nowIso(), rejectionReason: reason });
        recordStatus(db, { entityType: 'reimbursement', entityId: id, from: r.status, to: 'rejected', actorId: actor.id, note: reason });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'reimbursement.rejected', entityType: 'reimbursement', entityId: id,
          metadata: { amountCents: r.amountCents, patientId: r.patientId },
        });
      });
      return get(id);
    },

    cancel(id: string, note: string | undefined, actor: Actor): ReimbursementDto {
      inTransaction(db, () => {
        const r = getForActor(id, actor);
        if (actor.role !== 'admin' && r.requestedBy !== actor.id) throw AppError.forbidden('Only the requester or an admin can cancel this request');
        assertTransition('Reimbursement', REIMBURSEMENT_TRANSITIONS, r.status, 'cancelled');
        if (r.status === 'approved' && !['unpaid', 'failed'].includes(r.paymentStatus)) {
          throw AppError.conflict(`Cannot cancel an approved reimbursement whose payment is '${r.paymentStatus}'`);
        }
        updateRow(db, 'reimbursements', id, { status: 'cancelled', paymentStatus: 'none' });
        recordStatus(db, { entityType: 'reimbursement', entityId: id, from: r.status, to: 'cancelled', actorId: actor.id, note });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'reimbursement.cancelled', entityType: 'reimbursement', entityId: id,
          metadata: { previousStatus: r.status, previousPaymentStatus: r.paymentStatus },
        });
      });
      return get(id);
    },

    /** Payment lifecycle, only valid on approved requests: unpaid -> processing -> paid | failed -> processing. */
    updatePayment(id: string, input: { status: 'processing' | 'paid' | 'failed'; transactionRef?: string; note?: string }, actor: Actor): ReimbursementDto {
      inTransaction(db, () => {
        const r = get(id);
        if (r.status !== 'approved') throw AppError.conflict(`Payment can only be updated on approved reimbursements (status is '${r.status}')`);
        assertTransition('Reimbursement payment', PAYMENT_TRANSITIONS, r.paymentStatus, input.status);
        const now = nowIso();
        updateRow(db, 'reimbursements', id, {
          paymentStatus: input.status,
          ...(input.transactionRef ? { transactionRef: input.transactionRef } : {}),
          ...(input.status === 'paid' ? { paidAt: now } : {}),
        });
        recordStatus(db, { entityType: 'reimbursement', entityId: id, field: 'payment_status', from: r.paymentStatus, to: input.status, actorId: actor.id, note: input.note });
        appendAuditEvent(db, {
          actorId: actor.id, action: `reimbursement.payment_${input.status}`, entityType: 'reimbursement', entityId: id,
          metadata: { from: r.paymentStatus, to: input.status, amountCents: r.amountCents, ...(input.transactionRef ? { transactionRef: input.transactionRef } : {}) },
        });
      });
      return get(id);
    },

    history(id: string, actor: Actor) {
      getForActor(id, actor);
      return listStatusHistory(db, 'reimbursement', id);
    },
  };
}

export type ReimbursementService = ReturnType<typeof createReimbursementService>;
