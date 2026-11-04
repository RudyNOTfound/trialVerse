# TrialGuard — Backend (Phase 0)

Clinical trial management and integrity platform. This repository contains the **Phase 0 backend foundation**: REST API, relational data model, authentication/RBAC, OTP-verified visits, a tamper-evident audit chain, reimbursements, actions, baseline risk/integrity engines, and the integration contracts for separately-developed ML models.

The repository now holds three parts: this TypeScript backend (`src/`, port 3000), a React frontend (`frontend/`, Vite, port 5173) and the Python ML service (`ml-service/`, FastAPI). All data is **synthetic** and the models are **not clinically validated**; nothing here is clinical decision support. A flagged integrity finding is a prompt for review, never a confirmed finding of fraud.

## Run the full stack (local demo)

```bash
# 1. ML service (Python 3.9+; once: pip install -r ml-service/requirements.txt, python -m app.data_generation.generate_all)
cd ml-service && ML_API_KEY=<key> ML_ECG_DIR=$PWD/generated_data uvicorn app.main:app --port 8001
# 2. Backend: set ML_RISK_ENABLED / ML_INTEGRITY_ENABLED=true, ML_RISK_URL / ML_INTEGRITY_URL=http://127.0.0.1:8001, ML_API_KEY, ML_ECG_DIR in .env
npm install && npm run migrate && npm run seed && npm run ml:demo-import && npm run dev
# 3. Frontend (VITE_API_BASE_URL defaults to http://localhost:3000/api/v1)
cd frontend && npm ci && npm run dev
```

Tests: `npm test` and `npm run typecheck` (backend), `cd frontend && npm test && npm run typecheck && npm run build`, `cd ml-service && python -m pytest`. Live backend↔Python tests: see the header of `tests/live/ml-live.test.ts`; live frontend API test: `frontend/src/test/live.test.ts`.

**Data capture in the UI.** Staff patient page (`/app/patients/:id`) has measurement, ECG-reference, reminder and symptom panels; participants have *Records* (`/me/records`) to see their own data and report a symptom. ECGs are registered as a *reference* to a file under `ML_ECG_DIR`; there is no upload service.

| | |
|---|---|
| **Stack** | Node.js ≥ 20, TypeScript (strict), Express 4, SQLite via `better-sqlite3`, Zod, JWT, bcrypt, Vitest + Supertest |
| **API docs** | Swagger UI at `/api/docs`, OpenAPI JSON at `/api/openapi.json` |
| **Docs** | [Architecture](docs/ARCHITECTURE.md) · [Database schema](docs/DATABASE.md) · [API endpoints](docs/API_ENDPOINTS.md) · [ML integration contract](docs/ML_INTEGRATION.md) |

## Quick start

```bash
npm install
npm run setup        # creates .env with generated secrets (never overwrites an existing .env)
npm run migrate      # creates ./data/trialguard.db
npm run seed         # loads demo data   (use `npm run seed:reset` to wipe + reseed)
npm run dev          # http://localhost:3000  (Swagger UI: /api/docs)
```

Then log in:

```bash
curl -s -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@trialguard.demo","password":"DemoPass#2025"}'
```

