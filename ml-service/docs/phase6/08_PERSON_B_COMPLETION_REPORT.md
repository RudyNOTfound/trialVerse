# 8. Person B completion report (Phase 6.2)

Date: 2026-11-03 · Branch `feature/ml-validation` · started from `7e302dc` · Scope: `ml-service/` only. Everything here is **synthetic
data**; nothing is clinically validated, and no accuracy claim about real-world fraud detection is made.

## 1. Source of truth, and what could not be checked

The repository contains **no "original 12-phase plan" document**. The only documented phases are 3 (data), 4 (retention model),
5 (integrity engine and service) and 6 (contract v1.1), in `ml-service/README.md`, `app/retention/README.md` and `docs/phase6/`.
Phases 1, 2 and 7–12 have no acceptance criteria anywhere in the repo, so no completeness claim is made for them. The matrix below
therefore assesses (a) phases 3–6 against their documents and (b) the six Person B work areas A–F of the Phase 6.2 brief.

## 2. Completion matrix

| Area | Requirement | Status | Evidence (executed) |
|---|---|---|---|
| **Ph 3 data** | Deterministic synthetic data (seed 42), 2,000 train / 300 demo participants, 5 sites, 2,400 visits, Site C anomalies, 30 ECG PNGs | COMPLETE | `tests/test_participants.py`, `test_visits.py`, `test_validation.py`, `test_ecg.py`; new `test_generated_data_consistency.py` (7) |
| **Ph 4 / A** | Participant-level stratified 70/15/15 split, no ID overlap | COMPLETE | `test_split_is_stratified_disjoint_and_70_15_15`, `test_split_sizes_and_no_row_overlap`; ids unique (new test) |
| | Preprocessing fitted on train only | COMPLETE | `test_imputer_and_scaler_fit_on_training_rows_only` |
| | No (deterministic) label leakage | **COMPLETE (was unverified)** | new `test_data_leakage.py` (7): strongest single feature AUC 0.743, canary proves the detector trips |
| | Held-out metrics, documented reproducible thresholds | COMPLETE | `test_test_split_is_not_used_for_selection_or_thresholds`, `test_training_is_reproducible`; metadata.json |
| | Artefacts load and serve; output follows the contract | COMPLETE | `test_artifact_roundtrip_and_no_retraining`; socket test (real uvicorn) |
| | Local explanations (exact SHAP) | COMPLETE | `tests/retention/test_explanations.py` (additivity to 1e-4, determinism, unseen site, failure not fabricated) |
| **B** | Recommendations from triggered factors, deterministic, no outcome claims | COMPLETE | `test_interventions.py` (20); socket test checks fewer drivers ⇒ fewer actions |
| **Ph 5 / C** | Visit rules, site statistics, min sample sizes, OTP handling, multiple-signal aggregation | COMPLETE | `tests/integrity` (67) incl. insufficient-data and honest-site tests |
| | Isolation Forest | COMPLETE (it exists and is specified) | `test_anomaly.py`: skipped below `min_rows`, seeded, identifiers excluded; reported as a *signal* |
| **D** | ECG: valid PNGs, hashes consistent, exact duplicates, attribution, unavailable files | **PARTIAL → COMPLETE** | **defect found and fixed: blank images clustered as duplicates** (§4); `test_ecg_edge_cases.py` (13) |
| **Ph 6 / E** | Contract v1.1 requests/responses, 4xx semantics, null vs zero, unknown site, invalid tz/ECG ref, empty/malformed payloads | COMPLETE | contract suites (165) + socket suite (23); decisions D1–D15 |
| **F** | Realistic requests through the real HTTP layer | **PARTIAL → COMPLETE** | previously only in-process `TestClient`; new `test_http_socket.py` runs uvicorn as a subprocess |
| X-tests | Live backend ↔ Python | COMPLETE for the service layer; **BLOCKED for route/UI level** | backend `tests/live`: 19/19 against this service; UUID-id issue is Person A's (§9) |

