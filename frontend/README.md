# TrialVerse frontend

React 19 + TypeScript + Vite + Tailwind CSS 4 single-page app for the TrialVerse backend (`../`). One app, three role-based workspaces. The backend is the source of truth for authorization; the UI only chooses what to show.

## Run

```bash
# backend (from repo root): npm run setup && npm run migrate && npm run seed && npm run dev   -> http://localhost:3000
cd frontend
npm install
cp .env.example .env      # VITE_API_BASE_URL=http://localhost:3000/api/v1   (public config only, no secrets)
npm run dev               # http://localhost:5173  (matches the backend's default CORS_ORIGINS)
npm run typecheck && npm run build
npm test                  # component, API-layer and access-control tests (no backend needed)
```

Demo logins (seed data, password `DemoPass#2025`) appear as quick-fill chips on the login page **in dev builds only**.

## Workspaces and routes

| Workspace | Roles | Routes |
|---|---|---|
| Site operations `/app` | admin, coordinator, investigator | overview, `patients(/:id)`, `trials(/:id)`, `trials/:id/sites/:siteId`, `enrollments`, `visits(/:id)`, `reimbursements`, `actions`; **admin only:** `users` |
| Trial oversight `/sponsor` (the URL prefix is historical; there is no sponsor role) | admin, investigator | overview, `trials(/:id)` and sites (read-only), `participant-risk`, `risk`, `integrity` (monitoring), `integrity/alerts` (alert log), `audit`, `rules` (read-only) |
| Participant `/me` | patient | home, `visits(/:id)`, `reimbursements`, `profile` (mobile-first, bottom tab bar) |

Public: `/login`, `/register` (participant self-registration; the new account shows an "awaiting activation" screen until staff link it to a patient record). Unauthenticated → `/login`; wrong role → `/forbidden`; expired/invalid token (401) → session cleared and back to login.
Action-level gating mirrors backend rules (e.g. only admin/investigator see *Mark completed*; approving your own claim is disabled) but every rule is still enforced and reported by the server.

## Structure

```
src/api/          axios client (envelope unwrapping, bearer token, ApiError, 401 handling) + one module per resource
src/contexts/     AuthContext (session restore via GET /auth/me)
src/routes/       router (lazy-loaded pages) + guards
src/layouts/      StaffShell (sidebar), Operations/Sponsor/Participant layouts
src/features/     auth, coordinator, patients, trials, visits (OTP workflow), reimbursements, actions, participant, sponsor
src/components/   ui (button, card, input, badge, dialog), common (states, badges, filters), tables, charts
src/hooks/        useDirectory (resolves id -> name from cached lists), useDebounce
src/utils/        format, roles, transitions (UI hints mirroring backend state machines)
```

## API mapping (all endpoints used exist in `docs/API_ENDPOINTS.md`)