Send the returned token as `Authorization: Bearer <token>`. In Swagger UI use the **Authorize** button.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (`tsx watch`) |
| `npm run build` / `npm start` | Compile to `dist/` (also copies SQL migrations) / run compiled server |
| `npm run migrate` | Apply pending SQL migrations (idempotent) |
| `npm run seed` / `npm run seed:reset` | Seed demo data into an empty DB / delete the DB file first, then seed |
| `npm test` | Run the full test suite (in-memory DB, no setup needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run docs:api` | Regenerate `docs/API_ENDPOINTS.md` from the OpenAPI registry |

Requirements: Node ≥ 20 (developed on 22). `better-sqlite3` ships prebuilt binaries for common platforms; otherwise a C++ toolchain is needed.

## Demo credentials

Created by the seed. **Every account uses the password `DemoPass#2025`.** Development only — the seeder refuses to run with `NODE_ENV=production`.

| Role | Email |
|---|---|
| admin | `admin@trialguard.demo` |
| coordinator | `coordinator1@trialguard.demo`, `coordinator2@trialguard.demo` |
| investigator | `investigator1@trialguard.demo`, `investigator2@trialguard.demo` |
| patient (linked to a patient record) | `patient1@trialguard.demo` (Amelia Hartwell), `patient2@…` (Rajesh Kulkarni), `patient3@…` (Sofia Marchetti) |

Demo data highlights (so a frontend has something to show immediately):

- 3 trials (2 active, 1 draft), 4 sites, 8 patients, 8 enrollments (screening / enrolled / withdrawn).
- 16 visits covering every status: `scheduled`, `otp_pending`, `verified`, `completed`, `missed`, `cancelled`.
- OTPs in every state: `active`, `used`, `locked`, `expired`. The seeder prints a visit id with an **active OTP whose code is `123456`** (valid 30 days) so OTP verification can be demoed without the dev endpoint.
- 10 reimbursements across all statuses and payment states, including a duplicate pair and an outlier.
- Actions in every state including overdue ones; risk assessments (low → critical); integrity alerts; ~145 audit events forming a valid chain.
- *Daniel Okafor* is the deliberately suspicious patient: locked OTP, guess-then-succeed sequence, duplicate claims, large claim on an unverified visit.

## Configuration

All configuration comes from environment variables, validated at startup (the process exits with a readable error if invalid). See [`.env.example`](.env.example) for every variable.

Required (no defaults, never hard-coded): `JWT_SECRET`, `OTP_PEPPER` (each ≥ 32 chars, must differ). `npm run setup` generates them.

| Concern | Variables |
|---|---|
| Runtime | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `DATABASE_PATH` |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN`, `BCRYPT_ROUNDS` |
| OTP | `OTP_PEPPER`, `OTP_LENGTH`, `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS` (default 60), `OTP_ISSUE_RATE_LIMIT_MAX` (30 / 15 min / user), `OTP_VERIFY_RATE_LIMIT_MAX` (60 / 15 min / user), `DEMO_OTP_ENABLED` |
| OTP email | `OTP_EMAIL_ENABLED` (default `false`), `RESEND_API_KEY`, `OTP_FROM_EMAIL`, `OTP_EMAIL_TIMEOUT_MS` (default 10000) |
| ML | `ML_RISK_ENABLED/URL`, `ML_INTEGRITY_ENABLED/URL`, `ML_TIMEOUT_MS`, `ML_API_KEY` |
| Rules | `RISK_RULES_OVERRIDES`, `INTEGRITY_RULES_OVERRIDES` (JSON merged over defaults) |

### Development vs production

| | development | production |
|---|---|---|
| OTP delivery | `OTP_EMAIL_ENABLED=true`: the code is emailed to the participant and **never** returned. Or, for local use only, `DEMO_OTP_ENABLED=true`: issue response includes `demoOtp` and `GET /api/v1/dev/visits/:id/otp` exists | Email delivery. **App refuses to start** if `DEMO_OTP_ENABLED=true`. Route is not mounted; OTPs are never returned |
| No delivery configured | issuing an OTP fails with `503 OTP_DELIVERY_UNAVAILABLE` (it never falls back to showing the code) | same |
| Email + demo together | **refused at startup** (demo mode would expose codes) | refused |
| CORS | listed origins | `*` rejected at startup |
| Proxy | – | `trust proxy` enabled (so rate limiting sees client IPs) — put it behind a TLS-terminating proxy |
| Seeding | allowed | refused |

Production checklist: strong unique secrets from a secret manager, `NODE_ENV=production`, `DEMO_OTP_ENABLED=false`, **`OTP_EMAIL_ENABLED=true` with a verified sender domain** (see below), explicit `CORS_ORIGINS`, persistent volume for `DATABASE_PATH`, and regular DB backups.

## How the main features work

### Authentication & roles
JWT (HS256) bearer tokens; passwords hashed with bcrypt. The user is **re-loaded from the database on every request**, so deactivation and role changes apply immediately. `POST /auth/register` always creates a `patient` account (no self-service privilege escalation); admins create staff via `POST /users`. Auth endpoints are rate limited.

Roles: `admin`, `coordinator`, `investigator`, `patient`. Authorization is enforced in route middleware and in services (patients are scoped server-side to their own records — client-supplied filters cannot widen that). The per-endpoint role matrix is in [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md).

### Setting up email OTP delivery (Resend)

OTPs are emailed through [Resend](https://resend.com). The provider sits behind a small `EmailProvider` interface (`src/email/`), so another vendor can be swapped in without touching the OTP logic.

1. **Create an account** at <https://resend.com/signup>.
2. **Get an API key**: Dashboard → *API Keys* → *Create API Key* (a "Sending access" key is enough). Copy it once; it starts with `re_`.
3. **Choose a sender.**
   - *Production / real participants:* Dashboard → *Domains* → *Add Domain*, add the DNS records Resend shows you (SPF/DKIM), wait until it shows **Verified**, then use an address on that domain, e.g. `TrialVerse <noreply@yourdomain.com>`.
   - *Quick trial without a domain:* Resend's shared test sender `onboarding@resend.dev` works, but **only delivers to the email address of your own Resend account**. Fine for a smoke test; participants' addresses will be rejected.
4. **Set the environment variables** in `.env` (never commit this file):
   ```env
   OTP_EMAIL_ENABLED=true
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
   OTP_FROM_EMAIL=TrialVerse <noreply@yourdomain.com>   # or onboarding@resend.dev for a smoke test
   DEMO_OTP_ENABLED=false        # REQUIRED: demo mode cannot be combined with email delivery
   ```
   If email is enabled but a value is missing, the server refuses to start and names the missing variable.
5. **Start the backend**: `npm run dev` (the log shows `OTP delivery: email`).
6. **Test delivery** before involving participants: `npm run email:test -- you@example.org` sends one real email with the placeholder code `000000` and prints Resend's message id (or a readable reason for failure). With the free test sender, use the address you signed up to Resend with.
7. **End-to-end**: link a participant's portal account to their patient record (the participant registers, staff link them under *Patients → Edit → Portal account*), schedule a visit, open it as staff and click **Issue OTP**. The participant receives the email and enters the code on their visit page.

### Visits and OTP
`scheduled → otp_pending → verified → completed` (plus `missed` / `cancelled`). OTPs are random numeric codes from `crypto.randomInt`; only an **HMAC-SHA256 (keyed with `OTP_PEPPER`, bound to the OTP record id)** is stored, compared in constant time. Single-use, 5-minute expiry, 5 attempts then locked, at most one active OTP per visit (enforced by a partial unique index), max 5 issues/hour/visit, and a **60-second cooldown** between sends for the same visit. Every issue/verify/failure/lockout is audited — never including the code.

**Issuing (staff only) = deliver, then commit.** `POST /visits/:id/otp` (1) validates the visit state, that a delivery channel is configured, the cooldown, and that the participant's linked portal account exists and is active; (2) generates the code in memory and **emails it**; (3) only after Resend accepts the message, commits the OTP (previous one superseded, visit → `otp_pending`, audit `otp.issued` with channel and provider message id). If the email fails nothing is committed: no new OTP, the visit is unchanged, the previous code (if any) still works, the failure is audited as `otp.delivery_failed` (reason class only), the caller gets a generic `502 OTP_DELIVERY_FAILED`, and **a failed send does not start the cooldown**. Two simultaneous requests for one visit send exactly one email.

**What is never exposed:** the code is not in any API response (staff included), log line, audit record, error message or database column; the address is shown only masked (`a***@example.org`); provider errors and credentials never reach clients. Participants cannot issue or resend: only staff can, which keeps the code tied to on-site check-in.

### Tamper-evident audit chain
Append-only `audit_logs`; each event stores `prev_hash` and `hash = SHA-256(canonical JSON of seq, id, actor, action, entity, metadata, timestamp, prev_hash)`. Events are written **in the same transaction** as the business change. `GET /api/v1/audit/verify` recomputes the whole chain and reports modified events, deletions (sequence gaps and broken links) and tail truncation (via a head pointer); each verification attempt — pass or fail — is itself recorded. See [Architecture](docs/ARCHITECTURE.md#tamper-evident-audit-chain) for guarantees and limits.

> This is a **tamper-evident** log, not an immutable one. Someone with full database access can alter data; the chain makes that detectable by anyone who verifies it (and anchoring the head hash externally strengthens this).

### Risk and integrity engines
Two independent, rule-based baselines with configurable thresholds/weights, usable without ML. Both sit behind interfaces so ML models can replace or augment them with automatic fallback — see [ML integration](docs/ML_INTEGRATION.md).

## API additions (Phase 3)

All additive; no existing endpoint or field was removed or renamed. Full list in [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md).

| Area | Change | Roles |
|---|---|---|
| Staff directory | `GET /users/directory`: `id, fullName, role, isActive` for staff only; no email, no patient accounts; inactive staff hidden unless `includeInactive=true` | admin, coordinator, investigator |
| Account linking | `GET /patients/linkable-accounts` (active, unlinked patient accounts: `id, fullName, email, createdAt`); `POST /patients/:id/account` `{userId}`; `DELETE /patients/:id/account`. Validates role, active, no duplicate in either direction (409); audited as `patient.account_linked` / `patient.account_unlinked`. `PATCH /patients/:id` with `userId` now also rejects deactivated accounts | admin, coordinator |
| Visit history | `GET /visits/:id/history`: curated, read-only projection of the visit's audit events with actor names (no hashes, no raw metadata, never an OTP) | admin, coordinator, investigator (participants: 403) |
| Dashboard stats | `GET /stats/operations`, `/stats/visits`, `/stats/reimbursements`, `/stats/sponsor`: SQL aggregates (constant query count), zero-filled status maps; money grouped per currency; sponsor risk uses each entity's latest assessment | staff; `/stats/sponsor` admin + investigator |
| Embedded names | `patientName, patientCode, trialCode, trialTitle, siteName, verifiedByName` on visits; `patientName, trialCode, siteName` on enrollments; `principalInvestigatorName` on sites; `patientName, trialCode, requestedByName, reviewedByName` on reimbursements; `assigneeName, createdByName, patientName` on actions; `entityName` on risk assessments and alerts, `resolvedByName` on alerts; `actorName, actorRole` on audit events; `actorName` on status history; `portalAccountName` on patients | unchanged (same visibility as the parent resource) |

**Phase 4 changes to existing OTP endpoints** (see [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md)): `POST /visits/:id/otp` now delivers by email and returns a `delivery` object (`channel`, `status`, masked `recipientHint`, `cooldownSeconds`, `resendAvailableAt`) and never the code; new error codes `OTP_NO_RECIPIENT` (409), `OTP_COOLDOWN` (429, with `Retry-After`), `OTP_DELIVERY_FAILED` (502), `OTP_DELIVERY_UNAVAILABLE` (503); `GET /visits/:id/otp` adds `delivery`. `demoOtp` appears only in development demo mode. There are no schema changes.

Names are resolved with one batched `IN (...)` query per related table per response (no N+1). There are **no schema changes**.

## Testing

```bash
npm test
```

255 tests in 17 files run against in-memory SQLite (no external services): auth, RBAC, schema/constraints, patients & trials, visits, OTP generation/verification/expiry/reuse/lockout, audit hashing/verification/tamper detection/concurrency, reimbursements, actions, risk engine, integrity engine, ML contracts/fallback (against a real local HTTP model stub), API validation/errors/OpenAPI, seed, an end-to-end workflow, the Phase 3 additions (directory, account linking, embedded names, visit history, stats), and Phase 4 email OTP delivery (with a mocked provider, plus the real Resend SDK wrapper against a local stub server). **No test sends a real email.**

## Project layout

```
src/
  config/        env validation (zod), logger (pino, redacting)
  db/            connection, migration runner, migrations/*.sql
  middleware/    auth (JWT + RBAC), validate (zod), error handler
  modules/       one folder per domain: schemas · service (business logic) · routes (HTTP only)
    auth users patients trials(+sites,enrollments) visits(+otp) audit reimbursements actions risk integrity shared
  ml/            contracts (types + zod schemas), http model clients, gateway (fallback)
  docs/          OpenAPI registry → Swagger
  seed/          demo data seeder
  utils/         errors, http helpers, db helpers, crypto, state machine
tests/           vitest suites
docs/            architecture, schema, API, ML contract
```

## Known limitations (Phase 0)

- **Portal links survive patient deletion**: a soft-deleted patient keeps `user_id`, so that account cannot be linked to another patient record (the column is unique).
- **Staff directory / linkable accounts expose names** (and, for unlinked registrations, email) to coordinators by design; scope is limited to what the linking and assignment workflows need.

- **OTP delivery is email only** (Resend). There is no SMS channel, and if the participant has not linked/registered an account with an email, no code can be sent (`409 OTP_NO_RECIPIENT`). Deliverability (spam filtering, domain reputation) is outside the application's control; the 5-minute expiry assumes the email arrives promptly.
- **SQLite**: single-writer; excellent for development and modest deployments. The service layer uses plain SQL with no ORM; moving to PostgreSQL means porting `better-sqlite3` calls (sync → async) and the migrations. The audit append would then need a row lock/advisory lock on the head row.
- **No refresh tokens / logout / token revocation list**: tokens live `JWT_EXPIRES_IN` (default 8h); deactivating a user does revoke access immediately. No password reset or MFA flow.
- **Audit chain**: detects tampering but cannot prove who tampered or prevent it; head hash is not anchored to an external system. Verification is O(n) over the whole log.
- **Integrity scans are on-demand** (`POST /integrity/scans`), not scheduled. Overdue actions are computed at read time (no notifications).
- **Reimbursements** track amounts and payment status but do not integrate with a payment provider; no receipt uploads.
- **Rule engines** are heuristic baselines with illustrative default thresholds that need clinical/operational tuning.
- **Dependency advisory**: `npm audit` reports GHSA-mrhx-c7xc-m3w5 (high) in `zod@3` (memory use when validating very large constrained collections). Exposure is bounded by the 100 KB JSON body limit; the fix requires migrating to zod 4 (breaking API changes, and `zod-to-json-schema` would be replaced by zod's built-in JSON Schema export). Planned for Phase 1.
- Free-text fields are validated for length/type but not otherwise sanitised; clients must escape on render.
- PII (names, DOB, contact) is stored unencrypted at the application level; use disk/volume encryption and add field-level encryption if required by your compliance regime. Audit metadata deliberately excludes direct identifiers.
