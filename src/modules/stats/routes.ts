import { Router } from 'express';
import type { Ctx } from '../../context';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok } from '../../utils/http';
import { sponsorStatsQuery, visitStatsQuery } from './schemas';
import type { StatsService } from './service';

export function statsRouter(ctx: Ctx, stats: StatsService) {
  const r = Router();
  r.use(authenticate(ctx));

  // Operational numbers: all staff roles. Patients never reach these.
  r.get('/operations', requireRole('admin', 'coordinator', 'investigator'), asyncHandler((_req, res) => ok(res, stats.operations())));
  r.get('/visits', requireRole('admin', 'coordinator', 'investigator'), validate({ query: visitStatsQuery }), asyncHandler((req, res) => ok(res, stats.visits(req.valid!.query))));
  r.get('/reimbursements', requireRole('admin', 'coordinator', 'investigator'), asyncHandler((_req, res) => ok(res, stats.reimbursements())));

  // Risk / integrity / audit overview follows the same roles as those modules (admin, investigator).
  r.get('/sponsor', requireRole('admin', 'investigator'), validate({ query: sponsorStatsQuery }), asyncHandler((req, res) => ok(res, stats.sponsor(req.valid!.query))));
  return r;
}
