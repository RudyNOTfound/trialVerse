import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context';
import { AppError } from '../../utils/errors';
import { changedKeys, inTransaction, mapRow, mapRows, nowIso, orderBy, updateRow } from '../../utils/db';
import { assertTransition, type TransitionMap } from '../../utils/stateMachine';
import { appendAuditEvent } from '../audit/chain';
import { listStatusHistory, recordStatus } from '../shared/history';
import type { createActionBody, listActionsQuery, updateActionBody } from './schemas';

export type ActionStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface ActionDto {
  id: string; title: string; description: string | null; status: ActionStatus; priority: string; dueDate: string | null;
  assigneeId: string | null; createdBy: string; trialId: string | null; patientId: string | null; visitId: string | null;
  completedAt: string | null; createdAt: string; updatedAt: string;
  /** Derived at read time: open and past due. */
  isOverdue: boolean;
  /** `overdue` when isOverdue, otherwise the stored status. */
  effectiveStatus: ActionStatus | 'overdue';
}

export const ACTION_TRANSITIONS: TransitionMap<ActionStatus> = {
  pending: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['pending', 'completed', 'cancelled'],
  completed: ['in_progress'], // reopen
  cancelled: [],
};

const COLS = `id, title, description, status, priority, due_date, assignee_id, created_by, trial_id, patient_id, visit_id, completed_at, created_at, updated_at`;
const PRIORITY_RANK = `CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;

function decorate(a: Omit<ActionDto, 'isOverdue' | 'effectiveStatus'>, now = nowIso()): ActionDto {
  const isOverdue = (a.status === 'pending' || a.status === 'in_progress') && !!a.dueDate && a.dueDate < now;
  return { ...a, isOverdue, effectiveStatus: isOverdue ? 'overdue' : a.status };
}

export function createActionService(ctx: Ctx) {
  const { db } = ctx;

  const get = (id: string): ActionDto => {
    const a = mapRow<Omit<ActionDto, 'isOverdue' | 'effectiveStatus'>>(db.prepare(`SELECT ${COLS} FROM actions WHERE id = ?`).get(id) as any);
    if (!a) throw AppError.notFound('Action');
    return decorate(a);
  };

  function assertRefs(i: { assigneeId?: string | null; trialId?: string; patientId?: string; visitId?: string }) {
    if (i.assigneeId) {
      const u = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(i.assigneeId) as { role: string; is_active: number } | undefined;
      if (!u || !u.is_active || u.role === 'patient') throw AppError.validation('assigneeId must reference an active staff user');
    }
    const exists = (sql: string, id: string | undefined, label: string) => {
      if (id && !db.prepare(sql).get(id)) throw AppError.validation(`${label} does not exist`);
    };
    exists('SELECT 1 FROM trials WHERE id = ? AND deleted_at IS NULL', i.trialId, 'trialId');
    exists('SELECT 1 FROM patients WHERE id = ? AND deleted_at IS NULL', i.patientId, 'patientId');
    exists('SELECT 1 FROM visits WHERE id = ?', i.visitId, 'visitId');
  }

  return {
    get,

    create(input: z.infer<typeof createActionBody>, actor: Actor): ActionDto {
      const id = randomUUID();
      const now = nowIso();
      inTransaction(db, () => {
        assertRefs(input);
        db.prepare(
          `INSERT INTO actions (id, title, description, status, priority, due_date, assignee_id, created_by, trial_id, patient_id, visit_id, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.title, input.description ?? null, input.priority, input.dueDate ? new Date(input.dueDate).toISOString() : null,
          input.assigneeId ?? null, actor.id, input.trialId ?? null, input.patientId ?? null, input.visitId ?? null, now, now);
        recordStatus(db, { entityType: 'action', entityId: id, from: null, to: 'pending', actorId: actor.id });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'action.created', entityType: 'action', entityId: id,
          metadata: { priority: input.priority, assigneeId: input.assigneeId ?? null, trialId: input.trialId ?? null, patientId: input.patientId ?? null, visitId: input.visitId ?? null },
        });
      });
      return get(id);
    },

    list(q: z.infer<typeof listActionsQuery>) {
      const where: string[] = [];
      const params: unknown[] = [];
      const now = nowIso();
      if (q.status === 'overdue') { where.push(`status IN ('pending','in_progress') AND due_date IS NOT NULL AND due_date < ?`); params.push(now); }
      else if (q.status) { where.push('status = ?'); params.push(q.status); }
      for (const [col, v] of [['priority', q.priority], ['assignee_id', q.assigneeId], ['trial_id', q.trialId], ['patient_id', q.patientId], ['visit_id', q.visitId]] as const) {
        if (v) { where.push(`${col} = ?`); params.push(v); }
      }
      if (q.dueBefore) { where.push('due_date IS NOT NULL AND due_date <= ?'); params.push(new Date(q.dueBefore).toISOString()); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM actions ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'created_at', dueDate: 'due_date', priority: PRIORITY_RANK }, 'created_at');
      const rows = db.prepare(`SELECT ${COLS} FROM actions ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<Omit<ActionDto, 'isOverdue' | 'effectiveStatus'>>(rows).map((a) => decorate(a, now)), total };
    },

    update(id: string, patch: z.infer<typeof updateActionBody>, actor: Actor): ActionDto {
      inTransaction(db, () => {
        const a = get(id);
        if (actor.role !== 'admin' && a.createdBy !== actor.id && a.assigneeId !== actor.id) throw AppError.forbidden('Only the creator, assignee or an admin can edit this action');
        if (['completed', 'cancelled'].includes(a.status)) throw AppError.conflict(`A ${a.status} action can no longer be edited`);
        assertRefs({ assigneeId: patch.assigneeId });
        const norm = { ...patch, ...(patch.dueDate ? { dueDate: new Date(patch.dueDate).toISOString() } : {}) };
        const keys = changedKeys(a as unknown as Record<string, unknown>, norm);
        if (keys.length === 0) return;
        updateRow(db, 'actions', id, Object.fromEntries(keys.map((k) => [k, (norm as Record<string, unknown>)[k]])));
        appendAuditEvent(db, {
          actorId: actor.id, action: 'action.updated', entityType: 'action', entityId: id,
          metadata: { changedFields: keys, ...(keys.includes('assigneeId') ? { assigneeId: { from: a.assigneeId, to: patch.assigneeId ?? null } } : {}) },
        });
      });
      return get(id);
    },

    changeStatus(id: string, status: ActionStatus, note: string | undefined, actor: Actor): ActionDto {
      inTransaction(db, () => {
        const a = get(id);
        if (actor.role !== 'admin' && a.createdBy !== actor.id && a.assigneeId !== actor.id) throw AppError.forbidden('Only the creator, assignee or an admin can change this action');
        assertTransition('Action', ACTION_TRANSITIONS, a.status, status);
        updateRow(db, 'actions', id, { status, completedAt: status === 'completed' ? nowIso() : null });
        recordStatus(db, { entityType: 'action', entityId: id, from: a.status, to: status, actorId: actor.id, note });
        appendAuditEvent(db, {
          actorId: actor.id, action: 'action.status_changed', entityType: 'action', entityId: id,
          metadata: { from: a.status, to: status, wasOverdue: a.isOverdue },
        });
      });
      return get(id);
    },

    history(id: string) {
      get(id);
      return listStatusHistory(db, 'action', id);
    },
  };
}

export type ActionService = ReturnType<typeof createActionService>;
