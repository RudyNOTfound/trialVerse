import { beforeEach, describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario } from './helpers';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('action management', () => {
  let h: ReturnType<typeof makeHarness>;
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeEach(async () => { h = makeHarness(); sc = await makeScenario(h); });

  const create = (over = {}, who = sc.coord) => h.api.post('/api/v1/actions').set(bearer(who)).send({ title: 'Call the patient', ...over });
  const status = (id: string, s: string, who = sc.coord, note?: string) => h.api.post(`/api/v1/actions/${id}/status`).set(bearer(who)).send({ status: s, note });

  it('creates an action assigned to a user and linked to a trial, patient and visit', async () => {
    const res = await create({ priority: 'high', dueDate: iso(86400_000), assigneeId: sc.inv.id, trialId: sc.trial.id, patientId: sc.patient.id, visitId: sc.visit.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'pending', priority: 'high', assigneeId: sc.inv.id, createdBy: sc.coord.id,
      trialId: sc.trial.id, patientId: sc.patient.id, visitId: sc.visit.id, isOverdue: false, effectiveStatus: 'pending',
    });
  });

  it('validates input and references', async () => {
    expect((await create({ title: 'x' })).status).toBe(400);
    expect((await create({ priority: 'urgent' })).status).toBe(400);
    expect((await create({ dueDate: 'next week' })).status).toBe(400);
    expect((await create({ assigneeId: sc.patientUser.id })).status).toBe(400);
    expect((await create({ trialId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await create({}, sc.patientUser)).status).toBe(403);
  });

  it('derives overdue state from the due date and open status', async () => {
    const late = (await create({ dueDate: iso(-3600_000) })).body.data;
    expect(late).toMatchObject({ status: 'pending', isOverdue: true, effectiveStatus: 'overdue' });
    const later = (await create({ dueDate: iso(3600_000) })).body.data;
    expect(later.isOverdue).toBe(false);
    const overdueList = await h.api.get('/api/v1/actions?status=overdue').set(bearer(sc.admin));
    expect(overdueList.body.data.map((a: { id: string }) => a.id)).toEqual([late.id]);
    await status(late.id, 'in_progress');
    expect((await h.api.get(`/api/v1/actions/${late.id}`).set(bearer(sc.admin))).body.data.effectiveStatus).toBe('overdue');
    const done = await status(late.id, 'completed');
    expect(done.body.data).toMatchObject({ status: 'completed', isOverdue: false, effectiveStatus: 'completed' });
    expect(done.body.data.completedAt).toBeTruthy();
    expect((await h.api.get('/api/v1/actions?status=overdue').set(bearer(sc.admin))).body.data).toHaveLength(0);
  });

  it('tracks pending, in-progress and completed actions through the state machine', async () => {
    const id = (await create()).body.data.id;
    expect((await status(id, 'in_progress')).body.data.status).toBe('in_progress');
    expect((await status(id, 'completed')).body.data.status).toBe('completed');
    expect((await status(id, 'pending')).status).toBe(409);
    expect((await status(id, 'in_progress')).body.data.completedAt).toBeNull(); // reopen
    await status(id, 'cancelled');
    const dead = await status(id, 'in_progress');
    expect(dead.status).toBe(409);
    expect(dead.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('keeps a history of every status change with actor and note', async () => {
    const id = (await create({ assigneeId: sc.inv.id })).body.data.id;
    await status(id, 'in_progress', sc.inv, 'on it');
    await status(id, 'completed', sc.inv);
    const hist = (await h.api.get(`/api/v1/actions/${id}/history`).set(bearer(sc.admin))).body.data;
    expect(hist.map((x: { fromStatus: string | null; toStatus: string }) => [x.fromStatus, x.toStatus])).toEqual([[null, 'pending'], ['pending', 'in_progress'], ['in_progress', 'completed']]);
    expect(hist[1]).toMatchObject({ actorId: sc.inv.id, note: 'on it' });
  });

  it('only lets the creator, assignee or an admin modify an action', async () => {
    const id = (await create({ assigneeId: sc.inv.id })).body.data.id;
    const stranger = (await import('./helpers')).makeUser(h, 'coordinator');
    const other = await stranger;
    expect((await status(id, 'in_progress', other)).status).toBe(403);
    expect((await h.api.patch(`/api/v1/actions/${id}`).set(bearer(other)).send({ title: 'hijack' })).status).toBe(403);
    expect((await status(id, 'in_progress', sc.inv)).status).toBe(200);
    expect((await status(id, 'completed', sc.admin)).status).toBe(200);
  });

  it('updates and reassigns open actions, and audits reassignment', async () => {
    const id = (await create({ assigneeId: sc.inv.id })).body.data.id;
    const upd = await h.api.patch(`/api/v1/actions/${id}`).set(bearer(sc.coord)).send({ assigneeId: sc.admin.id, priority: 'critical', dueDate: null });
    expect(upd.body.data).toMatchObject({ assigneeId: sc.admin.id, priority: 'critical', dueDate: null });
    const ev = h.ctx.db.prepare(`SELECT metadata FROM audit_logs WHERE action = 'action.updated'`).get() as { metadata: string };
    expect(JSON.parse(ev.metadata).assigneeId).toEqual({ from: sc.inv.id, to: sc.admin.id });
    await status(id, 'completed', sc.admin);
    expect((await h.api.patch(`/api/v1/actions/${id}`).set(bearer(sc.admin)).send({ title: 'too late' })).status).toBe(409);
  });

  it('filters, sorts by priority and paginates', async () => {
    await create({ title: 'Low one', priority: 'low' });
    await create({ title: 'Critical one', priority: 'critical', assigneeId: sc.inv.id });
    await create({ title: 'High one', priority: 'high', patientId: sc.patient.id });
    const sorted = await h.api.get('/api/v1/actions?sort=priority&order=desc').set(bearer(sc.admin));
    expect(sorted.body.data.map((a: { priority: string }) => a.priority)).toEqual(['critical', 'high', 'low']);
    expect((await h.api.get(`/api/v1/actions?assigneeId=${sc.inv.id}`).set(bearer(sc.admin))).body.data).toHaveLength(1);
    expect((await h.api.get(`/api/v1/actions?patientId=${sc.patient.id}&priority=high`).set(bearer(sc.admin))).body.data).toHaveLength(1);
    const p = await h.api.get('/api/v1/actions?pageSize=2&page=2').set(bearer(sc.admin));
    expect(p.body.data).toHaveLength(1);
    expect(p.body.meta).toMatchObject({ total: 3, totalPages: 2, page: 2 });
  });
});