| Area | Endpoints used |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me` |
| Patients | `GET/POST /patients`, `GET/PATCH/DELETE /patients/:id` (PATCH also links/unlinks `userId`), `GET /patients/me` |
| Trials & sites | `GET/POST /trials`, `GET/PATCH/DELETE /trials/:id`, `GET/POST /trials/:id/sites`, `GET/PATCH /trials/:id/sites/:siteId` |
| Enrollments | `GET/POST /enrollments`, `PATCH /enrollments/:id` |
| Visits | `GET/POST /visits`, `GET/PATCH /visits/:id`, `POST /visits/:id/status` |
| OTP | `POST/GET /visits/:id/otp`, `POST /visits/:id/otp/verify`, `GET /dev/visits/:id/otp` (dev only) |
| Reimbursements | list/create/get/`PATCH`, `/history`, `/approve`, `/reject`, `/cancel`, `/payment` |
| Actions | list/create/get, `PATCH /actions/:id`, `POST /actions/:id/status`, `/history` |
| Risk | `GET/POST /risk/assessments`, `GET /risk/assessments/:id` |
| Integrity | `GET /integrity/alerts(/:id)`, `PATCH /integrity/alerts/:id`, `POST /integrity/scans` |
| Audit | `GET /audit`, `GET /audit/verify` |
| Users (admin only) | `GET/POST /users`, `GET/PATCH /users/:id` |
| Staff directory (all staff) | `GET /users/directory` (id, fullName, role only) |
| Account linking (admin + coordinator) | `GET /patients/linkable-accounts`, `POST/DELETE /patients/:id/account` |
| Stats (aggregates) | `GET /stats/operations`, `/stats/visits`, `/stats/reimbursements` (staff), `/stats/sponsor` (admin + investigator) |
| Visit history (staff) | `GET /visits/:id/history` |
| Registration | `POST /auth/register` (name, email, password only) |
| Rules (read-only) | `GET /risk/rules`, `GET /integrity/rules` |

Not used by the UI: `GET /audit/:id` and the single-record `GET`s that lists already cover.

## Email OTP (Phase 4)

- **Staff** click **Issue OTP**; the code is emailed to the participant's linked account and a toast confirms the (masked) address. The panel then shows expiry, attempts left and a **Resend code** button that is disabled with a live countdown during the 60 s cooldown. Staff never see the code, and the verify box is hidden in email mode (the participant verifies in their own portal).
- **Participants** see "We emailed you a 6-digit code" with the masked address, an expiry countdown and attempts left. The visit page polls every 8 s while waiting, so the code box appears as soon as staff send it. There is **no participant resend button**: only staff can issue or resend, so a code cannot be requested from home and used to verify attendance remotely. Locked/expired/used states tell them to ask clinic staff for a new code.
- Errors shown to staff: no linked/active account, cooldown, delivery failed (generic, nothing issued), delivery not configured.
- **Development only:** when the backend runs in demo mode (`DEMO_OTP_ENABLED=true`, email off) the amber "Development only" panel appears; it is never shown when email delivery is on.

## Visit verification workflow

Scheduled → staff **Issue OTP** → (dev) reveal demo code → participant or staff **Verify** → visit `verified` → investigator/admin **Mark completed**.
Verification and completion are separate operations. Handled outcomes: incorrect code (with remaining attempts), expired, locked, reused / not active, forbidden, invalid state transition, validation. The panel also shows attempts left, a live expiry countdown and the OTP state.

## Phase 2.5 behaviour worth knowing

- **Delete** (admin only) is a soft delete and is refused with 409 when a patient/trial has enrollments; the message is shown in the confirm dialog. Terminate a trial or withdraw a patient instead.
- **Pickers that need `/users` (admin-only):** principal investigator, portal-account link, action assignee. Coordinators and investigators can still edit everything else; for those pickers they see a note (actions: assign to self or unassign).
- **Trial/visit/action edits** follow backend rules: visits only while `scheduled`/`otp_pending` (admin, coordinator); actions only by creator, assignee or admin while open; trial code and site code are immutable; trial description/dates can be changed but not cleared (the API has no null for them).
- **Rules screens are read-only** because the API exposes no way to change rules (server config only).
- **Visit history** is the audit trail for that visit, so it is visible to admin/investigator only.

## ML views (Phase 3)
Everything below uses existing backend endpoints; the browser never talks to the Python service, and no score, factor or finding is computed or invented in the frontend (`src/lib/ml.ts` only classifies, groups and orders what the API returns).

| Page | Route (roles) | Endpoints |
|---|---|---|
| Participant risk | `/app/risk` (admin, coordinator, investigator) and `/sponsor/participant-risk` (admin, investigator) | `GET /trials`, `GET /enrollments?trialId=`, `GET /risk/assessments?entityType=patient`, `POST /risk/assessments` |
| Risk assessments (log) | `/sponsor/risk` | `GET/POST /risk/assessments`, `GET /risk/assessments/:id` |
| Integrity monitoring | `/sponsor/integrity` (admin, investigator) | `GET /trials/:id/sites`, `GET /integrity/alerts`, `POST /integrity/scans` (`trialId`), `GET /audit?action=integrity.scan_completed` (scan history), `PATCH /integrity/alerts/:id` |
| Trial oversight overview | `/sponsor` | `GET /stats/sponsor`, `GET /stats/operations`, `GET /integrity/alerts?entityType=site&status=open` |

How to read them:
* A risk result is labelled **ML model**, **Rule engine (ML not used)** or **Rule engine (ML unavailable)** from `engine` + `fallback`; the fallback reason is shown as returned. Factors are `triggeredRules` (for the model, signed contributions in points).
* A scan result keeps four outcomes apart: *failed* (nothing was checked), *fallback* (ML checks did not run), *completed with no findings*, and *findings*. Coverage gaps (sites skipped for a missing timezone, truncation) are listed.
* `POST /integrity/scans` with a `trialId` still raises audit-based alerts about the whole platform. The monitoring page therefore splits alerts into **trial findings** (alert evidence names one of the trial's sites) and **platform-wide alerts** (collapsed).
* Participants have no access to any of this: no route, no nav entry, and the backend answers 403 (covered by tests).

### Gaps found (documented, not worked around)
* The API does not return the model's `recommendedActions` or `retentionRiskLevel` (the backend parses and drops them; decision D7). Only the engine's explanation text and the factors are shown.
* There is no `sponsor` role: the sponsor workspace is for admin + investigator. A coordinator can assess risk but, as the backend enforces, cannot use integrity.
* Alerts have no trial filter and scans are not stored with their trial; trial scoping is derived from the site ids in each alert's evidence, and scan history is read from the audit trail (it does not say which trial was scanned).
* No participant-level retention trends: the API stores assessments but offers no time-series endpoint, so none is drawn.

## Tests
`npm test` (Vitest + Testing Library, jsdom). Component tests run through the real axios client, API modules and interceptors with only the transport stubbed; their fixtures (`src/test/fixtures`) are responses captured from the real backend + Python service. `src/test/live.test.ts` runs the frontend's API layer against a running stack (skipped unless `TRIALVERSE_LIVE_API` and `TRIALVERSE_LIVE_PASSWORD` are set). There is no automated browser (E2E) suite (the capture/reminder flow was verified manually in Chrome): layout and responsive behaviour are not covered by tests.

## Phase 3: backend integration

- **Names come from the API.** Visits, enrollments, reimbursements, actions, alerts, risk assessments, sites, audit events and status history embed `patientName`, `trialCode`, `siteName`, `actorName`, ... so list screens no longer resolve ids client-side. Participants now see trial/site names for their own records.
- **Dashboards use `/stats/*`.** The operations overview makes 2 data requests (was 8) and the sponsor overview 2 (was ~13).
- **Staff pickers** (principal investigator, action assignee, assignee filter) use `/users/directory`, so coordinators and investigators can use them. Only admins can use `/users`.
- **Account linking** (admin + coordinator): the patient Edit dialog lists only unlinked registrations (`/patients/linkable-accounts`) and links/unlinks through the dedicated endpoints; staff see a notice on the Patients page when registrations are waiting.
- **Visit history** uses `GET /visits/:id/history` and is visible to all staff.
- Risk figures on the sponsor overview now use each entity's **latest** assessment (previously every stored assessment was counted).

## Known backend limitations / requests (not worked around with fake data)

1. **Participants cannot retrieve their own OTP.** `GET /dev/visits/:id/otp` is staff-only and `issue` returns `demoOtp` only to staff. In the demo, staff reads the code from the *Development only* panel and gives it to the participant. Real fix: OTP delivery (SMS/email), already listed as Phase 1.
2. **Patient and trial pickers load whole lists** (pageSize cap 100, paged client-side). Fine at demo scale; needs server-side search/typeahead at scale.
3. **The risk page lists assessment history** sorted by score; there is no "latest per entity" list endpoint (the overview stats do use latest-per-entity).
4. **Users cannot be deleted**, and email/password cannot be changed by admins (no password reset or change endpoint).
5. **Deleting a patient keeps its portal link**, so that account cannot be linked to another record (the `user_id` stays on the soft-deleted row). Request: clear the link on delete, or allow re-linking.
6. **Registrations show email to coordinators** (needed to match a person); there is no richer matching (e.g. by date of birth).
7. No ECG / symptom / reminder / ML endpoints exist, so no such screens were built.

## Remaining for Person B / shared integration

- ML models behind `docs/ML_INTEGRATION.md`. The UI already displays `engine`, `fallback.used` and `fallback.reason` from assessments and scan results, so ML output will appear without frontend changes.
- Any model-specific explainability fields (`factors`, `confidence`) are in the ML contract but not exposed by the current API responses; if added, extend `RiskAssessment` in `src/types/api.ts` and the detail dialog.

## Data capture (staff patient page and participant "Records")

`src/features/capture/CapturePanel.tsx`, backed by `src/api/capture.ts` and the backend capture endpoints (`/patients/:id/measurements|ecgs|reminders|adverse-events`, `PATCH /reminders/:id`).

- **Staff** (`/app/patients/:id`): record a measurement (admin, coordinator, investigator), register an ECG *reference* (same roles), log a reminder and mark it acknowledged or missed (admin, coordinator), report a symptom (any staff).
- **Participant** (`/me/records`): their own measurements, reminders and ECG metadata (no file path or hash), and a form to report a symptom. The server scopes everything to the signed-in patient.
- ECGs are references to files under the backend's `ML_ECG_DIR`; nothing is uploaded. Blank measurement fields are sent as absent (never 0). A reminder is *missed* if not acknowledged within 24 hours; an empty reminder list means no data, not zero missed.
