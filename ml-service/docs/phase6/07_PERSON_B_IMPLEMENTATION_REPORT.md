# 7. Person B implementation report — Python ML service, contract v1.1

Date: 2026-11-02 · Scope: `ml-service/` only. No TypeScript, migration, frontend, Phase 3 generator/dataset, Phase 4 training code/model artifact or git history was touched.
**Status: the Python side is implemented and tested. Phase 6 is NOT complete** — nothing has been run against an updated backend (none exists yet); the end-to-end tests (**X**) are open (§6).

## 1. Behaviour now (service 0.6.0, `contractVersion "1.1"`)

| Endpoint | Change |
|---|---|
| `POST /v1/risk/predict` | Echoes `"1.1"` (fixed, D13). `scheduled_visits` is **required** (D12). `site_id` null/omitted → 422 `unsupported_feature_schema` (`details.missingFeatures`); a value outside the model's categories → 422 `unknown_site_category` (`details.siteId`, `details.knownSiteCategories`); matching is exact (no case-folding, trimming or fuzzy mapping). `missed_reminders: null` = no reminder history → refused, never 0. The explanation labels the engine's level **"retention model category … separate from the platform's risk levels"** and discloses imputed optional inputs; `retentionRiskLevel` is the model's own 0.18/0.39 category and is never derived from, or converted to, the backend's 25/50/75 level. `confidence` stays omitted. |
| `POST /v1/integrity/predict` | New optional `trialData` (spec 01 §4). Absent → audit rules only (v1.0 behaviour, no fabricated scan). Present → visit rules, site statistics, ECG duplicates and anomaly signal run and are merged with the audit findings (dedupe by rule+entity+`dedupeKey`, sort by severity/score, cap 1000). Findings use backend ids as `entityId`, with `details.siteCode`; messages name the site by code. Reimbursements cap is now 2000 (spec §5). |
| `GET /ready` | `components.retention_model.knownSiteCategories` (sorted; `[]` when the model is not loaded). |
| `POST /v1/retention/predict`, `POST /v1/integrity/trial-scan` | **Unchanged** (native routes; still default `scheduled_visits` and tolerate unknown sites with a warning). |

`trialData` validation (all → HTTP 422 `invalid_request` with the field path, nothing guessed):
site `timezone` required and a canonical IANA name (offsets, abbreviations, legacy aliases, empty, unknown, path-like → rejected); `scheduledAt` must carry `Z`/offset; `performedAt`/`enteredAt` must be ISO — an *offset-less* one is accepted and reported as `visit.invalid_timestamp`; numeric measurements must be real numbers (strings, booleans, NaN/Infinity → 422; implausible numbers → `visit.implausible_measurement` finding); `droppedOut` strict boolean, required; `otpVerified` strict boolean|null; `otpExceptionReason` ∈ the five enum values and only with `otpVerified=false`; six visit statuses (rules apply to `completed` only); all ids resolve and are unique; ECG ↔ visit/site/participant must agree and every `visits[].ecgRecordId` must exist in `ecgs[]` (when `ecgs` is sent); caps 200 sites / 5000 participants / 20000 visits / 2000 ECGs; body ≤ `ML_MAX_BODY_BYTES` (default raised 10 → 25 MiB).

Timezone handling: UTC instants → site-local ISO (via `zoneinfo`) before the night-entry, visit-window (local `scheduledAt` date vs local `performedAt` date) and rapid-entry rules. ECG: `imageRef` relative to `ML_ECG_DIR`; traversal/absolute/missing/corrupt/empty → `ecg.file_unavailable` (scan continues); clusters keyed on `ecgRecordId`; **client-supplied hashes and image bytes are not part of the contract** (unknown keys are ignored and never used or echoed). OTP: `visit.missing_otp` stays LOW alone, `exceptionDocumented` + `otpExceptionReason` are evidence only and never lower severity; `site.missing_otp_rate` counts documented and undocumented alike; nothing is labelled fraud. Hash-chain verification stays in the backend; Python reports the backend's verdict and checks `seq` continuity only.

## 2. Files changed (all under `ml-service/`)

