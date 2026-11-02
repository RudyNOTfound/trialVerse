import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import type { AppConfig } from '../config/env';
import { createActionBody, actionStatusBody, listActionsQuery, updateActionBody } from '../modules/actions/schemas';
import { auditListQuery } from '../modules/audit/schemas';
import { loginBody, registerBody } from '../modules/auth/schemas';
import { listAlertsQuery, scanBody, updateAlertBody } from '../modules/integrity/schemas';
import { createPatientBody, linkableAccountsQuery, linkAccountBody, listPatientsQuery, updatePatientBody } from '../modules/patients/schemas';
import {
  createReimbursementBody, listReimbursementsQuery, noteBody, paymentBody, rejectBody, updateReimbursementBody,
} from '../modules/reimbursements/schemas';
import { assessBody, listAssessmentsQuery } from '../modules/risk/schemas';
import { sponsorStatsQuery, visitStatsQuery } from '../modules/stats/schemas';
import {
  createEnrollmentBody, createSiteBody, createTrialBody, listEnrollmentsQuery, listTrialsQuery, updateEnrollmentBody, updateSiteBody, updateTrialBody,
} from '../modules/trials/schemas';
import { createUserBody, directoryQuery, listUsersQuery, updateUserBody } from '../modules/users/schemas';
import { createVisitBody, listVisitsQuery, updateVisitBody, verifyOtpBody, visitStatusBody } from '../modules/visits/schemas';

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Doc {
  summary: string; tag: string;
  /** Roles allowed; omit for public. */
  roles?: string;
  body?: ZodTypeAny; query?: ZodTypeAny; status?: number; description?: string; paginated?: boolean;
}

const A = 'admin', C = 'coordinator', I = 'investigator', P = 'patient';
const STAFF = `${A}, ${C}, ${I}`;

