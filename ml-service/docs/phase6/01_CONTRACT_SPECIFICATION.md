# 1. Final contract specification — v1.1

**Status:** final for implementation. Decisions D1–D13 are recorded in [06](06_FINAL_DECISION_RECORD.md). Three items marked **[A-confirm]** (D4 reminder window/table, D7 `engine_extras` column, D11 real-data basis) still need Person A and block only the work they name. Specification only. No TypeScript, Python, database, Phase 3 or Phase 4 file was changed to produce it.
Verified against: `ml-service/CONTRACT_EXTENSION_PROPOSAL.md`, `docs/ML_INTEGRATION.md`, `src/ml/contracts.ts`,
`src/ml/httpModels.ts`, `src/ml/gateway.ts`, `src/config/env.ts`, `src/db/migrations/001_init.sql`,
`src/modules/{risk,integrity,visits,patients,audit}`, and the Python code (`app/retention/schemas.py`,
`app/api/schemas.py`, `app/integrity/*`).

Companion documents: [02 mapping & ownership](02_FIELD_MAPPING_AND_OWNERSHIP.md) ·
[03 checklists](03_IMPLEMENTATION_CHECKLISTS.md) · [04 test plan](04_INTEGRATION_TEST_PLAN.md) ·
[05 decision register](05_UNRESOLVED_DECISIONS.md) · [06 final decision record](06_FINAL_DECISION_RECORD.md).

## 0. Principles and versioning

* `CONTRACT_VERSION` moves **1.0 → 1.1** (MINOR: additive only). `FEATURE_SCHEMA_VERSION` for patient risk requests moves
  **"1" → "2"**. The Python service already accepts any 1.x contract version; the backend already accepts any 1.x response.
