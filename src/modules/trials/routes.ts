import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../utils/errors';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { PatientService } from '../patients/service';
import type { TrialService } from './service';
import {
  createEnrollmentBody, createSiteBody, createTrialBody, listEnrollmentsQuery, listTrialsQuery,
  trialSiteParams, updateEnrollmentBody, updateSiteBody, updateTrialBody,
} from './schemas';

const STAFF = ['admin', 'coordinator', 'investigator'] as const;

export function trialsRouter(ctx: Ctx, svc: TrialService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole(...STAFF));

  r.get('/', validate({ query: listTrialsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = svc.listTrials(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', requireRole('admin', 'coordinator'), validate({ body: createTrialBody }), asyncHandler((req, res) =>
    ok(res, svc.createTrial(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.getTrial(req.valid!.params.id))));
  r.patch('/:id', requireRole('admin', 'coordinator'), validate({ params: idParam, body: updateTrialBody }), asyncHandler((req, res) =>
    ok(res, svc.updateTrial(req.valid!.params.id, req.body, actorOf(req)))));
  r.delete('/:id', requireRole('admin'), validate({ params: idParam }), asyncHandler((req, res) => {
    svc.removeTrial(req.valid!.params.id, actorOf(req));
    ok(res, { deleted: true });
  }));

  r.get('/:id/sites', validate({ params: idParam }), asyncHandler((req, res) => ok(res, svc.listSites(req.valid!.params.id))));
  r.post('/:id/sites', requireRole('admin', 'coordinator'), validate({ params: idParam, body: createSiteBody }), asyncHandler((req, res) =>
    ok(res, svc.createSite(req.valid!.params.id, req.body, actorOf(req)), 201)));
  r.get('/:id/sites/:siteId', validate({ params: trialSiteParams }), asyncHandler((req, res) =>
    ok(res, svc.getSite(req.valid!.params.id, req.valid!.params.siteId))));
  r.patch('/:id/sites/:siteId', requireRole('admin', 'coordinator'), validate({ params: trialSiteParams, body: updateSiteBody }), asyncHandler((req, res) =>
    ok(res, svc.updateSite(req.valid!.params.id, req.valid!.params.siteId, req.body, actorOf(req)))));
  return r;
}

export function enrollmentsRouter(ctx: Ctx, svc: TrialService, patients: PatientService) {
  const r = Router();
  r.use(authenticate(ctx));

  r.get('/', validate({ query: listEnrollmentsQuery }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    const q = { ...req.valid!.query };
    // Patients may only see their own enrolments: force the filter server-side.
    if (actor.role === 'patient') q.patientId = patients.getByUserId(actor.id).id;
    const { items, total } = svc.listEnrollments(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', requireRole('admin', 'coordinator'), validate({ body: createEnrollmentBody }), asyncHandler((req, res) =>
    ok(res, svc.createEnrollment(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => {
    const actor = actorOf(req);
    const e = svc.getEnrollment(req.valid!.params.id);
    if (actor.role === 'patient' && patients.getByUserId(actor.id).id !== e.patientId) throw AppError.forbidden();
    ok(res, e);
  }));
  r.patch('/:id', requireRole('admin', 'coordinator', 'investigator'), validate({ params: idParam, body: updateEnrollmentBody }), asyncHandler((req, res) =>
    ok(res, svc.updateEnrollment(req.valid!.params.id, req.body, actorOf(req)))));
  return r;
}