## 3. Files changed

| File | Why |
|---|---|
| `app/integrity/ecg_dupes.py`, `app/integrity/config.py` | blank/uniform images no longer clustered (`min_pixel_std`); cache also stores the grey-level std |
| `tests/integrity/test_ecg_edge_cases.py` (new, 13) | blank, sparse, truncated, empty, text, folder, symlink-escape, exact copies, attribution, stable cluster ids |
| `tests/test_generated_data_consistency.py` (new, 7) | metadata ↔ files ↔ SHA-256 ↔ visits agree; no orphans; reuse only at Site C |
| `tests/service/test_http_socket.py` (new, 23) | real-socket tests: Ramesh-like request, auth, 422s, Site C scan vs ground truth, F1/F2 over the wire |
| `tests/retention/test_data_leakage.py` (new, 7) | leakage guards with a canary |
| `README.md`, `app/retention/README.md`, `docs/phase6/02`, `04`, `05`, `06` | Ramesh 69.2 (§7), ECG behaviour, stale "contract gap" removed, test commands, D14/D15, open questions Q1–Q6 |
| `docs/phase6/08_PERSON_B_COMPLETION_REPORT.md` (this file) | report |

No model, training data, Phase 3 generator, TypeScript, frontend or migration file was touched.

## 4. Defect fixed: featureless ECG images reported as duplicates

*Evidence:* white, black, gray, transparent and 1×1 images from five different participants were reported as one
`ecg.duplicate_image` cluster ("near-identical … independent recordings of different people should not match", MEDIUM). A
perceptual hash of an image with no structure carries no information, so every blank image has (nearly) the same hash.
*Fix:* an image whose grey-level std is below `EcgConfig.min_pixel_std` = 2.0 (the 30 Phase 3 ECGs measure 34.6–91.2) is reported
as the existing `ecg.file_unavailable` finding ("could not be checked", `data_quality`, MEDIUM). No new rule id, no contract change
(decision D14). *Controls:* with the guard removed 4 of the 13 new tests fail; a thin-sine-trace image (std ≫ 2) is still compared;
the cluster behaviour for real ECGs is unchanged (Site C: 6 clusters, 24 visits, identical to ground truth).

## 5. Verified and found correct (no change needed)

Exact SHAP over the whole pipeline with an additivity check; participant-disjoint stratified split; imputer/scaler inside the
sklearn pipeline; thresholds from validation only; reminder semantics (null ⇒ 422, 0 ⇒ scored); symlink and `..` escape blocked;
NaN-safe site statistics (a site with no BP values, and constant BP everywhere, both returned 200 on the native route).

## 6. Tests executed (exact)

Run from `ml-service/` with `/Users/sharvari/trialVerse/.venv-ml`.