const ROUTES: Array<[Method, string, Doc]> = [
  ['post', '/auth/register', { tag: 'Auth', summary: 'Register a patient account (rate limited)', body: registerBody, status: 201, description: 'Public self-registration always creates a `patient` role account. Staff accounts are created by admins via POST /users.' }],
  ['post', '/auth/login', { tag: 'Auth', summary: 'Log in and receive a JWT', body: loginBody }],
  ['get', '/auth/me', { tag: 'Auth', summary: 'Current user', roles: 'any authenticated' }],

  ['get', '/users', { tag: 'Users', summary: 'List users', roles: A, query: listUsersQuery, paginated: true }],
  ['post', '/users', { tag: 'Users', summary: 'Create a user with any role', roles: A, body: createUserBody, status: 201 }],
  ['get', '/users/directory', { tag: 'Users', summary: 'Minimal staff directory for pickers and name display', roles: STAFF, query: directoryQuery, paginated: true, description: 'Returns only `id`, `fullName`, `role`, `isActive` for admin/coordinator/investigator accounts. Never returns email, patient accounts or credentials. Inactive staff are excluded unless `includeInactive=true`.' }],
  ['get', '/users/{id}', { tag: 'Users', summary: 'Get a user', roles: A }],
  ['patch', '/users/{id}', { tag: 'Users', summary: 'Update name, role or active flag', roles: A, body: updateUserBody }],

  ['get', '/patients', { tag: 'Patients', summary: 'List patients', roles: STAFF, query: listPatientsQuery, paginated: true }],
  ['post', '/patients', { tag: 'Patients', summary: 'Create a patient', roles: `${A}, ${C}`, body: createPatientBody, status: 201 }],
  ['get', '/patients/me', { tag: 'Patients', summary: 'Own patient record', roles: P }],
  ['get', '/patients/{id}', { tag: 'Patients', summary: 'Get a patient (patients: own record only)', roles: `${STAFF}, ${P} (own)` }],
  ['get', '/patients/linkable-accounts', { tag: 'Patients', summary: 'Registered patient accounts that are not yet linked to a patient record', roles: `${A}, ${C}`, query: linkableAccountsQuery, paginated: true, description: 'Active `patient`-role users with no patient record. Returns `id`, `fullName`, `email`, `createdAt` only; this is the narrow view coordinators use instead of the admin-only user list.' }],
  ['post', '/patients/{id}/account', { tag: 'Patients', summary: 'Link a registered portal account to this patient', roles: `${A}, ${C}`, body: linkAccountBody, status: 201, description: 'Validates that the user exists, is active, has the patient role, is not linked to another patient, and that this patient has no link yet (409 otherwise). Audited as `patient.account_linked`.' }],
  ['delete', '/patients/{id}/account', { tag: 'Patients', summary: 'Remove the portal link from this patient', roles: `${A}, ${C}`, description: '409 if there is no link. Audited as `patient.account_unlinked`.' }],
  ['patch', '/patients/{id}', { tag: 'Patients', summary: 'Update a patient / link a user account', roles: `${A}, ${C}`, body: updatePatientBody }],
  ['delete', '/patients/{id}', { tag: 'Patients', summary: 'Soft-delete a patient with no enrollments', roles: A }],

  ['get', '/trials', { tag: 'Trials', summary: 'List trials', roles: STAFF, query: listTrialsQuery, paginated: true }],
  ['post', '/trials', { tag: 'Trials', summary: 'Create a trial (starts in draft)', roles: `${A}, ${C}`, body: createTrialBody, status: 201 }],
  ['get', '/trials/{id}', { tag: 'Trials', summary: 'Get a trial', roles: STAFF }],
  ['patch', '/trials/{id}', { tag: 'Trials', summary: 'Update a trial; status changes follow the trial state machine', roles: `${A}, ${C}`, body: updateTrialBody }],
  ['delete', '/trials/{id}', { tag: 'Trials', summary: 'Soft-delete a trial without enrollments', roles: A }],
  ['get', '/trials/{id}/sites', { tag: 'Trials', summary: 'List sites of a trial', roles: STAFF }],
  ['post', '/trials/{id}/sites', { tag: 'Trials', summary: 'Add a site to a trial', roles: `${A}, ${C}`, body: createSiteBody, status: 201 }],
  ['get', '/trials/{id}/sites/{siteId}', { tag: 'Trials', summary: 'Get a trial site', roles: STAFF }],
  ['patch', '/trials/{id}/sites/{siteId}', { tag: 'Trials', summary: 'Update a trial site', roles: `${A}, ${C}`, body: updateSiteBody }],

  ['get', '/enrollments', { tag: 'Enrollments', summary: 'List enrollments (patients see their own)', roles: `${STAFF}, ${P} (own)`, query: listEnrollmentsQuery, paginated: true }],
  ['post', '/enrollments', { tag: 'Enrollments', summary: 'Enrol a patient into a trial site (status: screening)', roles: `${A}, ${C}`, body: createEnrollmentBody, status: 201 }],
  ['get', '/enrollments/{id}', { tag: 'Enrollments', summary: 'Get an enrollment', roles: `${STAFF}, ${P} (own)` }],
  ['patch', '/enrollments/{id}', { tag: 'Enrollments', summary: 'Change enrollment status (state machine)', roles: STAFF, body: updateEnrollmentBody }],

  ['get', '/visits', { tag: 'Visits', summary: 'List visits (patients see their own)', roles: `${STAFF}, ${P} (own)`, query: listVisitsQuery, paginated: true }],
  ['post', '/visits', { tag: 'Visits', summary: 'Schedule a visit for an enrollment', roles: `${A}, ${C}`, body: createVisitBody, status: 201 }],
  ['get', '/visits/{id}', { tag: 'Visits', summary: 'Get a visit', roles: `${STAFF}, ${P} (own)` }],
  ['get', '/visits/{id}/history', { tag: 'Visits', summary: 'Visit history: status changes, edits and OTP events', roles: STAFF, description: 'Read-only projection of the audit trail for one visit, oldest first, with actor names. Exposes a fixed allow-list of fields (no hashes, no raw metadata, never an OTP). Participants receive 403.' }],
  ['patch', '/visits/{id}', { tag: 'Visits', summary: 'Edit a scheduled visit', roles: `${A}, ${C}`, body: updateVisitBody }],
  ['post', '/visits/{id}/status', { tag: 'Visits', summary: 'Mark a visit completed (requires OTP verification; investigator/admin), missed or cancelled', roles: STAFF, body: visitStatusBody }],
  ['post', '/visits/{id}/otp', { tag: 'OTP', summary: 'Issue an OTP (supersedes any active one)', roles: STAFF, status: 201, description: 'Only an HMAC of the OTP is stored. The response includes `demoOtp` ONLY when DEMO_OTP_ENABLED=true outside production.' }],
  ['get', '/visits/{id}/otp', { tag: 'OTP', summary: 'Latest OTP status (never the code)', roles: `${STAFF}, ${P} (own)` }],
  ['post', '/visits/{id}/otp/verify', { tag: 'OTP', summary: 'Verify an OTP and mark the visit verified', roles: `${STAFF}, ${P} (own)`, body: verifyOtpBody, description: 'Errors: 400 OTP_INVALID (with remainingAttempts), 410 OTP_EXPIRED, 423 OTP_LOCKED, 409 OTP_NOT_ACTIVE (reuse / none issued). Every outcome is audited.' }],
  ['get', '/dev/visits/{id}/otp', { tag: 'OTP', summary: 'DEV ONLY: demo OTP last issued by this server process', roles: STAFF, description: 'Route exists only when DEMO_OTP_ENABLED=true and NODE_ENV is not production.' }],

  ['get', '/audit', { tag: 'Audit', summary: 'List audit events (filterable)', roles: `${A}, ${I}`, query: auditListQuery, paginated: true }],
  ['get', '/audit/verify', { tag: 'Audit', summary: 'Verify the entire hash chain; the attempt itself is recorded', roles: `${A}, ${I}`, description: 'Returns `valid`, `errors[]` (type: sequence_gap | prev_hash_mismatch | hash_mismatch | head_mismatch) and the chain head. Responds 200 even when invalid.' }],
  ['get', '/audit/{id}', { tag: 'Audit', summary: 'Get one audit event', roles: `${A}, ${I}` }],

  ['get', '/reimbursements', { tag: 'Reimbursements', summary: 'List reimbursements (patients see their own)', roles: `${STAFF}, ${P} (own)`, query: listReimbursementsQuery, paginated: true }],
  ['post', '/reimbursements', { tag: 'Reimbursements', summary: 'Create a reimbursement request for a visit', roles: `${A}, ${C}, ${P} (own visit)`, body: createReimbursementBody, status: 201 }],
  ['get', '/reimbursements/{id}', { tag: 'Reimbursements', summary: 'Get a reimbursement', roles: `${STAFF}, ${P} (own)` }],
  ['patch', '/reimbursements/{id}', { tag: 'Reimbursements', summary: 'Edit a pending request (requester or admin)', roles: `${A}, ${C}, ${P}`, body: updateReimbursementBody }],
  ['get', '/reimbursements/{id}/history', { tag: 'Reimbursements', summary: 'Status and payment-status transitions', roles: `${STAFF}, ${P} (own)` }],
  ['post', '/reimbursements/{id}/approve', { tag: 'Reimbursements', summary: 'Approve (reviewer must differ from requester)', roles: `${A}, ${I}`, body: noteBody }],
  ['post', '/reimbursements/{id}/reject', { tag: 'Reimbursements', summary: 'Reject with a reason', roles: `${A}, ${I}`, body: rejectBody }],
  ['post', '/reimbursements/{id}/cancel', { tag: 'Reimbursements', summary: 'Cancel (requester or admin)', roles: `${A}, ${C}, ${P}`, body: noteBody }],
  ['post', '/reimbursements/{id}/payment', { tag: 'Reimbursements', summary: 'Advance payment: processing → paid | failed (admin)', roles: A, body: paymentBody }],

  ['get', '/actions', { tag: 'Actions', summary: 'List actions; status=overdue filters open actions past due', roles: STAFF, query: listActionsQuery, paginated: true }],
  ['post', '/actions', { tag: 'Actions', summary: 'Create an action', roles: STAFF, body: createActionBody, status: 201 }],
  ['get', '/actions/{id}', { tag: 'Actions', summary: 'Get an action', roles: STAFF }],
  ['patch', '/actions/{id}', { tag: 'Actions', summary: 'Edit an open action (creator, assignee, admin)', roles: STAFF, body: updateActionBody }],
  ['post', '/actions/{id}/status', { tag: 'Actions', summary: 'Change status (creator, assignee, admin)', roles: STAFF, body: actionStatusBody }],
  ['get', '/actions/{id}/history', { tag: 'Actions', summary: 'Action status history', roles: STAFF }],

  ['get', '/stats/operations', { tag: 'Stats', summary: 'Operational dashboard counts (patients, trials, enrollments, visits, actions, reimbursements)', roles: STAFF, description: 'SQL aggregates with zero-filled status keys. `actions.overdue` and `visits.pastDueUnverified` are derived at read time.' }],
  ['get', '/stats/visits', { tag: 'Stats', summary: 'Visit status counts and the next open visits', roles: STAFF, query: visitStatsQuery }],
  ['get', '/stats/reimbursements', { tag: 'Stats', summary: 'Reimbursement counts by status/payment status and amounts by currency', roles: STAFF, description: 'Money is grouped per currency and never summed across currencies.' }],
  ['get', '/stats/sponsor', { tag: 'Stats', summary: 'Sponsor overview: trials, risk by level, integrity alerts, audit head', roles: `${A}, ${I}`, query: sponsorStatsQuery, description: 'Risk figures use each entity\'s latest assessment. The audit section reports counts only; it does not run chain verification (use GET /audit/verify).' }],

  ['post', '/risk/assessments', { tag: 'Risk', summary: 'Run the risk engine for a patient, visit or reimbursement', roles: STAFF, body: assessBody, status: 201 }],
  ['get', '/risk/assessments', { tag: 'Risk', summary: 'List stored risk assessments', roles: STAFF, query: listAssessmentsQuery, paginated: true }],
  ['get', '/risk/assessments/{id}', { tag: 'Risk', summary: 'Get a risk assessment', roles: STAFF }],
  ['get', '/risk/rules', { tag: 'Risk', summary: 'Active engine and rule configuration', roles: STAFF }],

  ['post', '/integrity/scans', { tag: 'Integrity', summary: 'Run an integrity scan and raise (de-duplicated) alerts', roles: `${A}, ${I}`, body: scanBody, status: 201 }],
  ['get', '/integrity/alerts', { tag: 'Integrity', summary: 'List integrity alerts', roles: `${A}, ${I}`, query: listAlertsQuery, paginated: true }],
  ['get', '/integrity/alerts/{id}', { tag: 'Integrity', summary: 'Get an integrity alert', roles: `${A}, ${I}` }],
  ['patch', '/integrity/alerts/{id}', { tag: 'Integrity', summary: 'Acknowledge / resolve / dismiss / reopen an alert', roles: `${A}, ${I}`, body: updateAlertBody }],
  ['get', '/integrity/rules', { tag: 'Integrity', summary: 'Active engine and rule configuration', roles: `${A}, ${I}` }],
];

