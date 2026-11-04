# 3. Implementation checklists

Each side can implement independently from [01](01_CONTRACT_SPECIFICATION.md) and [02](02_FIELD_MAPPING_AND_OWNERSHIP.md).
Order matters only at the marked sync points. Nothing here has been implemented; no TypeScript file was touched.
Names, enums and types are fixed in 01 §3–§7, 02 §2.4 and [06](06_FINAL_DECISION_RECORD.md); do not rename them.

## PERSON A — backend, database, frontend

### A1. Decision gates (see [06](06_FINAL_DECISION_RECORD.md))
- [x] D1, D2, D3, D5, D6, D8, D9, D10 are final — implement as written.
- [ ] **Person A confirms before the named work starts:** D4 (24 h window, `visit_reminders` table vs counter fallback, who records outcomes → blocks A2 reminders + A3 reminders only) · D7 (`engine_extras` column → blocks A5 persistence only) · D11 (lawful basis for real data → blocks any non-synthetic use only).

### A2. Database migration `002_ml_inputs.sql` (new file; never edit `001_init.sql`)
- [ ] `trial_sites.timezone TEXT NULL` — **no default, no NOT NULL** (D2); app-level IANA validation
- [ ] `trial_sites.ml_site_category TEXT NULL` + `CREATE UNIQUE INDEX … ON trial_sites(trial_id, ml_site_category) WHERE ml_site_category IS NOT NULL`; **no CHECK on values** (D1)
- [ ] `enrollments.distance_to_site_km REAL CHECK (distance_to_site_km IS NULL OR (distance_to_site_km >= 0 AND distance_to_site_km <= 2000))`
- [ ] `patients.daily_wage_worker INTEGER CHECK (daily_wage_worker IN (0,1))` (nullable: unknown ≠ no)
- [ ] `visit_otp_exceptions(id, visit_id UNIQUE → visits, reason_code CHECK IN ('device_offline','participant_unreachable','otp_delivery_failed','coordinator_override','other'), note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500), recorded_by → users, recorded_at)` (D3)
- [ ] `visit_reminders(id, enrollment_id → enrollments, visit_id NULL → visits, channel CHECK IN ('sms','ivr','call','other'), sent_at, outcome CHECK IN ('sent','acknowledged','missed'), acknowledged_at NULL, outcome_recorded_at NULL, recorded_by, created_at)` (D4 — **A-CONFIRM**; fallback is nullable `enrollments.missed_reminders_count`)
- [ ] `adverse_event_reports(id, enrollment_id, visit_id NULL, reported_at, created_by, created_at)` — no free-text field is sent to ML
- [ ] `visit_measurements(visit_id PK→visits, performed_at, entered_at, systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl)` with CHECKs for **structural** validity only (`systolic_bp > 0`, etc.); implausible-but-possible values must remain storable so the integrity engine can flag them
- [ ] `visit_ecgs(id, visit_id, file_ref, file_sha256, recorded_at, created_at)` — `file_sha256` is a backend file-integrity record and is **not** sent to ML (D9); no `image_phash` column in v1.1
- [ ] `risk_assessments.engine_extras TEXT NULL` (JSON) — D7, **A-CONFIRM**, optional
- [ ] backfill/seed: extend `src/seed/seed.ts` so a demo database reproduces Ramesh and Site C: sites `SITE-A…SITE-E` with `ml_site_category` = same value and `timezone = 'Asia/Kolkata'`; enrollment `withdrawn` for Phase 3 dropouts (D6); Site C visits/ECGs; a documented OTP exception for the Phase 3 missing-OTP visits. Phase 3 CSVs are the reference; do not edit them.
- [ ] audit events for each new write (existing `appendAuditEvent`), so the hash chain covers the new data

### A3. Capture and validation
- [ ] `trials` routes: accept `timezone`, `mlSiteCategory` on site create/patch (01 §7); reject invalid IANA names with 422
- [ ] `PATCH /enrollments/:id` `distanceToSiteKm`; `PATCH /patients/:id` `dailyWageWorker`
- [ ] D3: `POST /visits/:id/status` accepts `otpException` per 01 §4.6 (roles `investigator`/`admin`; one transaction; supersede live OTP; audit `visit.completed_without_otp`; visit representation gains `otpVerified`, `otpException`); **do not touch `VISIT_TRANSITIONS`** — the exception is handled in the service before `assertTransition`, and without `otpException` the 409 stays
- [ ] reminders (entry route or seed; `missed` only after the deadline), adverse-event reports, visit measurements (+ `performed_at`), ECG upload
- [ ] measurements writable only for `verified|completed` visits; permissions per existing role model
- [ ] `performed_at` must carry an offset; `entered_at` is **server-set**, never accepted from the client (D8)

### A4. Feature extraction (`src/modules/risk/features.ts` + new `src/modules/integrity/trialData.ts`)
- [ ] `patientFeatures()` returns v1 keys **plus** the ten keys of spec §3; bump `FEATURE_SCHEMA_VERSION` to `"2"` for `entityType:'patient'` only (visit/reimbursement stay `"1"`)
- [ ] a participant with any **required** value unknown sends `null`/omits it — **never `0`, never an "average"**; unmapped site ⇒ `site_id: null`
- [ ] `buildScanRequest()` adds `trialData` (scope, sites, participants, visits, ecgs) with the caps in spec §4; omit sites with `timezone IS NULL` together with their participants/visits/ECGs and write `sitesSkippedNoTimezone` (array of site ids) into `integrity.scan_completed` metadata; skip `trialData` entirely when nothing remains
- [ ] `droppedOut` from `enrollments.status` (D6); `otpVerified` and `otpExceptionReason` per 01 §4.3
- [ ] bump `CONTRACT_VERSION` to `'1.1'` (`assertEnvelope` compares majors only)