* **Endpoint paths, bearer auth, `requestId` echo, `ML_TIMEOUT_MS`, the fallback kinds and the response envelopes do not change.**
* Everything new is **optional at the envelope level** (old backends keep working; old Python builds ignore unknown fields).
* **A missing required input is never defaulted.** The backend sends `null`/omits it; Python answers HTTP 422; the backend
  falls back to baseline (`fallback.reason = "model_error: … HTTP 422"`). The same applies to the integrity extension: absent
  `trialData` ⇒ only audit rules run (today's behaviour), not a fabricated scan.
* JSON is camelCase at the envelope (as in `contracts.ts`). Feature-map **keys** keep the names already used by the Python model
  (`snake_case`) because `features` is an open flat map in v1.0 and the names are the model's own column names.
* **Type conventions (one rule, used everywhere):** inside the `features` map the model's binary inputs are integers `0|1` (the Python validator also accepts JSON booleans). Everywhere else (`trialData`, finding `details`) flags are JSON booleans `true|false|null`. All timestamps are ISO-8601 with `Z` or an explicit offset; the backend keeps storing UTC.
* Identifiers sent to Python are the backend's opaque UUIDs. No names, e-mail, phone number, date of birth or free text are sent.

## 2. What the real code requires (verification summary)

| Check | Result |
|---|---|
| Retention model inputs (`MODEL_FEATURES`) | 9: `age`, `distance_km`, `missed_reminders`, `reimbursement_delay_days`, `visits_missed`, `daily_wage_worker`, `side_effects_reported`, `phone_changed`, `site_id`. Plus `scheduled_visits` (validation only, **Python defaults it to 8 when absent**). `age` and `reimbursement_delay_days` may be null. |
| Backend `patients` / `visits` columns for these | **Only `age` (from `date_of_birth`), `visits_missed` (from `visits.status='missed'`), `scheduled_visits`, `site_id` (from `trial_sites`) and `phone_changed` (from audit `patient.updated` with `changedFields` ∋ `phone`) are derivable today.** `distance_km`, `daily_wage_worker`, `missed_reminders`, `side_effects_reported` have no source; `reimbursement_delay_days` is derivable from `reimbursements.created_at` / `paid_at`. |
| Backend visit columns vs Python `TrialVisit` | `scheduled_at`, `status`, `verified_at`, `completed_at` exist. **No** actual-visit-time, BP/HR/weight/glucose, ECG, or "entered at" distinct from `completed_at`. |
| Backend visit statuses vs Python `TrialVisit.status` | Backend: `scheduled, otp_pending, verified, completed, missed, cancelled`. Python accepts only `completed, missed, scheduled, cancelled` ⇒ `verified`/`otp_pending` would 422 today. |
| OTP semantics | Today `VISIT_TRANSITIONS` forbids `completed` without `verified`, so `otp_verified=false` cannot occur. **Resolved (D3):** completion is separated from OTP verification through an audited exception (§4.6). |
| Timezones | `isoDate` accepts offsets; `scheduled_at` may be UTC (`Z`). `trial_sites` has no timezone. **Resolved (D2):** nullable IANA `trial_sites.timezone`, no default; Python converts to site-local time only for local-time rules; a missing timezone is never assumed. |
| Site identity | Retention model knows only `SITE-A…SITE-E`; backend site ids are UUIDs. **Resolved (D1):** an explicit per-site mapping column `trial_sites.ml_site_category`; demo sites map to `SITE-A…SITE-E`; no production-wide restriction. |
| `entityType` for risk | Retention applies to `patient` only. `visit` and `reimbursement` stay on baseline (Python 422 `unsupported_entity_type` ⇒ fallback). |

## 3. A. Participant-level retention features (`POST /v1/risk/predict`, `entityType: "patient"`, `featureSchemaVersion: "2"`)

`features` = the existing v1 patient features (**keep sending them**: the baseline engine's rules read them) **plus** the
fields below. Python ignores keys it does not know. The dropout model never sees the v1 keys.

| Name | Type | Req. | Constraints (as enforced by Python) | Backend source | Python destination | PII? |
|---|---|---|---|---|---|---|
| `site_id` | string | **required** | Must be one of the model's known site categories (Python lists them in `/ready` → `components.retention_model.knownSiteCategories`; today `SITE-A…SITE-E`). Unmapped (`null`/omitted) ⇒ 422 `unsupported_feature_schema` with `details.missingFeatures:["site_id"]` (same code as every other missing required feature); unknown category ⇒ 422 `unknown_site_category` with `details.{siteId, knownSiteCategories}`. **Never scored without a site effect on the contract route** | `trial_sites.ml_site_category` of the participant's enrollment site (explicit mapping, D1) | `ParticipantFeatures.site_id` | No |
| `age` | number\|null | optional | 0–120 | derived: whole years from `patients.date_of_birth` at `requestedAt` (DOB is **not** sent) | `age` | Quasi-identifier (integer only) |
| `distance_km` | number | **required** | 0–2000, finite | **NEW** `enrollments.distance_to_site_km` | `distance_km` | Location-derived; coarse distance only, no address |
| `daily_wage_worker` | 0/1 (bool accepted) | **required** | 0 or 1; numeric strings rejected | **NEW** `patients.daily_wage_worker` | `daily_wage_worker` | Socio-economic attribute (sensitive) |
| `scheduled_visits` | integer | **required in v1.1** | 1–100 | derived: `COUNT(visits)` of the enrollment with `status != 'cancelled'` | `scheduled_visits` (used only to validate `visits_missed ≤ scheduled_visits`) | No |
| `missed_reminders` | integer\|null | **required** (null ⇒ 422 ⇒ baseline) | 0–100 | **NEW** `visit_reminders` (D4): `COUNT(outcome='missed')` for the enrollment **if** it has ≥ 1 reminder with a resolved outcome (`acknowledged` or `missed`); otherwise `null` — never `0` | `missed_reminders` | No |
| `reimbursement_delay_days` | number\|null | optional | 0–730 | derived: mean of `(paid_at − created_at)` in days over the participant's **paid** claims; `null` if none (D5, final) | `reimbursement_delay_days` | No |
| `side_effects_reported` | 0/1 | **required** | 0 or 1 | **NEW** `adverse_event_reports` (any report on the enrollment) | `side_effects_reported` | Health data (sensitive) |
| `phone_changed` | 0/1 | **required** | 0 or 1 | derived: any audit event `patient.updated` for this patient with `'phone' ∈ metadata.changedFields` since enrollment — **no phone number leaves the backend** | `phone_changed` | No (flag only) |
| `visits_missed` | integer | **required** | 0–100, ≤ `scheduled_visits` | derived: `COUNT(visits WHERE status='missed' AND scheduled_at ≤ requestedAt)` for the enrollment | `visits_missed` | No |

Request-level fields unchanged: `contractVersion`, `requestId`, `entityType`, `entityId` (= `patients.id`), `featureSchemaVersion`,
`features`, `requestedAt`. `entityId` is echoed to the engine as `participant_id` and never used as a feature.
Unknown extra keys such as `dropped_out` must **not** be sent (the native route rejects them; the contract route ignores them).

**Response (unchanged shape).** `RiskPredictionResponse` exactly as in `contracts.ts`; `confidence` is omitted (never `null` — zod
`.optional()` rejects null). Additive, ignored by today's backend and available to the frontend if Person A chooses to persist
them: `retentionRiskLevel` (`low|medium|high`, validation-selected thresholds 0.18/0.39), `recommendedActions[]`
(`action_type, title, reason, priority`). `factors[]` = risk-increasing first (positive `contribution`, in score points), then protective (negative).

**Backend level mapping (D7).** The backend keeps deriving `level` from `score` (25/50/75 → low/medium/high/critical) and does **not** relabel.
The engine's own category (`retentionRiskLevel`, thresholds 0.18/0.39) is stored next to it, labelled "retention model category" in the UI (example: score 40 ⇒ backend `medium`, engine `high`).
Storage (D7): one nullable JSON column `risk_assessments.engine_extras` holding `{ "retentionRiskLevel", "recommendedActions" }` **[A-confirm]**. If Person A declines the column, the extras are shown from the live response only; nothing else in this contract changes.

**Definitions fixed by this spec.**
* *Missed reminder* (D4): a `visit_reminders` row whose `outcome` was recorded as `missed` — the reminder was `sent` and not `acknowledged` within `REMINDER_ACK_DEADLINE_HOURS` (backend config, default **24**, **[A-confirm]** that this equals the Phase 3 meaning). A `missed` outcome may only be recorded once `sent_at + deadline` has passed. The outcome is written explicitly (coordinator action or ingestion job), never computed at read time, so a feature value is reproducible from the log.
* *No reminder data* ⇒ `missed_reminders = null`, never `0`. A participant without any resolved reminder therefore falls back to baseline.
* *Reimbursement delay* (D5): mean `(paid_at − created_at)` in days over `payment_status='paid'` claims; `null` if none.
* *Visits missed*: `visits.status='missed'` with `scheduled_at ≤ requestedAt`, same enrollment; *scheduled visits*: non-cancelled visits of the enrollment.

**Errors (all lead to baseline fallback).** 400 unsupported contract major · 401 bad token · 413 too large · 422 missing/invalid
feature (`error.details.missingFeatures` or per-field messages) · 500 · 503 model not loaded · 504 deadline.

## 4. B. Visit-level integrity features (`POST /v1/integrity/predict`)

Extension of `IntegrityScanRequest` with **four optional top-level keys**. Old backends omit them (⇒ audit rules only, as today);
old Python builds ignore them. When `trialData` is present Python additionally runs the visit rules, site statistics, ECG
duplicate detection and the anomaly signal. All findings still use the existing `integrityFindingSchema`.

```
IntegrityScanRequest (existing fields unchanged: contractVersion, requestId, windowStart, windowEnd,
                      events[], reimbursements[], openVisits[], chain)
  + trialData?: {
      scope:        { trialId: string, asOf: string(ISO instant) }
      sites:        [SiteRef]            // ≤ 200
      participants: [ParticipantRef]     // ≤ 5000
      visits:       [TrialVisit]         // ≤ 20000
      ecgs?:        [EcgRef]             // ≤ 2000
    }
```

`visits` are **not limited to the scan window**: the site statistics need history (≥ 60 completed visits per site and ≥ 20
participants, otherwise Python reports `site.insufficient_data` and skips tests). `events`/`openVisits` keep their windowed meaning.

### 4.1 `SiteRef`

| Name | Type | Req. | Constraints | Backend source | Python destination | PII? |
|---|---|---|---|---|---|---|
| `siteId` | string | required | non-empty ≤ 100 | `trial_sites.id` | `site_id` (also the `entityId` of site findings) | No |
| `siteCode` | string | required | ≤ 64 | `trial_sites.site_code` | display only (`details.siteCode`) | No |
| `timezone` | string (IANA) | required, non-null | canonical IANA name, e.g. `Asia/Kolkata`. Offsets (`+05:30`), abbreviations (`IST`), empty or unknown names ⇒ 422 for the whole call | **NEW** `trial_sites.timezone` (nullable, no default; D2). The backend **omits** sites with a null timezone (and their visits/participants/ECGs) from `trialData` and records `sitesSkippedNoTimezone` in the `integrity.scan_completed` audit metadata | converts timestamps to site-local time for the night-entry, visit-window and rapid-entry-hour rules only | No |

### 4.2 `ParticipantRef`

| Name | Type | Req. | Constraints | Backend source | Python destination | PII? |
|---|---|---|---|---|---|---|
| `participantId` | string | required | non-empty ≤ 100 | `patients.id` | `participant_id` | Pseudonymous id |
| `siteId` | string | required | must exist in `sites[]` | enrollment `trial_site_id` | `site_id` | No |
| `droppedOut` | boolean | **required** | `true` iff the enrollment `status = 'withdrawn'`; `false` for `enrolled` and `completed`. Participants whose enrollment is `screening` or `screen_failed` are **not sent** (D6) | `enrollments.status` | `dropped_out` (site retention statistic). Python never derives it from visits on this path; participants not sent are not counted | No |

### 4.3 `TrialVisit`

| Name | Type | Req. | Constraints | Backend source | Python destination | PII? |
|---|---|---|---|---|---|---|
| `visitId` | string | required | unique within request | `visits.id` | `visit_id` (entityId of visit findings) | Pseudonymous id |
| `participantId` | string | required | in `participants[]` | `visits.patient_id` | `participant_id` | Pseudonymous id |
| `siteId` | string | required | in `sites[]` | `visits.trial_site_id` | `site_id` | No |
| `visitNumber` | integer | required | 1–100; order within enrollment | derived: `ROW_NUMBER()` by `scheduled_at` per enrollment | `visit_number` | No |
| `visitType` | string | optional | ≤ 60 | `visits.visit_type` | `visit_type` | No |
| `status` | enum | required | exactly the backend's six values: `scheduled, otp_pending, verified, completed, missed, cancelled` (unchanged by this spec; Python must widen its literal — B-checklist) | `visits.status` | `status`; only `completed` visits are rule-checked | No |
| `scheduledAt` | ISO instant | required | `Z` or offset | `visits.scheduled_at` | converted to site-local `scheduled_date` | No |
| `performedAt` | ISO instant\|null | required if `completed` | must carry an offset or `Z`; offset-less ⇒ treated as **invalid timestamp finding**, not guessed | **NEW** `visit_measurements.performed_at` (captured on the device at the visit) | `device_timestamp` | No |
| `enteredAt` | ISO instant\|null | required if `completed` | same | **NEW** `visit_measurements.entered_at` = server time the measurements were saved (not `completed_at`; D8) | `entry_timestamp` | No |
| `otpVerified` | boolean\|null | required if `completed`, else `null` | | derived: `visits.verified_at IS NOT NULL`. A visit completed through the exception path (§4.6) has `verified_at = NULL` ⇒ `false` | `otp_verified` (0/1 internally) | No |
| `otpExceptionReason` | enum\|null | optional | `device_offline, participant_unreachable, otp_delivery_failed, coordinator_override, other`; non-null only when `otpVerified=false` | **NEW** `visit_otp_exceptions.reason_code` (free-text note is **not** sent) | `details.otpExceptionReason` on missing-OTP findings; never lowers severity | No |
| `systolicBp` | number\|null | optional | mmHg; plausible 70–250 (outside ⇒ data-quality finding, **not** rejected) | **NEW** `visit_measurements.systolic_bp` | `systolic_bp` | Health data |
| `diastolicBp` | number\|null | optional | 40–150, < systolic | **NEW** `…diastolic_bp` | `diastolic_bp` | Health data |
| `heartRate` | number\|null | optional | bpm 30–220 | **NEW** `…heart_rate` | `heart_rate` | Health data |
| `weightKg` | number\|null | optional | 25–250 | **NEW** `…weight_kg` | `weight_kg` | Health data |
| `glucoseMgDl` | number\|null | optional | 30–600 | **NEW** `…glucose_mg_dl` | `glucose_mg_dl` | Health data |
| `ecgRecordId` | string\|null | optional | unique per capture; must appear in `ecgs[]` when non-null | **NEW** `visit_ecgs.id` | `ecg_id` link | No |

"Impossible/implausible" values are **accepted and reported** (`visit.implausible_measurement`) — they are findings, not
request errors. Structurally wrong values (strings in numeric fields, non-ISO timestamps) are 422.

### 4.4 `EcgRef`

| Name | Type | Req. | Constraints | Backend source | Python destination | PII? |
|---|---|---|---|---|---|---|
| `ecgRecordId` | string | required | unique | `visit_ecgs.id` | `ecg_id` | No |
| `visitId` / `participantId` / `siteId` | string | required | as above | via `visit_ecgs.visit_id` | `visit_id`, `participant_id`, `site_id` | pseudonymous |
| `imageRef` | string | required | path **relative to `ML_ECG_DIR`**; `..`/absolute paths rejected | **NEW** `visit_ecgs.file_ref` (shared directory, D9) | `image_file` | ECG waveform is health data |

There is **no** client-supplied hash field in v1.1: a perceptual hash is only comparable if computed by the same algorithm, so Python alone hashes (D9). A missing/unreadable file yields `ecg.file_unavailable` (MEDIUM, data-quality); the scan continues.
Phase 3 note: reused images share one `ecg_id` across visits, so Python must key clusters on `(ecgRecordId)` — one record per capture — not on image id.

### 4.5 Response (unchanged envelope)

`IntegrityScanResponse` unchanged. Each finding already satisfies `integrityFindingSchema`:

| Finding field | Rule |
|---|---|
| `ruleId` | `ml.*` (audit) or `visit.*`, `site.*`, `ecg.*` (trial data) |
| `entityType` / `entityId` | `visit`→`visits.id`; `site`→`trial_sites.id`; `ecg_cluster`→synthetic `ecg-cluster-<12 hex>`; `audit_chain`→`main`; `user`/`patient`/`reimbursement` as today |
| `severity` | `low|medium|high|critical` |
| `score` | optional 0–1; omitted (not null) when not applicable |
| `details` | rule evidence **plus** `category` (`technical_violation|suspicious_pattern|data_quality`), `recommendedReviewAction`, `siteId` |
| `dedupeKey` | stable per occurrence (visit id, site id, cluster hash, rapid-entry start time) |

No `fraud_probability`. Findings are capped at 1000 (most severe first). The backend maps each finding to an `integrity_alerts` row
unchanged (`source` = `modelName`, `fingerprint` = hash(modelName, ruleId, entityType, entityId, dedupeKey)).

### 4.6 Visit completion versus OTP verification (D3)

* `visits.status` keeps its six values and the normal flow `scheduled → otp_pending → verified → completed` is unchanged. **No column is added to `visits`.**
* **Exception path** — the existing route `POST /api/v1/visits/:id/status` accepts one new optional body key:

```json
{ "status": "completed", "otpException": { "reasonCode": "device_offline", "note": "Tablet had no signal; OTP SMS not delivered." } }
```

| Rule | Behaviour |
|---|---|
| `reasonCode` | enum `device_offline, participant_unreachable, otp_delivery_failed, coordinator_override, other` |
| `note` | required, 1–500 chars; stays in the database, **never** sent to ML or written to the hash-chained audit metadata |
| Allowed from | `scheduled` or `otp_pending`, **only** with `otpException`. Without it the existing 409 `INVALID_STATE_TRANSITION` is unchanged |
| Not applicable | `otpException` with any `status` other than `completed`, or on a visit already `verified` ⇒ 422 `OTP_EXCEPTION_NOT_APPLICABLE` |
| Roles | `investigator`, `admin` — exactly the roles that may complete a visit today (a coordinator gets the existing 403) |
| One transaction | insert `visit_otp_exceptions(visit_id UNIQUE, reason_code, note, recorded_by, recorded_at)`; set `status='completed'`, `completed_at`; leave `verified_at = NULL`; mark any `active` OTP record `superseded`; append audit event `visit.completed_without_otp` with `metadata {patientId, trialId, reasonCode, from}` |
| Visit representation (backend API) | gains `otpVerified: boolean` (= `verified_at != null`) and `otpException: { reasonCode, recordedBy, recordedAt } \| null` (no `note` unless the caller is `investigator`/`admin`) |

* Effect on ML: `otpVerified=false`, `otpExceptionReason` set. A missing OTP is an **integrity signal requiring review, not proof of fraud**: `visit.missing_otp` is LOW on its own and escalates only when combined with other signals; `site.missing_otp_rate` counts every such visit, documented or not. A documented exception is never auto-dismissed.
* Imported/legacy completed visits with no `visit_otp_exceptions` row and `verified_at IS NULL` are also sent as `otpVerified=false` with `otpExceptionReason=null` (undocumented — higher review priority than a documented one, still not fraud).

## 5. Audit information (existing, unchanged)

`events[]`, `reimbursements[]`, `openVisits[]` and `chain` keep their v1.0 shape and limits (5000 / 2000 / 2000). **Hash-chain
re-verification stays in the backend** (events do not carry `prevHash`/`hash`; adding them is optional proposal item 3 and is
**not** part of v1.1). The `seq` continuity check in Python remains.

## 6. Backward compatibility matrix

| Backend | Python | Behaviour |
|---|---|---|
| v1.0 (no new fields, schema "1") | v1.1 | risk ⇒ 422 → baseline; integrity ⇒ audit rules only. **Identical to today.** |
| v1.1, participant incomplete | v1.1 | risk ⇒ 422 → baseline for that participant only |
| v1.1 | old Python (5.0.0) | risk ⇒ works; extra integrity keys ignored ⇒ audit rules only |
| v1.1 with `trialData` containing a site whose `timezone` is null/invalid | v1.1 | 422 on the integrity call ⇒ baseline integrity (never guess local time). The backend normally prevents this by omitting such sites |

## 7. Backend REST changes that feed the contract (non-ML endpoints, all under `/api/v1`)

Existing roles apply unless stated. Bodies are camelCase; DB columns snake_case. Every write appends the usual audit event.

| Endpoint | New/changed body field | Type & constraint | DB column (migration `002_ml_inputs.sql`) |
|---|---|---|---|
| `POST /trials/:id/sites`, `PATCH /trials/:id/sites/:siteId` | `timezone` | IANA name validated with `Intl.DateTimeFormat`; `null` allowed (clears); **no default** | `trial_sites.timezone TEXT NULL` |
| same | `mlSiteCategory` | string ≤ 64 or `null`; no value whitelist; unique per trial when non-null | `trial_sites.ml_site_category TEXT NULL` |
| `PATCH /enrollments/:id` | `distanceToSiteKm` | number 0–2000 or `null` | `enrollments.distance_to_site_km REAL NULL` |
| `PATCH /patients/:id` | `dailyWageWorker` | boolean or `null` (unknown ≠ false); stored 0/1 | `patients.daily_wage_worker INTEGER NULL` |
| `POST /visits/:id/status` | `otpException` | see §4.6 | `visit_otp_exceptions` |

Other new capture endpoints (reminders, adverse-event reports, measurements, ECG upload) are specified by the tables in [03](03_IMPLEMENTATION_CHECKLISTS.md) A2/A3; their stored fields and the ML names they map to are fixed in [02](02_FIELD_MAPPING_AND_OWNERSHIP.md) §2.4.
