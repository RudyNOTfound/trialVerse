import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { ActionService } from './service';
import { actionStatusBody, createActionBody, listActionsQuery, updateActionBody } from './schemas';

export function actionsRouter(ctx: Ctx, svc: ActionService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole('admin', 'coordinator', 'investigator'));

  r.get('/', validate({ query: listActionsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', validate({ body: createActionBody }), asyncHandler((req, res) => ok(res, svc.create(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.get(req.valid!.params.id))));
  r.patch('/:id', validate({ params: idParam, body: updateActionBody }), asyncHandler((req, res) =>
    ok(res, svc.update(req.valid!.params.id, req.body, actorOf(req)))));
  r.post('/:id/status', validate({ params: idParam, body: actionStatusBody }), asyncHandler((req, res) =>
    ok(res, svc.changeStatus(req.valid!.params.id, req.body.status, req.body.note, actorOf(req)))));
  r.get('/:id/history', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.history(req.valid!.params.id))));
  return r;
}
