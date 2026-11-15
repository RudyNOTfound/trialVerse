# TrialVerse

**A clinical-trial operations and integrity platform: participant dropout-risk prediction, data-integrity monitoring and a tamper-evident audit trail, in one app.**

> **Synthetic-data prototype.** All participants, sites, visits, ECGs and findings in the demo are fictional and synthetic. TrialVerse is **not** a validated clinical-trial fraud-detection system and **not** a clinical decision-support tool, and must not be used for decisions about real patients, sites or staff. Integrity findings are prompts for human review, never accusations.

(The repository, package and demo e-mail domain still use the earlier working name *TrialGuard*; the product is TrialVerse.)

## What it does

| Capability | Summary |
|---|---|
| **Three role-based workspaces** | *Site Operations* (`/app`: admin, coordinator, investigator), *Trial Oversight* (`/sponsor`: admin, investigator; the URL prefix is historical, there is no sponsor role) and the *Participant Portal* (`/me`: patients, mobile-first). |
| **Dropout-risk prediction** | A Python retention model (logistic regression) scores each participant 0–100 from distance to site, daily-wage work, missed reminders, reimbursement delay, side effects and more, with per-factor contributions and a plain-language explanation. |
| **Integrity monitoring** | A trial-wide scan combines audit-trail rules, per-site statistics (BP digit preference/variance, rapid or late-night entry, missing OTP), duplicate-ECG detection (perceptual hashing) and an unsupervised anomaly signal. Findings carry evidence and a suggested review action; trial findings are kept separate from platform-wide alerts. |
| **OTP-verified visits** | Staff issue a one-time code at check-in; the participant's code verifies attendance. Codes are HMAC-hashed, single-use, expiring and lock after repeated failures. |
| **Tamper-evident audit chain** | Every business event is hash-chained in the same transaction as the change; `GET /audit/verify` recomputes the whole chain. |
| **Reimbursements & actions** | Claim submission, review, approval and payment tracking; follow-up actions with status history. |
| **Safe degradation** | If the ML service is down, slow or returns an invalid answer, the backend falls back to its rule-based baseline engines and flags `fallback.used`. |

## Architecture

```
 React 19 + Vite (:5173)  ──►  TypeScript / Express API (:3000)  ──►  SQLite (better-sqlite3)
                                   │  auth · RBAC · OTP · audit chain · baseline engines · ML gateway + fallback
                                   ▼  HTTP/JSON, contract v1.1
                          Python FastAPI ML service (:8001)
                          retention model (pipeline.joblib) · integrity engine (rules · site stats · pHash · IsolationForest)
```

| Layer | Stack | Folder |
|---|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query | `frontend/` ([README](frontend/README.md)) |
| Backend | Node ≥ 20, TypeScript (strict), Express 4, SQLite, Zod, JWT, bcrypt, Vitest + Supertest | `src/` |
| ML service | Python, FastAPI, scikit-learn, pandas, SHAP, neurokit2, ImageHash | `ml-service/` ([README](ml-service/README.md)) |

More detail: [Architecture](docs/ARCHITECTURE.md) · [Database schema](docs/DATABASE.md) · [API endpoints](docs/API_ENDPOINTS.md) · [ML integration contract](docs/ML_INTEGRATION.md). API docs are served by the running backend at `/api/docs` (Swagger UI) and `/api/openapi.json`.

## Quick start: run the complete demo locally

Requirements: **Node ≥ 20** (developed on 22), **Python 3.9+** (tested on 3.12), and for `better-sqlite3` a prebuilt binary (included for common platforms). Install `node_modules` on the same OS you run them on (a Linux/WSL install cannot be run by Windows Node and vice versa).

**1. Install**

```bash
npm install                                   # backend
(cd frontend && npm install && cp .env.example .env)   # VITE_API_BASE_URL=http://localhost:3000/api/v1
python3 -m venv ml-service/.venv
ml-service/.venv/bin/pip install -r ml-service/requirements.txt
npm run setup                                 # creates .env with generated secrets (never overwrites an existing .env)
```

**2. Create and fill a database** (use a separate file for demos so your development DB is never touched)

```bash
export DATABASE_PATH=./data/trialverse-presentation.db
npm run migrate
npm run seed                 # base demo data (3 trials, 16 visits in every state, claims, audit chain …)
npm run ml:demo-import       # synthetic GLU-301 trial: 300 participants, 5 sites, 2,400 visits, 48 ECG references. Idempotent.
```

**3. Start the three services** (three terminals)

