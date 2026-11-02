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
```

Demo logins (seed data, password `DemoPass#2025`) appear as quick-fill chips on the login page **in dev builds only**.

## Workspaces and routes

| Workspace | Roles | Routes |
|---|---|---|
| Site operations `/app` | admin, coordinator, investigator | overview, `patients(/:id)`, `trials(/:id)`, `enrollments`, `visits(/:id)`, `reimbursements`, `actions` |
| Sponsor oversight `/sponsor` | admin, investigator | overview, `trials(/:id)` (read-only), `risk`, `integrity`, `audit` |
| Participant `/me` | patient | home, `visits(/:id)`, `reimbursements`, `profile` (mobile-first, bottom tab bar) |

Unauthenticated → `/login`; wrong role → `/forbidden`; expired/invalid token (401) → session cleared and back to login.
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
| Patients | `GET/POST /patients`, `GET/PATCH /patients/:id`, `GET /patients/me` |
| Trials & sites | `GET/POST /trials`, `GET/PATCH /trials/:id`, `GET/POST /trials/:id/sites` |
| Enrollments | `GET/POST /enrollments`, `PATCH /enrollments/:id` |
| Visits | `GET/POST /visits`, `GET /visits/:id`, `POST /visits/:id/status` |
| OTP | `POST/GET /visits/:id/otp`, `POST /visits/:id/otp/verify`, `GET /dev/visits/:id/otp` (dev only) |
| Reimbursements | list/create/get/`PATCH`, `/history`, `/approve`, `/reject`, `/cancel`, `/payment` |
| Actions | list/create/get, `POST /actions/:id/status`, `/history` |
| Risk | `GET/POST /risk/assessments`, `GET /risk/assessments/:id` |
| Integrity | `GET /integrity/alerts(/:id)`, `PATCH /integrity/alerts/:id`, `POST /integrity/scans` |
| Audit | `GET /audit`, `GET /audit/verify` |
| Users | `GET /users` (admin only, used to resolve names) |

Not used by the UI: `PATCH /visits/:id`, `PATCH /actions/:id`, all `DELETE`s, user create/update, `GET /risk/rules`, `GET /integrity/rules`, `GET /audit/:id`.

## Visit verification workflow

Scheduled → staff **Issue OTP** → (dev) reveal demo code → participant or staff **Verify** → visit `verified` → investigator/admin **Mark completed**.
Verification and completion are separate operations. Handled outcomes: incorrect code (with remaining attempts), expired, locked, reused / not active, forbidden, invalid state transition, validation. The panel also shows attempts left, a live expiry countdown and the OTP state.

## Known backend limitations / requests (not worked around with fake data)

1. **Participants cannot retrieve their own OTP.** `GET /dev/visits/:id/otp` is staff-only and `issue` returns `demoOtp` only to staff. In the demo, staff reads the code from the *Development only* panel and gives it to the participant. Real fix: OTP delivery (SMS/email), already listed as Phase 1.
2. **No names in patient responses.** Participants cannot call `/trials` or sites, so their enrollment/visit screens cannot show trial title or site. Request: include `trialCode`, `trialTitle`, `siteName` in `/enrollments` and `/visits` responses (or a `GET /patients/me/summary`).
3. **Non-admins cannot resolve user names.** `/users` is admin-only, so actors, assignees and reviewers show a short id (or "System") for coordinator/investigator. Request: a minimal `GET /users/directory` (id, fullName, role) for staff, or embed `actorName` in audit/history rows.
4. **No aggregate/stat endpoints.** Dashboard numbers use `meta.total` from filtered list calls (several small requests). Request: `GET /stats/overview`, `GET /risk/summary`, `GET /integrity/summary`.
5. **Directory lookups load whole lists** (pageSize cap 100, paged client-side). Fine at demo scale; needs server-side joins or search endpoints at scale.
6. **Actions assignee picker** is "assign to me" only, because listing assignable users needs (3).
7. **Latest risk per entity** is not exposed; the risk page lists assessment history sorted by score.
8. No ECG / symptom / reminder / ML endpoints exist, so no such screens were built.

## Remaining for Person B / shared integration

- ML models behind `docs/ML_INTEGRATION.md`. The UI already displays `engine`, `fallback.used` and `fallback.reason` from assessments and scan results, so ML output will appear without frontend changes.
- Any model-specific explainability fields (`factors`, `confidence`) are in the ML contract but not exposed by the current API responses; if added, extend `RiskAssessment` in `src/types/api.ts` and the detail dialog.
