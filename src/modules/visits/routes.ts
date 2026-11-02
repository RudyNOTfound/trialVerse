import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../utils/errors';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { PatientService } from '../patients/service';
import type { OtpService } from './otp';
import { createVisitHistory } from './history';
import type { VisitService } from './service';
import { createVisitBody, listVisitsQuery, updateVisitBody, verifyOtpBody, visitStatusBody } from './schemas';

export function visitsRouter(ctx: Ctx, visits: VisitService, otp: OtpService, patients: PatientService) {
  const r = Router();
  const history = createVisitHistory(ctx);
  r.use(authenticate(ctx));

  r.get('/', validate({ query: listVisitsQuery }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    const q = { ...req.valid!.query };
    if (actor.role === 'patient') q.patientId = patients.getByUserId(actor.id).id; // server-side scoping
    const { items, total } = visits.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', requireRole('admin', 'coordinator'), validate({ body: createVisitBody }), asyncHandler((req, res) =>
    ok(res, visits.create(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, visits.getForActor(req.valid!.params.id, actorOf(req)))));
  r.patch('/:id', requireRole('admin', 'coordinator'), validate({ params: idParam, body: updateVisitBody }), asyncHandler((req, res) =>
    ok(res, visits.update(req.valid!.params.id, req.body, actorOf(req)))));

  // Staff only: the history is derived from the audit trail (actors, OTP failures), which participants do not see.
  r.get('/:id/history', requireRole('admin', 'coordinator', 'investigator'), validate({ params: idParam }), asyncHandler((req, res) => {
    const visit = visits.get(req.valid!.params.id); // 404 if the visit does not exist
    ok(res, history.list(visit.id));
  }));

  // completed requires prior OTP verification (enforced by the state machine); only clinicians close visits.
  r.post('/:id/status', requireRole('admin', 'coordinator', 'investigator'), validate({ params: idParam, body: visitStatusBody }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    if (req.body.status === 'completed' && actor.role === 'coordinator') throw AppError.forbidden('Only an investigator or admin can complete a visit');
    ok(res, visits.changeStatus(req.valid!.params.id, req.body.status, req.body.note, actor));
  }));

  r.post('/:id/otp', requireRole('admin', 'coordinator', 'investigator'), validate({ params: idParam }), asyncHandler((req, res) =>
    ok(res, otp.issue(req.valid!.params.id, actorOf(req)), 201)));
  r.get('/:id/otp', validate({ params: idParam }), asyncHandler((req, res) => ok(res, otp.status(req.valid!.params.id, actorOf(req)))));
  r.post('/:id/otp/verify', validate({ params: idParam, body: verifyOtpBody }), asyncHandler((req, res) =>
    ok(res, otp.verify(req.valid!.params.id, req.body.code, actorOf(req)))));
  return r;
}

/** Mounted only when DEMO_OTP_ENABLED=true and NODE_ENV != production. */
export function devRouter(ctx: Ctx, otp: OtpService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole('admin', 'coordinator', 'investigator'));
  r.get('/visits/:id/otp', validate({ params: idParam }), asyncHandler((req, res) => {
    const demo = otp.getDemoOtp(req.valid!.params.id);
    if (!demo) throw AppError.notFound('Demo OTP (issue one first; it is only kept in memory by this server process)');
    ok(res, demo);
  }));
  return r;
}