```bash
# ML service (working directory must be ml-service/)
cd ml-service && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# Backend: demo-mode overrides, set in the shell so .env is not edited
export CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
export OTP_EMAIL_ENABLED=false DEMO_OTP_ENABLED=true        # no real e-mail; code shown in the UI (dev only)
export ML_RISK_ENABLED=true  ML_RISK_URL=http://127.0.0.1:8001
export ML_INTEGRITY_ENABLED=true ML_INTEGRITY_URL=http://127.0.0.1:8001 ML_INTEGRITY_TIMEOUT_MS=30000
export ML_ECG_DIR=$PWD/ml-service/generated_data
npx tsx src/server.ts        # or: npm run dev

# Frontend
cd frontend && npm run dev -- --host 127.0.0.1 --port 5173
```

**4. Check health, then open <http://localhost:5173>**

```bash
curl -s localhost:8001/ready   # {"status":"ready","ready":true,"contractVersion":"1.1",…}
curl -s localhost:3000/health  # {"success":true,"data":{"status":"ok",…}}
```

Swagger UI: <http://localhost:3000/api/docs>.

**Data capture in the UI.** The staff patient page (`/app/patients/:id`) has measurement, ECG-reference, reminder and symptom panels; participants have *Records* (`/me/records`) to see their own data and report a symptom. ECGs are registered as a *reference* to a file under `ML_ECG_DIR`; there is no upload service.

### Demo accounts

Created by the seed. **Every account uses the password `DemoPass#2025`** (development only; the seeder refuses to run with `NODE_ENV=production`).

| Workspace | Account | Access |
|---|---|---|
| Admin | `admin@trialguard.demo` | Site Operations + Trial Oversight (risk, integrity, audit, statistics, user management) |
| Coordinator | `coordinator1@trialguard.demo` (also `coordinator2@`) | Site Operations only |
| Investigator | `investigator1@trialguard.demo` (also `investigator2@`) | Site Operations + Trial Oversight |
| Participant | `patient1@trialguard.demo` (Amelia Hartwell; also `patient2@`, `patient3@`) | Participant Portal, own records only |

### Demo scenarios

1. **Dropout risk: Ramesh Verma (P-A-001, trial GLU-301).** Log in as admin or investigator → *Trial Oversight → Participant risk* → choose GLU-301 → open Ramesh. The retention model returns **69.2 / 100, High**, driven by missed reminders (+10.5), reimbursement delay (+9.7), daily-wage work (+8.7), 40 km distance (+8.5) and reported side effects (+7.8), with the model name/version and an explanation. (Scores are created when assessed; use *Assess/Re-assess*.)
2. **Integrity: Site C.** *Trial Oversight → Integrity monitoring* → GLU-301 → *Run integrity scan*. On the shipped synthetic data the dashboard shows **44 open GLU-301 findings** with **SITE-C** flagged High (35 findings, including 6 duplicate-ECG clusters) while the other four sites stay Low, plus 11 separate *platform-wide* alerts from the audit trail. Open a finding for its evidence and suggested review action. Counts can differ slightly if scan windows or data change; the page always shows the live numbers.
3. **OTP verification.** The seed prints a visit with an active OTP whose code is `123456` (valid 30 days). As staff open *Site Operations → Visits →* that visit, enter the code and verify; the visit becomes `verified`. In demo mode (`DEMO_OTP_ENABLED=true`) a freshly issued code is shown to staff on screen; with e-mail delivery enabled it is never shown.
4. **Audit trail.** *Trial Oversight → Audit log* lists events such as `otp.issued`, `otp.verified`, `visit.verified`; *Verify chain* recomputes the hash chain and reports the result.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend with auto-reload (`tsx watch`) |
| `npm run build` / `npm start` | Compile to `dist/` (also copies SQL migrations) / run compiled server |
| `npm run migrate` | Apply pending SQL migrations (idempotent) |
| `npm run seed` / `npm run seed:reset` | Seed demo data into an empty DB / delete the DB file first, then seed |
| `npm run ml:demo-import` | Add the synthetic GLU-301 dataset (`--db <path>`, `--data <dir>` optional). Safe to repeat |
| `npm test` / `npm run typecheck` | Backend tests (in-memory DB, no services needed) / type check |
| `npm run docs:api` | Regenerate `docs/API_ENDPOINTS.md` from the OpenAPI registry |
| `npm run email:test -- you@example.org` | Send one real test e-mail through Resend |
| `cd frontend && npm run dev / build / test / typecheck` | Frontend dev server / production build / tests |
| `cd ml-service && python -m pytest` | ML service tests |

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


### Machine-learning integration

