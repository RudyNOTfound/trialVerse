import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { RiskService } from './service';
import { assessBody, listAssessmentsQuery } from './schemas';

export function riskRouter(ctx: Ctx, svc: RiskService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole('admin', 'coordinator', 'investigator'));

  r.post('/assessments', validate({ body: assessBody }), asyncHandler(async (req, res) => ok(res, await svc.assess(req.body, actorOf(req)), 201)));
  r.get('/assessments', validate({ query: listAssessmentsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/assessments/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.get(req.valid!.params.id))));
  r.get('/rules', asyncHandler((_req, res) => ok(res, svc.rules())));
  return r;
}
