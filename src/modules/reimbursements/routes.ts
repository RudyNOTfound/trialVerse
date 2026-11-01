import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { PatientService } from '../patients/service';
import type { ReimbursementService } from './service';
import { createReimbursementBody, listReimbursementsQuery, noteBody, paymentBody, rejectBody, updateReimbursementBody } from './schemas';

export function reimbursementsRouter(ctx: Ctx, svc: ReimbursementService, patients: PatientService) {
  const r = Router();
  r.use(authenticate(ctx));

  r.get('/', validate({ query: listReimbursementsQuery }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    const q = { ...req.valid!.query };
    if (actor.role === 'patient') q.patientId = patients.getByUserId(actor.id).id;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', requireRole('admin', 'coordinator', 'patient'), validate({ body: createReimbursementBody }), asyncHandler((req, res) =>
    ok(res, svc.create(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.getForActor(req.valid!.params.id, actorOf(req)))));
  r.patch('/:id', requireRole('admin', 'coordinator', 'patient'), validate({ params: idParam, body: updateReimbursementBody }), asyncHandler((req, res) =>
    ok(res, svc.update(req.valid!.params.id, req.body, actorOf(req)))));
  r.get('/:id/history', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.history(req.valid!.params.id, actorOf(req)))));

  r.post('/:id/approve', requireRole('admin', 'investigator'), validate({ params: idParam, body: noteBody }), asyncHandler((req, res) =>
    ok(res, svc.approve(req.valid!.params.id, req.body.note, actorOf(req)))));
  r.post('/:id/reject', requireRole('admin', 'investigator'), validate({ params: idParam, body: rejectBody }), asyncHandler((req, res) =>
    ok(res, svc.reject(req.valid!.params.id, req.body.reason, actorOf(req)))));
  r.post('/:id/cancel', requireRole('admin', 'coordinator', 'patient'), validate({ params: idParam, body: noteBody }), asyncHandler((req, res) =>
    ok(res, svc.cancel(req.valid!.params.id, req.body.note, actorOf(req)))));
  r.post('/:id/payment', requireRole('admin'), validate({ params: idParam, body: paymentBody }), asyncHandler((req, res) =>
    ok(res, svc.updatePayment(req.valid!.params.id, req.body, actorOf(req)))));
  return r;
}