The backend talks to the ML service through a versioned contract (**v1.1**, `src/ml/contracts.ts`, [docs/ML_INTEGRATION.md](docs/ML_INTEGRATION.md)). Enable it with `ML_RISK_ENABLED`/`ML_RISK_URL` and `ML_INTEGRITY_ENABLED`/`ML_INTEGRITY_URL` (one process serves both, so both URLs can be `http://127.0.0.1:8001`). Any HTTP error, timeout, schema violation or version mismatch makes the backend fall back to its rule-based engine and record `fallback.used = true`; the result is never fabricated. `ml-service/README.md` documents the endpoints, thresholds and methodology.

* **Retention (dropout-risk) model:** logistic regression (`C=10`) trained on synthetic data. On the held-out synthetic test split: ROC-AUC 0.81, PR-AUC 0.68, Brier 0.138 (validation ROC-AUC 0.88). The engine's own category thresholds (0.18 / 0.39) are separate from the platform's score levels (25/50/75) and are never converted into each other. These figures describe **synthetic** data only and say nothing about real-world performance.
* **Integrity engine:** explainable rules, site-vs-site statistics, perceptual-hash ECG duplicate detection and an IsolationForest anomaly signal. There is no "fraud probability": nothing here is a calibrated fraud model.

## API additions

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
npm test                              # backend: 344 passed in 23 files (in-memory SQLite, no external services); tests/live is skipped unless the Python service is running (see its header)
(cd frontend && npm test && npm run typecheck && npm run build)   # frontend; live API test: frontend/src/test/live.test.ts
(cd ml-service && .venv/bin/python -m pytest)   # ML service: 451 passed, 1 failed at the last full run (see below)
```

Backend and ML counts are from a full run on 2026-11-15 (Python 3.12, WSL2); frontend counts change as tests are added, so run the command for current numbers. There is no lint script (`npm run typecheck` is the static check) and browser E2E tests are not automated. The single ML failure is `tests/retention/test_data_leakage.py::TestCommittedTrainingData::test_no_single_feature_determines_the_label`: a pandas string-dtype error (`Cannot perform reduction 'median' with string dtype`) in the test helper under this environment's pandas, not a failure of a product code path. The full ML suite takes several minutes on a Windows-mounted drive.

Beyond unit tests, the complete stack was exercised end to end for this submission: login for all four roles with the expected access matrix, the real backend → ML path (Ramesh 69.2 High with no fallback; integrity scan via `/v1/integrity/predict`), OTP issue + verify, audit-chain verification, and a headless-browser pass over every workspace at 1920×1080 with no console errors or failed API calls.

## Project layout

```
src/                  backend
  config/             env validation (zod), logger (pino, redacting)
  db/                 connection, migration runner, migrations/*.sql
  middleware/         auth (JWT + RBAC), validate (zod), error handler
  modules/            auth users patients trials(+sites,enrollments) visits(+otp) audit reimbursements actions risk integrity stats + capture (measurements, ECG references, reminders, adverse events)
  ml/                 contracts (types + zod), HTTP model clients, gateway (fallback)
  email/              provider interface + Resend implementation
  seed/               demo seeder and ML demo importer
scripts/              env setup, ML demo import, test e-mail, API-doc generator
frontend/             React app (see frontend/README.md)
ml-service/           FastAPI service, models/, generated_data/, reports/, tests/
tests/                backend vitest suites
docs/                 architecture, schema, API, ML contract
```

## Known limitations

This is a prototype built on **synthetic data**.

**Product and ML**
- Nothing is clinically validated. Model metrics are on synthetic data; risk factors are statistical associations, not causes; integrity findings are review prompts, not proof of misconduct.
- The stored risk assessment returns factors and an explanation; the retention engine's `recommendedActions` are not surfaced in the UI.
- The *Trial Oversight* workspace (risk dashboard, integrity, audit) is available to admin and investigator only; coordinators see Site Operations. (The API permits coordinators to read risk assessments; the UI does not expose the dashboard to them.)
- Integrity scans are on-demand, not scheduled; repeated scans are de-duplicated. Rule thresholds are illustrative and need clinical/operational tuning.
- The ML service must be started separately; without it everything still works on the rule-based baseline.
- The ML service's own README still contains an "Integration is not complete" note from before the v1.1 contract was wired; the current end-to-end behaviour is as described here.

- **Fallback is labelled, not hidden.** If the Python service is unreachable or times out, the backend answers with its rule-based baseline engine and sets `fallback.used = true` with a reason; the UI shows this as "No ML result". A baseline result is not a model prediction (for example, Ramesh scores 69.2 / high with the model but 0 / low from the baseline).
- **No ECG upload.** ECGs are registered as references to files under `ML_ECG_DIR`; captured records cannot be edited or deleted.

**Platform**
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