* `app/api/settings.py` (versions, body limit) · `app/api/schemas.py` (v1.1 models) · `app/api/app.py` (routes, `/ready`) · `app/api/risk_adapter.py` (required set, explanation wording)
* `app/integrity/contract_adapter.py` **(new)** · `engine.py` (`scan_request`) · `trial_data.py`, `visit_rules.py` (OTP evidence/wording) · `ecg_dupes.py` (vectorised clustering) · `site_stats.py` (removed O(sites²) re-filtering) · `config.py` (ECG cache 512 → 4096)
* `requirements.txt` (+`tzdata`) · `README.md` (v1.1 sections)
* Tests: `tests/service/test_contract_v11_risk.py`, `test_contract_v11_integrity.py`, `test_schema_parity.py`, `golden_requests.py` **(new)**; `tests/integrity/test_ecg_vectorised.py` **(new)**; `tests/parity/zod_check.ts` **(new, read-only import of `src/ml/contracts.ts`)**; `tests/perf/measure_integrity_scan.py` **(new)**
* Docs: `docs/phase6/01–04` (contract mismatches below), `03` ticks, this file.

## 3. Tests

`python -m pytest tests` → **365 passed, 0 failed, 0 skipped** (233 pre-existing + 132 new, parametrised). Live check over real HTTP with the **shipped** model: Ramesh → 200, score **70.01**, `contractVersion "1.1"`; unmapped `site_id` → 422 `unknown_site_category`; the Phase 3 Site C golden request (UTC timestamps, UUIDs, Asia/Kolkata, real ECG files) → 18 multi-signal visits (exactly the injected ground truth), 6 ECG clusters of 4 participants, 3 rapid-entry clusters, and findings identical to the native route's (rule/entity/severity multiset) — T7/T12/T13.

**Intentional changes to existing tests (nothing deleted or weakened):**
1. `test_api.py::test_risk_unknown_site_scores_with_warning_not_error` → renamed `test_risk_unknown_site_is_refused_on_the_contract_route`, now expects 422 `unknown_site_category` (D1). The old 200 behaviour is retained and asserted for the native route in `test_t5_native_route_is_unchanged…`.
2. `svc_helpers.py`: `CONTRACT_FEATURES` gains `scheduled_visits=8` (D12) and request bodies say `contractVersion "1.1"`.
3. Two assertions `contractVersion == "1.0"` → `"1.1"` (D13).