### A5. ML client / gateway
- [ ] `contracts.ts`: add `trialData` types to `IntegrityScanRequest`; keep zod response schemas unchanged (additive response keys are ignored by default)
- [ ] no change to paths, `ML_*` env names, bearer header, `ML_TIMEOUT_MS`, `ResilientRiskEngine`/`ResilientIntegrityEngine`
- [ ] D10: do not change timeouts unless test T21 shows the 20k-visit scan exceeds the budget
- [ ] D7: if Person A approves the column, persist `{retentionRiskLevel, recommendedActions}` in `risk_assessments.engine_extras`; otherwise skip persistence
- [ ] update `docs/ML_INTEGRATION.md` and `contracts.ts` in one PR reviewed by both people (the document's own rule)

### A6. Frontend
- [ ] participant form: distance, wage status; site form: timezone + model category; visit form: measurements + performed time; ECG upload; reminder/adverse-event entry
- [ ] "Complete without OTP" flow: reason selector + required note, investigator/admin only
- [ ] risk panel: show score, backend level, "retention model category" next to it (D7), `factors`, fallback badge; `recommendedActions` when present
- [ ] integrity panel: group alerts by `details.category`; show `recommendedReviewAction`; wording "pattern for review", never "fraud"; show "N sites skipped (no timezone)" when `sitesSkippedNoTimezone` is non-empty
- [ ] state "synthetic prototype / not for clinical use" wherever model output is shown

### A7. Done when
- [ ] every test in [04](04_INTEGRATION_TEST_PLAN.md) marked **A** passes, and `npm test` (existing suites) is still green

## PERSON B — Python service  (implemented 2026-11-02; see [07](07_PERSON_B_IMPLEMENTATION_REPORT.md))

Legend: `[x]` done and covered by a Python test · `[ ]` open. Python side is complete; only the live end-to-end (X) tests are open.

### B1. Pydantic / request handling (`app/api/schemas.py`, `app/api/app.py`)
- [x] `IntegrityRequest`: add optional `trialData` with `SiteRef`, `ParticipantRef`, `TrialVisit`, `EcgRef` per spec §4 (camelCase aliases → existing internal snake_case dicts); keep `extra="ignore"`
- [x] widen visit `status` to the six backend values; apply rules only to `completed`
- [x] `SiteRef.timezone` required and validated with `zoneinfo` (IANA only); unknown/invalid/missing ⇒ 422. Convert `scheduledAt`, `performedAt`, `enteredAt` to site-local only for the night/window/rapid-entry rules; offset-less timestamps ⇒ `visit.invalid_timestamp`, never guessed
- [x] `ParticipantRef.droppedOut` **required**; on the contract path never derive it from visits (D6)
- [x] `TrialVisit.otpVerified` / `otpExceptionReason` (enum, nullable); `visit.missing_otp` stays LOW alone, escalates only with other signals; `otpExceptionReason` copied into `details`, never lowers severity (D3)
- [x] `ecgRecordId`-keyed clustering (reused images must produce clusters over distinct records); **no `imagePhash` field in v1.1** — Python alone hashes (D9); reject `..`/absolute `imageRef`
- [x] `/v1/integrity/predict` runs `scan_trial()` when `trialData` is present and merges `scan_contract()` findings; sort by severity; cap 1000; `entityId` is the backend id (site findings keyed by `siteId`)
- [x] `RiskResponse.contractVersion`: `"1.1"` (D13)
- [x] risk route: `scheduled_visits` **required** (D12, no default of 8); `site_id` required and ∈ known categories, else 422 `unsupported_feature_schema` (null/missing) / `unknown_site_category` (D1) — **this deliberately changes the existing test `test_risk_unknown_site_scores_with_warning_not_error` to expect 422**; it is the only intentional change to an existing Python test. `/v1/retention/predict` (native route) is unchanged
- [x] expose `knownSiteCategories` in `/ready` → `components.retention_model`
- [x] never fabricate: missing required ⇒ 422 with `missingFeatures`; partial `trialData` (e.g. a site without timezone) ⇒ 422, not a guess
- [x] request limits: 20000 visits, 5000 participants, 2000 ECGs, 200 sites; body ≤ `ML_MAX_BODY_BYTES` (raise to ~25 MB if the 20k cap is used)

### B2. Response compatibility
- [x] keep `confidence` omitted (never null); omit `score` when absent; findings must satisfy `integrityFindingSchema` (ruleId ≤ 100, message ≤ 1000, severity enum, dedupeKey ≤ 200)
- [x] a JSON-schema/zod parity test using the backend's own classes (see 04, test X1)

### B3. Batch inference
- [x] N/A — **not in v1.1** (D10). A `POST /v1/risk/predict-batch` would be a new path in a later version.

### B4. Tests and tooling
- [x] unit/API tests for every row of [04](04_INTEGRATION_TEST_PLAN.md) marked **B**
- [x] a golden request generator that converts Phase 3 CSVs into `trialData` JSON (test fixture only; Phase 3 files remain read-only)
- [x] keep all 233 existing Python tests passing except the one intentional change above; do not retrain or modify Phase 3/4 artifacts

### B5. Done when
- [ ] the shared tests (marked **X**) pass against a live backend + live Python service — **BLOCKED on Person A** (see [07](07_PERSON_B_IMPLEMENTATION_REPORT.md) §6). `docs/phase6` is updated with what was learned: done.