| Command | Result |
|---|---|
| `python -m pytest` | **452 passed**, 0 failed, 0 skipped (baseline at `7e302dc`: 402) |
| `pytest tests/service/test_contract_v11_risk.py …_integrity.py test_schema_parity.py test_phase61_validation.py` (contract v1.1) | 165 passed |
| `pytest tests/retention` | 121 passed |
| `pytest tests/integrity` | 67 passed |
| ECG: `tests/test_ecg.py`, `tests/integrity/test_ecg_{dupes,edge_cases,vectorised}.py`, `tests/test_generated_data_consistency.py` | 37 passed |
| `pytest tests/service` (in-process API) | 200 passed |
| `pytest tests/service/test_http_socket.py` (real uvicorn) | 23 passed |
| `pytest tests/service/test_schema_parity.py` (validates responses with the backend's real zod schemas via Node) | 3 passed |
| backend `npx vitest run tests/live` against this service (`ML_LIVE_*` set) | 19 passed |

Negative controls actually run: F1 reverted ⇒ the over-the-wire F1 test fails; ECG guard removed ⇒ 4 tests fail; F1/F2 reverted ⇒ 8
Phase 6.1 tests fail. Inspected but not executed: nothing is reported as passed that was not run.

## 7. Model metrics and Ramesh

Selected: logistic regression, C = 10 (`models/retention/metadata.json`, version `1.0.0+logistic_regression.0e359a5a`). Split:
stratified 1,400 / 300 / 300 (train / validation / **held-out test**), seed 42, prevalence 0.26 in each.

| Split | ROC-AUC | PR-AUC | Brier |
|---|---|---|---|
| validation (used for selection and thresholds) | 0.8753 | 0.7607 | 0.1162 |
| **test (held out, evaluated once)** | **0.8125** | **0.6776** | 0.1376 |

Operational threshold 0.18 (argmax F2 on validation); on the test split: recall 0.833, precision 0.422. High threshold 0.39 (test
recall 0.603, precision 0.573). The test set holds about 78 dropouts, so these figures are imprecise.

**Ramesh (P-A-001), integrated path: 69.2 / 100, HIGH** (69.21; engine `retention-dropout-risk`, no fallback). Top drivers: missed
reminders +10.5, reimbursement delay +9.7, daily-wage worker +8.7, distance +8.5. Actions: `reminder_escalation` (high),
`reimbursement_priority` (high), `remote_or_home_visit`, `flexible_scheduling`, `clinician_follow_up`, `coordinator_follow_up`.
The backend derives his reimbursement delay as 81/7 = 11.6 days from 7 paid claims; the Phase 3 CSV rounds this to 12 days, which the
same model scores at 70.0. Same participant, different input; the training-time report `reports/retention/ramesh_demo.*` was
generated from the CSV and was deliberately not regenerated (that would be retraining).

## 8. Site C and performance

Backend live path (service layer, in-memory DB): **44 findings, 44 new alerts, no fallback**. Over the Python socket: the 18
late-night unverified visits flagged `visit.multiple_integrity_signals` equal the ground truth exactly, the ECG clusters cover exactly
the 24 reused-image visits (all cross-participant), site-level findings exist for Site C only (BP digit preference, low BP variance,
late-night, delayed entries, missing-OTP rate, rapid-entry, `multiple_integrity_signals` = HIGH). Missing-OTP visits are LOW.
Only two anomaly types exist in the ground truth, so BP digit preference and variance are checked as site-level rules, not against a
per-visit label. The injected patterns were written by the same author as the detectors; this is a sanity check, not a performance
estimate.

`tests/perf/measure_integrity_scan.py`, 20,000-visit scale, warm timing (this machine): A 5 sites 2.8 s · B 200 sites 3.3 s · C +2,000 ECGs
3.6 s · D 2,000 identical ECGs 3.5 s (peak RSS 626 MB) · E 200 eligible sites 3.9 s. All below the backend's 10 s integrity timeout.
(My earlier session measured A at 1.7 s; run-to-run variation on this laptop is large and no regression source was found — A has no ECGs.)

## 9. Remaining Person B work

None required by the documents. Open questions Q1–Q6 are recorded in `05_UNRESOLVED_DECISIONS.md`; none was changed unilaterally.

## 10. Person A dependencies and blockers (not fixed here)

1. **UUID ids**: `ml:demo-import` creates `P-A-001`-style ids, but `POST /risk/assessments` and every `/:id` route validate UUIDs, so Ramesh
   cannot be assessed over the backend's HTTP API or UI (400 `Invalid uuid`). Python is unaffected (it accepts any non-empty id).
2. No HTTP routes for measurements, ECG registration, reminders or adverse events; the frontend shows neither the model category nor
   `recommendedActions` (they are parsed and dropped; D7 persistence is undecided).
3. The browser demo has **not** been tested by Person B; the UI was not run.

## 11. Git and ownership

All Person B work is committed locally on `feature/ml-validation`; nothing is pushed. Person A-owned files (TypeScript, frontend, migrations,
auth/OTP, database) were not modified.
