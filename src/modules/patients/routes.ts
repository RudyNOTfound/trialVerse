import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../utils/errors';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { PatientService } from './service';
import { createPatientBody, linkableAccountsQuery, linkAccountBody, listPatientsQuery, updatePatientBody } from './schemas';

export function patientsRouter(ctx: Ctx, svc: PatientService) {
  const r = Router();
  r.use(authenticate(ctx));

  r.get('/', requireRole('admin', 'coordinator', 'investigator'), validate({ query: listPatientsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', requireRole('admin', 'coordinator'), validate({ body: createPatientBody }), asyncHandler((req, res) =>
    ok(res, svc.create(req.body, actorOf(req)), 201)));

  // Declared before '/:id'. Narrow view of unlinked portal accounts (admin + coordinator), instead of the admin-only user list.
  r.get('/linkable-accounts', requireRole('admin', 'coordinator'), validate({ query: linkableAccountsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.linkableAccounts(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));

  // Patients can read only their own record.
  r.get('/me', requireRole('patient'), asyncHandler((req, res) => ok(res, svc.getByUserId(actorOf(req).id))));

  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    const p = svc.get(req.valid!.params.id);
    if (actor.role === 'patient' && p.userId !== actor.id) throw AppError.forbidden();
    ok(res, p);
  }));
  r.patch('/:id', requireRole('admin', 'coordinator'), validate({ params: idParam, body: updatePatientBody }), asyncHandler((req, res) =>
    ok(res, svc.update(req.valid!.params.id, req.body, actorOf(req)))));
  r.post('/:id/account', requireRole('admin', 'coordinator'), validate({ params: idParam, body: linkAccountBody }), asyncHandler((req, res) =>
    ok(res, svc.linkAccount(req.valid!.params.id, req.body.userId, actorOf(req)), 201)));
  r.delete('/:id/account', requireRole('admin', 'coordinator'), validate({ params: idParam }), asyncHandler((req, res) =>
    ok(res, svc.unlinkAccount(req.valid!.params.id, actorOf(req)))));
  r.delete('/:id', requireRole('admin'), validate({ params: idParam }), asyncHandler((req, res) => {
    svc.remove(req.valid!.params.id, actorOf(req));
    ok(res, { deleted: true });
  }));
  return r;
}