Coverage map of 04 (Person B / shared rows): T1–T14 ✔ · T15 request-id (body+header) ✔ · T16 ✔ (Python mirror **and** the backend's real zod schemas via `tsx`; negative control proves it can fail; auto-skips if node/tsx is absent) · T17 ✔ · T18 ✔ (risk route) · T20 ✔ (v1.0 payloads) · T21 caps/413/20k ✔ (§4) · T28, T29 ✔. Rows owned by A (T22–T27, T30–T34), the live parts of T2/T6/T15/T17/T19/T21 and E1–E6 are **not** covered here.

## 4. Performance (T21) — `tests/perf/measure_integrity_scan.py`, macOS dev laptop (Apple M4), Python 3.9, one process per scenario

| Scenario | Visits / participants / sites / ECGs | Body | Wall time (parse + scan + serialise) | Peak RSS | Findings |
|---|---|---|---|---|---|
| A realistic | 20,000 / 2,500 / 5 / 0 | 8.3 MB | **1.7 s** (warm 2.0) | 412 MB | 419 |
| B many small sites | 19,200 / 2,400 / 200 / 0 | 8.1 MB | 2.6 s | 406 MB | 233 |
| C + 2,000 distinct ECGs | 20,000 / 2,500 / 5 / 2,000 | 8.5 MB | **2.3 s** (was 5.1 s) | 454 MB | 419 |
| D worst case: 2,000 identical ECGs | same | 8.5 MB | 2.4 s | 625 MB | 420 |
| E 200 sites, all eligible for tests | 17,600 / 4,400 / 200 / 0 | 7.5 MB | **3.1 s** (was **82 s**) | 394 MB | 28 |

Two real bottlenecks were found and fixed without changing any result (existing + golden equality tests pass; an equivalence test compares the new ECG clustering to a naive all-pairs version): ECG all-pairs Hamming in a Python loop (2M `imagehash` subtractions, 2.9 s of 3.9 s) → matrix product + connected components; per-site-pair DataFrame re-filtering in `site_stats` (~80,000 scans) → per-site arrays computed once. ECG hash cache default was smaller than the request cap (thrashing on repeat scans) → 4096.

**Timeout concern (not changed — needs Person A):** the backend's `ML_TIMEOUT_MS` default is **3000 ms** and is shared by risk and integrity. A full 20k-visit scan is 1.7–2.4 s here (typical), 3.1 s in the extreme E case, on this laptop and before network/JSON overhead and backend serialisation. A slower host would exceed 3 s. Recommendation to Person A: a separate, larger integrity timeout (≈ 10 s) — config only, not a contract change. Python's own `ML_REQUEST_TIMEOUT_S` (default 10 s) is a backstop and is *above* the backend's default; it was not changed. Risk-request latency was not re-measured in this phase.

## 5. Contract mismatches found (and how they were resolved)

| # | Mismatch | Resolution |
|---|---|---|
| M1 | 01 said null `site_id` → `missing_feature`; 02/T2 and the existing code use `unsupported_feature_schema` + `missingFeatures` | Kept the existing code (backward compatible); 01, 03, 04 corrected |
| M2 | 04 T10 listed "missing `imageRef`" as a finding, but 01 makes `imageRef` required | Missing key → 422; empty string/traversal/missing file → `ecg.file_unavailable`; 04 corrected |
| M3 | 01 §5 caps reimbursements at 2000; Python allowed 20000 | Python now 2000 (backend `MAX_ROWS` is 2000) |
| M4 | 01 estimated ~25 MB for 20k visits | Measured ~8.5 MB; default still 25 MiB (headroom for longer ids/ECG refs) |
| M5 | Python's 10 s deadline vs backend 3 s default | Documented (§4); Person A decision |
| M6 | `performedAt`/`enteredAt`/`otpVerified` are "required if completed" | Enforced as a `visit.missing_mandatory` data-quality finding, not a 422 (matches T8; a half-entered visit is a finding, not a malformed request) |
| M7 | `visits[].ecgRecordId` "must appear in ecgs[]" | Enforced when `ecgs` is sent; when `ecgs` is omitted the ECG step is skipped (T8) |
| M8 | The explanation printed "(high)" beside the score, readable as the platform's level | Reworded to "retention model category" (D7) |
| M9 | `src/ml/contracts.ts` still has `CONTRACT_VERSION = '1.0'` | Person A's change; majors match so nothing breaks meanwhile |
| M10 | Body-size limit trusts `Content-Length` only (pre-existing); a chunked upload without it is not size-checked | Not changed (the backend's `fetch` sets Content-Length); noted as a known limitation |

## 6. What Person A must do before live integration can pass

1. **Migration `002_ml_inputs.sql` and capture routes** (03 A2/A3) — nothing in Python can be exercised end-to-end without `ml_site_category`, `timezone`, distance, wage, `visit_reminders`, adverse events, `visit_measurements`, `visit_ecgs`, `visit_otp_exceptions`.
2. **`patientFeatures()`**: send all ten v1.1 keys incl. **`scheduled_visits`**, `featureSchemaVersion "2"`; `site_id` from `ml_site_category` or `null`; `missed_reminders` `null` unless a resolved reminder exists; never `0` for unknown.
3. **`buildScanRequest()` → `trialData`** exactly as validated above, in particular: `timezone` on every site (omit sites without one **together with their participants, visits and ECGs**, or the request is 422 on dangling references); `scheduledAt` with `Z`/offset (never a bare date); `performedAt`/`enteredAt` as UTC instants with offset; `droppedOut` a real boolean for **every** participant; `otpVerified` a boolean; `otpExceptionReason` only when `otpVerified=false`; every ECG row has `imageRef`, and ECG `visitId/participantId/siteId` equal those of the visit that references its `ecgRecordId`; unique ids; measurements numeric.
4. **Shared ECG directory**: `visit_ecgs.file_ref` relative to the directory the Python service runs with as `ML_ECG_DIR`.
5. Set `CONTRACT_VERSION = '1.1'` in `contracts.ts`, add `trialData` types, update `docs/ML_INTEGRATION.md` (same PR, both reviewers).
6. **Integrity timeout** (§4): separate and larger than 3 s, or measure on the target host first.
7. Run and own the A/X tests: T2/T6/T15/T17/T19/T21 live, T22–T27, T30–T34, E1–E6; confirm the backend's real `HttpRiskModel`/`HttpIntegrityModel` accept the 1.1 responses (T15; only the zod schemas were checked here, not the HTTP client).
8. Decisions still with Person A per 06: none blocking Python (D4/D7/D11 confirmed in the task statement; D7 extras are display-only, so no persistence is required).

## 7. Readiness

**Ready for live integration from the Python side**, with the caveat that this was verified with a Python-built request that follows the spec, not a request from the real backend. Expect contract friction at step 3 above (strict validation rejects malformed `trialData` outright rather than guessing); the 422 `details` name the offending field.
