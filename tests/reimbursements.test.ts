import { beforeEach, describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario, makeUser } from './helpers';

describe('reimbursement workflow', () => {
  let h: ReturnType<typeof makeHarness>;
  let sc: Awaited<ReturnType<typeof makeScenario>>;
  beforeEach(async () => { h = makeHarness(); sc = await makeScenario(h); });

  const create = (who = sc.patientUser, over = {}) =>
    h.api.post('/api/v1/reimbursements').set(bearer(who)).send({ visitId: sc.visit.id, category: 'travel', amountCents: 4500, description: 'Bus', ...over });
  const act = (id: string, action: string, who: { token: string }, body: object = {}) => h.api.post(`/api/v1/reimbursements/${id}/${action}`).set(bearer(who)).send(body);

  it('creates a request tied to the patient, visit and trial with the right initial state', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      patientId: sc.patient.id, visitId: sc.visit.id, trialId: sc.trial.id, amountCents: 4500, currency: 'USD',
      status: 'pending', paymentStatus: 'none', requestedBy: sc.patientUser.id, reviewedBy: null, paidAt: null,
    });
  });

  it('validates input', async () => {
    for (const over of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 10.5 }, { amountCents: 99_999_999 }, { category: 'yacht' }, { currency: 'DOLLARS' }, { visitId: 'x' }]) {
      expect((await create(sc.patientUser, over)).status, JSON.stringify(over)).toBe(400);
    }
    expect((await create(sc.patientUser, { visitId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('stops patients claiming for another patient\'s visit, and cancelled visits', async () => {
    const other = await makeUser(h, 'patient');
    h.s.patients.create({ firstName: 'O', lastName: 'P', dateOfBirth: '1990-01-01', sex: 'male', userId: other.id }, sc.coord.actor);
    expect((await create(other)).status).toBe(403);
    const v = sc.newVisit();
    h.s.visits.changeStatus(v.id, 'cancelled', undefined, sc.coord.actor);
    expect((await create(sc.patientUser, { visitId: v.id })).status).toBe(409);
  });

  it('approves a pending request: sets reviewer, timestamp and moves payment to unpaid', async () => {
    const id = (await create()).body.data.id;
    const res = await act(id, 'approve', sc.inv, { note: 'Receipt ok' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', paymentStatus: 'unpaid', reviewedBy: sc.inv.id });
    expect(res.body.data.reviewedAt).toBeTruthy();
  });

  it('enforces segregation of duties: the requester cannot review their own request', async () => {
    const id = (await create(sc.admin)).body.data.id;
    expect((await act(id, 'approve', sc.admin)).status).toBe(403);
    expect((await act(id, 'reject', sc.admin, { reason: 'self review' })).status).toBe(403);
    expect((await act(id, 'approve', sc.inv)).status).toBe(200);
  });

  it('rejects with a mandatory reason, leaving payment untouched', async () => {
    const id = (await create()).body.data.id;
    expect((await act(id, 'reject', sc.inv, {})).status).toBe(400);
    const res = await act(id, 'reject', sc.inv, { reason: 'Missing receipt' });
    expect(res.body.data).toMatchObject({ status: 'rejected', paymentStatus: 'none', rejectionReason: 'Missing receipt' });
  });

  it('blocks invalid state transitions', async () => {
    const id = (await create()).body.data.id;
    expect((await act(id, 'payment', sc.admin, { status: 'processing' })).status).toBe(409);     // not approved yet
    await act(id, 'reject', sc.inv, { reason: 'No receipt' });
    for (const a of ['approve', 'cancel']) {
      const res = await act(id, a, a === 'approve' ? sc.inv : sc.admin);
      expect(res.status, a).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    }
    expect((await act(id, 'reject', sc.inv, { reason: 'again' })).status).toBe(409);
  });

  it('walks the payment lifecycle unpaid → processing → paid and records the transaction', async () => {
    const id = (await create()).body.data.id;
    await act(id, 'approve', sc.inv);
    const pay = (b: object) => act(id, 'payment', sc.admin, b);
    expect((await pay({ status: 'paid', transactionRef: 'TXN-1' })).status).toBe(409);          // must go through processing
    expect((await pay({ status: 'processing' })).body.data.paymentStatus).toBe('processing');
    expect((await pay({ status: 'paid' })).status).toBe(400);                                     // transactionRef required
    const paid = await pay({ status: 'paid', transactionRef: 'TXN-1' });
    expect(paid.body.data).toMatchObject({ paymentStatus: 'paid', transactionRef: 'TXN-1' });
    expect(paid.body.data.paidAt).toBeTruthy();
    expect((await pay({ status: 'processing' })).status).toBe(409);                               // paid is terminal
    expect((await act(id, 'cancel', sc.admin)).status).toBe(409);                                 // cannot cancel after payment
  });

  it('supports failed payments being retried', async () => {
    const id = (await create()).body.data.id;
    await act(id, 'approve', sc.inv);
    await act(id, 'payment', sc.admin, { status: 'processing' });
    expect((await act(id, 'payment', sc.admin, { status: 'failed' })).body.data.paymentStatus).toBe('failed');
    expect((await act(id, 'payment', sc.admin, { status: 'processing' })).body.data.paymentStatus).toBe('processing');
  });

  it('lets the requester (or admin) cancel, but not other users', async () => {
    const id = (await create()).body.data.id;
    expect((await act(id, 'cancel', sc.coord)).status).toBe(403);
    const res = await act(id, 'cancel', sc.patientUser, { note: 'oops' });
    expect(res.body.data.status).toBe('cancelled');
  });

  it('edits only pending requests, by the requester, and audits amount changes', async () => {
    const id = (await create()).body.data.id;
    const edit = await h.api.patch(`/api/v1/reimbursements/${id}`).set(bearer(sc.patientUser)).send({ amountCents: 5000 });
    expect(edit.body.data.amountCents).toBe(5000);
    const ev = h.ctx.db.prepare(`SELECT metadata FROM audit_logs WHERE action = 'reimbursement.updated'`).get() as { metadata: string };
    expect(JSON.parse(ev.metadata).amountCents).toEqual({ from: 4500, to: 5000 });
    expect((await h.api.patch(`/api/v1/reimbursements/${id}`).set(bearer(sc.coord)).send({ amountCents: 1 })).status).toBe(403);
    await act(id, 'approve', sc.inv);
    expect((await h.api.patch(`/api/v1/reimbursements/${id}`).set(bearer(sc.patientUser)).send({ amountCents: 1 })).status).toBe(409);
  });

  it('keeps a complete status history and audit trail', async () => {
    const id = (await create()).body.data.id;
    await act(id, 'approve', sc.inv, { note: 'ok' });
    await act(id, 'payment', sc.admin, { status: 'processing' });
    await act(id, 'payment', sc.admin, { status: 'paid', transactionRef: 'TXN-77' });
    const hist = (await h.api.get(`/api/v1/reimbursements/${id}/history`).set(bearer(sc.patientUser))).body.data as { field: string; fromStatus: string | null; toStatus: string }[];
    expect(hist.map((x) => `${x.field}:${x.fromStatus ?? '∅'}>${x.toStatus}`)).toEqual([
      'status:∅>pending', 'status:pending>approved', 'payment_status:none>unpaid', 'payment_status:unpaid>processing', 'payment_status:processing>paid']);
    const actions = (h.ctx.db.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'reimbursement' AND entity_id = ? ORDER BY seq`).all(id) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['reimbursement.created', 'reimbursement.approved', 'reimbursement.payment_processing', 'reimbursement.payment_paid']);
    expect(h.s.audit.verify(sc.admin.actor).valid).toBe(true);
  });

  it('lists with filters, sorting and patient scoping', async () => {
    await create(sc.patientUser, { amountCents: 1000, category: 'meals' });
    await create(sc.patientUser, { amountCents: 9000, category: 'travel' });
    const big = await h.api.get('/api/v1/reimbursements?minAmountCents=5000&sort=amountCents&order=asc').set(bearer(sc.admin));
    expect(big.body.data.map((r: { amountCents: number }) => r.amountCents)).toEqual([9000]);
    const meals = await h.api.get('/api/v1/reimbursements?category=meals&status=pending').set(bearer(sc.inv));
    expect(meals.body.data).toHaveLength(1);
    const other = await makeUser(h, 'patient');
    h.s.patients.create({ firstName: 'O', lastName: 'P', dateOfBirth: '1990-01-01', sex: 'male', userId: other.id }, sc.coord.actor);
    expect((await h.api.get('/api/v1/reimbursements').set(bearer(other))).body.data).toHaveLength(0);
    const id = meals.body.data[0].id;
    expect((await h.api.get(`/api/v1/reimbursements/${id}`).set(bearer(other))).status).toBe(403);
  });
});
