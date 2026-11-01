# TrialGuard — Backend (Phase 0)

Clinical trial management and integrity platform. This repository contains the **Phase 0 backend foundation**: REST API, relational data model, authentication/RBAC, OTP-verified visits, a tamper-evident audit chain, reimbursements, actions, baseline risk/integrity engines, and the integration contracts for separately-developed ML models.

No frontend and no ML models are included by design.

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
| OTP | `OTP_PEPPER`, `OTP_LENGTH`, `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `DEMO_OTP_ENABLED` |
| ML | `ML_RISK_ENABLED/URL`, `ML_INTEGRITY_ENABLED/URL`, `ML_TIMEOUT_MS`, `ML_API_KEY` |
| Rules | `RISK_RULES_OVERRIDES`, `INTEGRITY_RULES_OVERRIDES` (JSON merged over defaults) |

### Development vs production

| | development | production |
|---|---|---|
| OTP visibility | `DEMO_OTP_ENABLED=true`: issue response includes `demoOtp`; `GET /api/v1/dev/visits/:id/otp` exists | **App refuses to start** if `DEMO_OTP_ENABLED=true`. Route is not mounted; OTPs are never returned |
| CORS | listed origins | `*` rejected at startup |
| Proxy | – | `trust proxy` enabled (so rate limiting sees client IPs) — put it behind a TLS-terminating proxy |
| Seeding | allowed | refused |

Production checklist: strong unique secrets from a secret manager, `NODE_ENV=production`, `DEMO_OTP_ENABLED=false`, explicit `CORS_ORIGINS`, persistent volume for `DATABASE_PATH`, regular DB backups, and an out-of-band OTP delivery channel (see limitations).

## How the main features work

### Authentication & roles
JWT (HS256) bearer tokens; passwords hashed with bcrypt. The user is **re-loaded from the database on every request**, so deactivation and role changes apply immediately. `POST /auth/register` always creates a `patient` account (no self-service privilege escalation); admins create staff via `POST /users`. Auth endpoints are rate limited.

Roles: `admin`, `coordinator`, `investigator`, `patient`. Authorization is enforced in route middleware and in services (patients are scoped server-side to their own records — client-supplied filters cannot widen that). The per-endpoint role matrix is in [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md).

### Visits and OTP
`scheduled → otp_pending → verified → completed` (plus `missed` / `cancelled`). OTPs are random numeric codes from `crypto.randomInt`; only an **HMAC-SHA256 (keyed with `OTP_PEPPER`, bound to the OTP record id)** is stored, compared in constant time. Single-use, 5-minute expiry, 5 attempts then locked, at most one active OTP per visit (enforced by a partial unique index), max 5 issues/hour/visit. Every issue/verify/failure/lockout is audited — never including the code.

### Tamper-evident audit chain
Append-only `audit_logs`; each event stores `prev_hash` and `hash = SHA-256(canonical JSON of seq, id, actor, action, entity, metadata, timestamp, prev_hash)`. Events are written **in the same transaction** as the business change. `GET /api/v1/audit/verify` recomputes the whole chain and reports modified events, deletions (sequence gaps and broken links) and tail truncation (via a head pointer); each verification attempt — pass or fail — is itself recorded. See [Architecture](docs/ARCHITECTURE.md#tamper-evident-audit-chain) for guarantees and limits.

> This is a **tamper-evident** log, not an immutable one. Someone with full database access can alter data; the chain makes that detectable by anyone who verifies it (and anchoring the head hash externally strengthens this).

### Risk and integrity engines
Two independent, rule-based baselines with configurable thresholds/weights, usable without ML. Both sit behind interfaces so ML models can replace or augment them with automatic fallback — see [ML integration](docs/ML_INTEGRATION.md).

## Testing

```bash
npm test
```

176 tests in 14 files run against in-memory SQLite (no external services): auth, RBAC, schema/constraints, patients & trials, visits, OTP generation/verification/expiry/reuse/lockout, audit hashing/verification/tamper detection/concurrency, reimbursements, actions, risk engine, integrity engine, ML contracts/fallback (against a real local HTTP model stub), API validation/errors/OpenAPI, seed, and an end-to-end workflow.

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

- **OTP delivery**: OTPs are generated and verified but not sent (no SMS/email provider). In production nothing returns the code, so a delivery integration is required in Phase 1.
- **SQLite**: single-writer; excellent for development and modest deployments. The service layer uses plain SQL with no ORM; moving to PostgreSQL means porting `better-sqlite3` calls (sync → async) and the migrations. The audit append would then need a row lock/advisory lock on the head row.
- **No refresh tokens / logout / token revocation list**: tokens live `JWT_EXPIRES_IN` (default 8h); deactivating a user does revoke access immediately. No password reset or MFA flow.
- **Audit chain**: detects tampering but cannot prove who tampered or prevent it; head hash is not anchored to an external system. Verification is O(n) over the whole log.
- **Integrity scans are on-demand** (`POST /integrity/scans`), not scheduled. Overdue actions are computed at read time (no notifications).
- **Reimbursements** track amounts and payment status but do not integrate with a payment provider; no receipt uploads.
- **Rule engines** are heuristic baselines with illustrative default thresholds that need clinical/operational tuning.
- **Dependency advisory**: `npm audit` reports GHSA-mrhx-c7xc-m3w5 (high) in `zod@3` (memory use when validating very large constrained collections). Exposure is bounded by the 100 KB JSON body limit; the fix requires migrating to zod 4 (breaking API changes, and `zod-to-json-schema` would be replaced by zod's built-in JSON Schema export). Planned for Phase 1.
- Free-text fields are validated for length/type but not otherwise sanitised; clients must escape on render.
- PII (names, DOB, contact) is stored unencrypted at the application level; use disk/volume encryption and add field-level encryption if required by your compliance regime. Audit metadata deliberately excludes direct identifiers.
