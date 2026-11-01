import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { IntegrityService } from './service';
import { listAlertsQuery, scanBody, updateAlertBody } from './schemas';

export function integrityRouter(ctx: Ctx, svc: IntegrityService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole('admin', 'investigator'));

  r.post('/scans', validate({ body: scanBody }), asyncHandler(async (req, res) => ok(res, await svc.scan(req.body, actorOf(req)), 201)));
  r.get('/alerts', validate({ query: listAlertsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/alerts/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.get(req.valid!.params.id))));
  r.patch('/alerts/:id', validate({ params: idParam, body: updateAlertBody }), asyncHandler((req, res) =>
    ok(res, svc.updateStatus(req.valid!.params.id, req.body.status, req.body.note, actorOf(req)))));
  r.get('/rules', asyncHandler((_req, res) => ok(res, svc.rules())));
  return r;
}
