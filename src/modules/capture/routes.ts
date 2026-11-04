import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, paginated } from '../../utils/http';
import type { CaptureService } from './service';
import {
  createAdverseEventBody, createEcgBody, createMeasurementBody, createReminderBody, listAdverseEventsQuery, listEcgsQuery, listMeasurementsQuery,
  listRemindersQuery, patientParam, recordParam, updateReminderBody,
} from './schemas';

/**
 * Mounted at the API root (not under /patients): it adds `/patients/:patientId/<collection>` and `/<collection>/:id`.
 * `authenticate` is applied per route so an unknown path still falls through to the normal 404.
 *
 * Who may WRITE: measurements and ECG references - staff (admin, coordinator, investigator), who record what happened at the visit;
 * reminders - admin and coordinator (operations); adverse events - staff and the participant for themselves.
 * Who may READ: staff, and a participant only for their own records.
 */
export function captureRouter(ctx: Ctx, svc: CaptureService) {
  const r = Router();
  const auth = authenticate(ctx);
  const STAFF = requireRole('admin', 'coordinator', 'investigator');
  const OPS = requireRole('admin', 'coordinator');
  const ANY = requireRole('admin', 'coordinator', 'investigator', 'patient');

  // ---- measurements
  r.post('/patients/:patientId/measurements', auth, STAFF, validate({ params: patientParam, body: createMeasurementBody }), asyncHandler((req, res) =>
    ok(res, svc.createMeasurement(req.valid!.params.patientId, req.body, actorOf(req)), 201)));
  r.get('/patients/:patientId/measurements', auth, ANY, validate({ params: patientParam, query: listMeasurementsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query; const { items, total } = svc.listMeasurements(req.valid!.params.patientId, q, actorOf(req));
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/measurements/:id', auth, ANY, validate({ params: recordParam }), asyncHandler((req, res) => ok(res, svc.getMeasurement(req.valid!.params.id, actorOf(req)))));

  // ---- ECG references
  r.post('/patients/:patientId/ecgs', auth, STAFF, validate({ params: patientParam, body: createEcgBody }), asyncHandler((req, res) =>
    ok(res, svc.registerEcg(req.valid!.params.patientId, req.body, actorOf(req)), 201)));
  r.get('/patients/:patientId/ecgs', auth, ANY, validate({ params: patientParam, query: listEcgsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query; const { items, total } = svc.listEcgs(req.valid!.params.patientId, q, actorOf(req));
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/ecgs/:id', auth, ANY, validate({ params: recordParam }), asyncHandler((req, res) => ok(res, svc.getEcg(req.valid!.params.id, actorOf(req)))));

  // ---- reminders
  r.post('/patients/:patientId/reminders', auth, OPS, validate({ params: patientParam, body: createReminderBody }), asyncHandler((req, res) =>
    ok(res, svc.createReminder(req.valid!.params.patientId, req.body, actorOf(req)), 201)));
  r.get('/patients/:patientId/reminders', auth, ANY, validate({ params: patientParam, query: listRemindersQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query; const { items, total } = svc.listReminders(req.valid!.params.patientId, q, actorOf(req));
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/reminders/:id', auth, ANY, validate({ params: recordParam }), asyncHandler((req, res) => ok(res, svc.getReminder(req.valid!.params.id, actorOf(req)))));
  r.patch('/reminders/:id', auth, OPS, validate({ params: recordParam, body: updateReminderBody }), asyncHandler((req, res) =>
    ok(res, svc.updateReminder(req.valid!.params.id, req.body, actorOf(req)))));

  // ---- adverse events (append-only: the schema holds only that a report exists and when, so there is nothing to edit)
  r.post('/patients/:patientId/adverse-events', auth, ANY, validate({ params: patientParam, body: createAdverseEventBody }), asyncHandler((req, res) =>
    ok(res, svc.reportAdverseEvent(req.valid!.params.patientId, req.body, actorOf(req)), 201)));
  r.get('/patients/:patientId/adverse-events', auth, ANY, validate({ params: patientParam, query: listAdverseEventsQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query; const { items, total } = svc.listAdverseEvents(req.valid!.params.patientId, q, actorOf(req));
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.get('/adverse-events/:id', auth, ANY, validate({ params: recordParam }), asyncHandler((req, res) => ok(res, svc.getAdverseEvent(req.valid!.params.id, actorOf(req)))));

  return r;
}