const toSchema = (s: ZodTypeAny) => {
  const j = zodToJsonSchema(s, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

function queryParameters(schema: ZodTypeAny) {
  const js = toSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({ name, in: 'query', required: js.required?.includes(name) ?? false, schema: s }));
}

const errorResponses = {
  400: 'Validation error', 401: 'Missing, invalid or expired token', 403: 'Role not permitted / not your record',
  404: 'Not found', 409: 'Conflict or invalid state transition',
};

export function buildOpenApiDocument(config: AppConfig) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, d] of ROUTES) {
    const isDev = path.startsWith('/dev/');
    const isPublic = d.roles === undefined;
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }));
    const status = d.status ?? 200;
    (paths[path] ??= {})[method] = {
      tags: [d.tag],
      summary: d.summary,
      description: [d.description, d.roles ? `**Roles:** ${d.roles}` : '**Public**', isDev ? '**Development only.**' : ''].filter(Boolean).join('\n\n'),
      security: isPublic ? [] : [{ bearerAuth: [] }],
      parameters: [...params, ...(d.query ? queryParameters(d.query) : [])],
      ...(d.body ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(d.body) } } } } : {}),
      responses: {
        [status]: {
          description: d.paginated ? 'Paginated list: `{ success, data: [...], meta: { page, pageSize, total, totalPages } }`' : 'Success: `{ success: true, data }`',
          content: { 'application/json': { schema: { $ref: d.paginated ? '#/components/schemas/PaginatedResponse' : '#/components/schemas/SuccessResponse' } } },
        },
        ...Object.fromEntries(Object.entries(errorResponses)
          .filter(([code]) => (isPublic ? ['400', '401', '409'] : ['400', '401', '403', '404', '409']).includes(code))
          .map(([code, description]) => [code, { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }])),
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'TrialGuard API',
      version: '0.1.0',
      description:
        'Clinical trial management and integrity platform (Phase 0 backend).\n\n' +
        '**Auth:** obtain a token from `POST /auth/login`, then send `Authorization: Bearer <token>`.\n\n' +
        '**Envelope:** success `{ success: true, data, meta? }`; error `{ success: false, error: { code, message, details?, requestId } }`.\n\n' +
        '**Audit chain:** a tamper-*evident* hash chain; it detects modification/deletion but does not make the database immutable.',
    },
    servers: [{ url: '/api/v1', description: `${config.env} server` }],
    tags: ['Auth', 'Users', 'Patients', 'Trials', 'Enrollments', 'Visits', 'OTP', 'Audit', 'Reimbursements', 'Actions', 'Risk', 'Integrity', 'Stats'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        SuccessResponse: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: {} }, required: ['success', 'data'] },
        PaginatedResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true }, data: { type: 'array', items: {} },
            meta: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INVALID_STATE_TRANSITION', 'OTP_INVALID', 'OTP_EXPIRED', 'OTP_LOCKED', 'OTP_NOT_ACTIVE', 'RATE_LIMITED', 'INTERNAL_ERROR'] },
                message: { type: 'string' }, details: {}, requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

export const documentedRouteCount = ROUTES.length;
