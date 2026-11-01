import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import { createAuditService } from './service';
import { auditListQuery } from './schemas';

export function auditRouter(ctx: Ctx) {
  const r = Router();
  const svc = createAuditService(ctx);
  r.use(authenticate(ctx), requireRole('admin', 'investigator'));

  r.get('/', validate({ query: auditListQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));

  // Declared before '/:id' so "verify" is not parsed as an id.
  r.get('/verify', asyncHandler((req, res) => ok(res, svc.verify(actorOf(req)))));

  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.get(req.valid!.params.id))));
  return r;
}
