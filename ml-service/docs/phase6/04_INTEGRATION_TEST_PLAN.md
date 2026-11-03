# 4. Integration test plan

Legend: **A** = backend-owned, **B** = Python-owned, **X** = end-to-end (needs both running). Fixtures derive from the Phase 3
CSVs (read-only) or from small hand-built payloads. No test may use the network beyond `localhost`.

## 4.1 Contract and payload tests

| # | Scenario | Setup | Expected | Owner |
|---|---|---|---|---|
| T1 | Complete retention payload | Ramesh features (spec §3), schema `"2"` | 200; `score` equals `RetentionPredictor.predict(...)` (≈69.2 for Ramesh with the backend-derived 11.6-day reimbursement delay; 70.01 if the Phase 3 CSV's rounded 12 days is sent); `factors` non-empty; level `high` | B, X |
| T2 | Missing required retention feature | each required key removed in turn (`distance_km`, `site_id`, …) | 422 `unsupported_feature_schema`, `missingFeatures` lists exactly the removed key; backend stores baseline with `fallback.used=true`, reason contains `422` | B, X |
| T3 | Missing optional values | `age=null`, `reimbursement_delay_days` omitted | 200; score computed; no warning claims a value was invented | B |
| T4 | Invalid retention values | `distance_km:"far"`, `-4`, `true`; `missed_reminders:1.5`; `visits_missed > scheduled_visits`; `daily_wage_worker:7` | 422 `invalid_features` with field-level message | B |
| T5 | Unknown / unmapped site | `site_id:"UNKNOWN"`; `site_id:null`; key omitted | 422 `unknown_site_category` (unknown value) / 422 `unsupported_feature_schema` + `missingFeatures:["site_id"]` (null or omitted); never scored without a site effect on the contract route; native `/v1/retention/predict` unchanged (D1). Replaces the old 200-with-warning test | B |
| T6 | v1 features only (legacy backend) | schema `"1"`, OTP/claim features | 422 → baseline; identical to Phase 5 behaviour | B, X |
| T7 | Complete integrity payload | Phase 3 demo converted to `trialData` | Site C findings (below, T12); honest sites ≤ LOW | B |
| T8 | Missing optional integrity data | omit `trialData` / `ecgs` / BP fields; separately omit `participants[].droppedOut` | no crash; audit rules only / ECG step skipped / `missing_mandatory` data-quality finding; missing `droppedOut` ⇒ 422 (required, never derived on this path, D6) | B |
| T9 | Invalid clinical measurements | `systolicBp:300`, `heartRate:5`, SBP ≤ DBP, string value | numeric-out-of-range ⇒ **200 with `visit.implausible_measurement`** finding; string/NaN ⇒ 422 | B |
| T10 | Missing/invalid ECG references | unknown path, corrupt file, `../` or absolute path, empty-string `imageRef` (no `imagePhash` field exists in v1.1, D9). A request that omits the required `imageRef` key is a 422, not a finding | `ecg.file_unavailable` findings, scan completes, other ECGs still clustered | B |
| T11 | Timestamps | no offset; `Z`; different offsets; unknown timezone; `"+05:30"` or `"IST"` as timezone; missing timezone | no offset ⇒ `visit.invalid_timestamp`; `Z` converted via `sites[].timezone` (night rule uses local hour: `2026-04-29T20:00Z` is night in `Asia/Kolkata` (01:30) but not in `America/New_York`); unknown / offset-style / abbreviation / missing timezone ⇒ 422 | B |
| T12 | Site C full scan | converted Phase 3 data | exactly: SBP digit preference, low variance, missing-OTP rate, late-night, delayed entries, 3 rapid-entry clusters, high-retention (LOW), anomaly enrichment, multi-signal (HIGH) for SITE-C; 18 visit findings, all in `fraud_ground_truth.csv`; 6 ECG clusters of 4 participants; **zero** multi-signal visits/site findings ≥ MEDIUM at A, B, D, E | B, X |
| T13 | Honest-site stability | scan with Site C removed | no site-level finding ≥ MEDIUM; no category `technical_violation` | B |
| T14 | Insufficient data | site with < 20 participants / < 60 visits | `site.insufficient_data` (LOW, data-quality) and no comparative tests | B |

## 4.1b Decision-specific tests (D1–D8)

| # | Scenario | Setup | Expected | Owner |
|---|---|---|---|---|
| T22 | Site mapping (D1) | site with `mlSiteCategory='SITE-A'`; site with `null`; site with `'SITE-F'`; two sites in one trial with the same category | features carry `site_id` `'SITE-A'` / `null` / `'SITE-F'`; duplicate category ⇒ 409/422 on write; `site_code` is never used as a fallback; no value outside A–E is rejected by the backend | A |
| T23 | Mapping end-to-end (D1) | participant at unmapped site; at `SITE-F` | both get baseline with `fallback.reason` containing `422`; participant at `SITE-A` gets the ML score | X |
| T24 | Timezone storage (D2) | PATCH site `timezone` = `Asia/Kolkata`, `null`, `Mars/Base`, `+05:30`, `IST` | valid & null accepted; the other three ⇒ 422; stored timestamps remain UTC (no rewrite of `scheduled_at`, `completed_at`) | A |
| T25 | Site without timezone (D2) | trial with sites X (tz set) and Y (`null`) | request `trialData.sites` contains only X and X's participants/visits/ECGs; `integrity.scan_completed` metadata lists Y in `sitesSkippedNoTimezone`; scan succeeds; UI shows the skipped count; nothing assumes UTC | A, X |
| T26 | Exception completion (D3) | investigator `POST /visits/:id/status {status:'completed', otpException:{reasonCode:'device_offline', note}}` from `scheduled` and from `otp_pending` | 200; visit `completed`, `verified_at` null, `otpVerified=false`; one `visit_otp_exceptions` row; audit `visit.completed_without_otp` has `reasonCode`, **no note**; live OTP record `superseded`; hash chain still valid | A |
| T27 | Exception rejected (D3) | no `otpException` from `scheduled`; `otpException` with `status:'missed'`; `otpException` on a `verified` visit; coordinator role; empty / 501-char note; unknown `reasonCode`; second exception on same visit | 409 `INVALID_STATE_TRANSITION`; 422 `OTP_EXCEPTION_NOT_APPLICABLE`; 422 `OTP_EXCEPTION_NOT_APPLICABLE`; 403; 422; 422; 409. Existing visit-transition tests unchanged | A |
| T28 | Missing OTP is a review signal (D3) | Site C visits with `otpVerified=false` (documented and undocumented) | `visit.missing_otp` LOW alone; never `technical_violation`, never described as fraud; `details.evidence.otpExceptionReason` (combined findings: `details.signalEvidence.missing_otp.otpExceptionReason`) present when documented; documented exception does **not** lower severity or suppress the finding; escalates only with other signals | B |
| T29 | Missing-OTP site rate (D3) | site where > threshold share of completed visits have `otpVerified=false` | `site.missing_otp_rate` counts documented + undocumented; category `suspicious_pattern` | B |
| T30 | Reminder derivation (D4) | enrollment with (a) no reminders; (b) only `sent`; (c) 2 `missed` + 1 `acknowledged`; (d) `missed` recorded before the deadline | (a) `missed_reminders=null`; (b) `null`; (c) `2`; (d) write rejected 422. Never `0` for unknown | A |
| T31 | Delay and drop-out derivation (D5, D6) | paid claims with delays 10 and 14 d + one unpaid; enrollments `enrolled`/`completed`/`withdrawn`/`screening`/`screen_failed` | delay `12`; none paid ⇒ `null`; `droppedOut` false/false/true; screening/screen_failed absent from `participants[]` | A |
| T32 | Two scales (D7) | Ramesh-like response with score 40 | backend `level='medium'`; `retentionRiskLevel='high'` shown separately; UI never merges them; with the column absent the extras are display-only and the assessment still persists | A |
| T33 | `enteredAt` is server-set (D8) | client sends `enteredAt` in the measurement body | field ignored/rejected by schema; stored value = server time at save; value in request to ML equals stored value | A |
| T34 | Sensitive-field allow-list (D11) | inspect every request built by `HttpRiskModel`/`HttpIntegrityModel` for the Ramesh and Site C fixtures | no name, DOB, phone, e-mail, address, `note`, or image bytes anywhere in the body; ids are UUIDs only | A, X |

## 4.2 Protocol tests

| # | Scenario | Expected | Owner |
|---|---|---|---|
| T15 | Request-ID consistency | body `requestId` echoed; header `x-request-id` propagated/generated; backend `assertEnvelope` passes (uses the real `HttpRiskModel`/`HttpIntegrityModel` via `tsx`) | B, X |
| T16 | Response schema compatibility | every response parses with `riskPredictionResponseSchema` / `integrityScanResponseSchema`; no `null` for optional zod fields | A (vitest) + B |
| T17 | Contract versions | backend `1.1` ↔ Python `1.x` OK; major `2.0` ⇒ 400 → fallback | B, X |
| T18 | Auth | `ML_API_KEY` set on both ⇒ OK; mismatched ⇒ 401 → fallback `model_error`; unset ⇒ open | A, B |
| T19 | Timeout and fallback | Python delayed beyond `ML_TIMEOUT_MS` (fault injection) ⇒ `fallback.reason` starts `timeout:`; Python stopped ⇒ `unavailable:`; garbage body ⇒ `invalid_response:`; request still returns 200 with baseline result | A (extend `tests/ml-integration.test.ts` stub) + X |
| T20 | Backward compatibility | v1.0 backend fixture against v1.1 Python and v1.1 backend fixture against Phase 5 Python (5.0.0) | A, B |
| T21 | Payload size | 20k visits / 5k participants within `ML_MAX_BODY_BYTES`; 413 beyond; latency recorded vs `ML_TIMEOUT_MS` | B, X |

## 4.3 End-to-end demos

| # | Flow | Steps | Expected | Owner |
|---|---|---|---|---|
| E1 | **Ramesh** | seed DB (Ramesh in SITE-A with spec §3 values) → `POST /api/v1/risk/assessments {entityType:'patient', entityId}` | `engine.name = retention-dropout-risk`, `fallback.used=false`, score 69.2 (±0.1; the importer's 7 paid claims give an 11.6-day mean delay — the Python CLI on the CSV's rounded 12 days gives 70.0), level high, factors include reminders/reimbursement delay/wage; audit event `risk.assessed`; row in `risk_assessments` | X |
| E2 | Ramesh with missing distance | null out `distance_km` | baseline engine used, `fallback.reason` contains `422` | X |
| E3 | **Site C scan** | seed Site C visits/ECGs → `POST /api/v1/integrity/scans {}` | `integrity_alerts` rows with `source = trialguard-integrity`; ECG cluster alerts reference real visit ids; second scan creates **no duplicates** (dedupeKey) | X |
| E4 | Broken chain | tamper one `audit_logs` row | `ml.chain_broken` CRITICAL (technical_violation) present alongside trial findings | X |
| E5 | Fallback drill | stop Python mid-demo | both endpoints still answer using baselines with `fallback.used=true` | X |
| E6 | **Completion without OTP** | complete a Site C demo visit via the exception path → run a scan | visit has `otpVerified=false` + reason; scan emits `visit.missing_otp` (LOW) and feeds `site.missing_otp_rate`; audit shows `visit.completed_without_otp`; no alert is labelled fraud | X |

## 4.4 Acceptance
All of T1–T34 and E1–E6 pass; existing suites unchanged and green (`npm test`, `python -m pytest`); Phase 3 data hashes and Phase 4 artifacts unchanged.
