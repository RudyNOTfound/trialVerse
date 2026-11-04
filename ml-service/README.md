# TrialVerse ML service

> **Synthetic-data prototype.** Every dataset, model and finding here is built from fictional, synthetic data. This is
> **not** a validated clinical-trial fraud-detection system, **not** a clinical decision-support tool, and must not be
> used for any decision about real patients, sites or staff. Integrity findings are review prompts, never accusations.

An independent Python service (FastAPI) that gives the TypeScript backend two kinds of intelligence:

* a **retention engine** — dropout-risk score, SHAP-style explanation and rule-based support actions (Phase 4);
* an **integrity engine** — explainable rule checks, site-level statistics, ECG duplicate detection and an
  unsupervised anomaly signal (Phase 5).

Contents: [Architecture](#architecture) · [Install](#install) · [Run](#run-the-service) · [Endpoints](#endpoints) ·
[Integration with the backend](#integration-with-the-backend-for-person-a) · [Retention](#retention-engine) ·
[Integrity methodology](#integrity-detection) · [Configuration](#configuration-and-thresholds) ·
[Errors](#error-handling-and-reliability) · [Tests](#testing) · [Demo](#demo-workflow) · [Limitations](#known-limitations)
· [Phase 3 data generator](#phase-3--synthetic-data-generation)

## Architecture

```
 React frontend → TypeScript backend (DB, features, auth, audit, fallback)
                        │  HTTP/JSON, contract v1.1 (docs/phase6/, src/ml/contracts.ts)
                        ▼
                 FastAPI  (app/main.py, app/api/)
              ┌─────────┴──────────┐
        Retention engine      Integrity engine
        app/retention/        app/integrity/
        (pipeline.joblib)     (rules · site stats · pHash · IsolationForest)
```

The service receives JSON and returns JSON. It never opens the backend's SQLite database or source code. Models are
loaded **once at startup** from `models/retention/`; nothing is trained at serve time.

## Install

Python 3.9+ (tested on 3.9.6). From the repo root:

```bash
source .venv-ml/bin/activate
pip install -r ml-service/requirements.txt
```

XGBoost is listed but not used (it needs `libomp` on macOS); HistGradientBoosting is the alternative candidate.
Generated data and trained artifacts are needed for the demo, not for the API tests (they build what they need):

```bash
cd ml-service
python -m app.data_generation.generate_all    # Phase 3 data → generated_data/
python -m app.retention.train                 # Phase 4 model → models/retention/
```

## Run the service

```bash
cd ml-service                                  # the working directory must be ml-service/
source ../.venv-ml/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8001
curl -s localhost:8001/health                  # {"status":"ok","service":"trialguard-ml-service",...}
curl -s localhost:8001/ready                   # 200 when the model and engine are usable, 503 otherwise
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `ML_API_KEY` | unset | If set, `/v1/*` requires `Authorization: Bearer <key>` (same name the backend uses) |
| `ML_MODEL_DIR` | `models/retention` | Where `pipeline.joblib`, `metadata.json`, `explainer_background.csv` live |
| `ML_ECG_DIR` | `generated_data` | Root for `image_file` paths in trial scans (paths outside it are rejected) |
| `ML_MAX_BODY_BYTES` | 26214400 | Larger bodies get HTTP 413 (a 20,000-visit `trialData` request is ~8.5 MB) |
| `ML_REQUEST_TIMEOUT_S` | 10 | Per-request inference deadline → HTTP 504. Keep it below the backend's `ML_TIMEOUT_MS` if you want 504s rather than backend timeouts |
| `ML_LOG_LEVEL` | `INFO` | JSON logs on stderr |

## Endpoints

| Method & path | Purpose | Contract |
|---|---|---|
| `GET /health` | Liveness: status, service name, version. Needs no model. | – |
| `GET /ready` | Readiness: model loaded, integrity engine available, artifact files present. **503** if anything required is missing. | – |
| `POST /v1/risk/predict` | Risk score for the backend | `RiskPredictionRequest` → `RiskPredictionResponse` |
| `POST /v1/integrity/predict` | Integrity findings for the backend | `IntegrityScanRequest` → `IntegrityScanResponse` |
| `POST /v1/retention/predict` | Native retention prediction (full detail) | not part of the contract |
| `POST /v1/integrity/trial-scan` | Trial-data integrity scan (visits, ECGs, sites) | not part of the contract |

OpenAPI docs: `http://localhost:8001/docs`. Every response carries `x-request-id` (the inbound header is propagated,
otherwise a UUID is generated); the contract's body `requestId` is echoed unchanged.

### `POST /v1/risk/predict`

Contract **v1.1** (`docs/phase6/01_CONTRACT_SPECIFICATION.md`). A request with the v1 feature schema (OTP failures, claim
velocity, …) carries none of the retention model's inputs, so the route answers **HTTP 422** (`unsupported_feature_schema`)
and the backend falls back to its baseline engine. It never fills missing inputs with defaults.

Request (`entityType` must be `patient`; **required**: `site_id`, `distance_km`, `daily_wage_worker`, `scheduled_visits`,
`missed_reminders`, `side_effects_reported`, `phone_changed`, `visits_missed`; `age`, `reimbursement_delay_days`
optional/nullable). A `null`/missing required value → 422 `unsupported_feature_schema` with `details.missingFeatures`
(`missed_reminders: null` means "no reminder history" and is refused, never read as 0). `site_id` must be one of
`/ready` → `components.retention_model.knownSiteCategories`, otherwise 422 `unknown_site_category`:

```json
{"contractVersion":"1.1","requestId":"req-123","entityType":"patient","entityId":"pat-1","featureSchemaVersion":"2",
 "features":{"site_id":"SITE-A","age":52,"distance_km":40,"daily_wage_worker":1,"scheduled_visits":8,"missed_reminders":2,
             "reimbursement_delay_days":12,"side_effects_reported":1,"phone_changed":0,"visits_missed":1},
 "requestedAt":"2026-11-01T12:00:00.000Z"}
```

Response (the last two fields are additive; the backend ignores unknown response fields):

```json
{"contractVersion":"1.1","requestId":"req-123","modelName":"retention-dropout-risk","modelVersion":"1.0.0+logistic_regression.0e359a5a",
 "score":69.21,
 "factors":[{"name":"missed_reminders","contribution":10.55,"detail":"Missed reminders: 2 raises the model's risk score by 10.5 points"}],
 "explanation":"Predicted dropout risk 69/100; retention model category: high (model thresholds, separate from the platform's risk levels). Largest risk-increasing factors: … Factors are statistical associations …",
 "retentionRiskLevel":"high","recommendedActions":[{"action_type":"…","title":"…","reason":"…","priority":"high"}]}
```

`confidence` is omitted on purpose (the model's probability is not a calibrated confidence in the sense of the field).
`factors` lists risk-increasing factors (positive `contribution`) followed by protective ones (negative).
The backend derives its own `level` from `score` at 25/50/75; the engine's own `retentionRiskLevel` uses the
validation-selected thresholds (operational 0.18, high 0.39). **The two scales are never converted into each other**: a
score of 40 is backend `medium` and engine `high`, and the explanation labels the latter "retention model category".
Imputed optional inputs (`age`, `reimbursement_delay_days`) are disclosed in the explanation ("Data notes"). The native
`/v1/retention/predict` route is unchanged (it still defaults `scheduled_visits` and tolerates unknown sites with a warning).

### `POST /v1/integrity/predict`

Works on what the backend sends: audit `events` (≤ 5000), `reimbursements` (≤ 2000), `openVisits` (≤ 2000), the backend's own
`chain` verdict, and — new in v1.1, optional — **`trialData`** (`scope`, `sites` ≤ 200, `participants` ≤ 5000, `visits` ≤ 20000,
`ecgs` ≤ 2000). Without `trialData` only the audit rules below run (exactly the v1.0 behaviour; no trial scan is fabricated). With
it, the visit rules, site statistics, ECG duplicate check and anomaly signal also run and their findings are merged with the audit
findings (de-duplicated by rule + entity + `dedupeKey`, sorted by severity, capped at 1000).

`trialData` rules (spec 01 §4): every site needs a canonical **IANA `timezone`** (`Asia/Kolkata`; offsets, abbreviations, unknown
or missing → 422 for the whole call — never assumed). Timestamps are UTC instants and are converted to the **site-local** clock
only for the night-entry, visit-window and rapid-entry rules; an offset-less `performedAt`/`enteredAt` is reported as
`visit.invalid_timestamp`, never guessed. `participants[].droppedOut` is required and used as sent. `otpVerified: false` with an
optional `otpExceptionReason` is a **review signal** (LOW alone, escalates only with other signals, a documented exception never
lowers severity; never "fraud"). ECGs are read from `ML_ECG_DIR` via the relative `imageRef`; clusters are keyed on `ecgRecordId`;
**client-supplied image hashes are not accepted** (unknown keys are ignored) and image bytes are never sent. Findings name the site
by `details.siteCode`, with the backend `siteId` as `entityId`. Every finding has the contract fields (`ruleId`, `entityType`, `entityId`, `severity`, optional `score`,
`message`, `details`, `dedupeKey`); the extra review context lives inside `details`:
`category` (`technical_violation` | `suspicious_pattern` | `data_quality`), `recommendedReviewAction`, `siteId`.
There is no `fraud_probability`: nothing here is a calibrated fraud model.

| `ruleId` | Severity | Category | Fires when |
|---|---|---|---|
| `ml.chain_broken` | critical | technical_violation | the backend's `chain` says invalid / `errorCount > 0` |
| `ml.audit_seq_gap` | high | technical_violation | `seq` numbers in the window are not contiguous (possible deletion) |
| `ml.self_approval` | critical | technical_violation | a claim was approved by its own requester |
| `ml.otp_failure_burst` | high | suspicious_pattern | ≥ 5 failed OTPs on one visit |
| `ml.duplicate_reimbursement` | high | suspicious_pattern | ≥ 2 pending/approved claims, same visit + category + amount |
| `ml.rapid_claim_submission` | medium | suspicious_pattern | ≥ 4 claims by one user within 10 minutes |
| `ml.patient_unverified_visits` | medium | suspicious_pattern | ≥ 3 overdue unverified visits for one patient |
| `ml.actor_activity_outlier` | medium | suspicious_pattern | one actor's event count is a robust-z outlier (≥ 5 actors, ≥ 100 events) |
| `ml.unverified_visit_overdue` | low | data_quality | a single overdue unverified visit |

**Hash-chain boundary.** The contract carries only the backend's verdict, not each event's `prevHash`/`hash`, so the
cryptographic verification stays in `src/modules/audit/chain.ts`. This service reports that verdict and independently checks
the one thing the payload exposes: `seq` continuity. Re-verifying hashes in Python would need `prevHash`/`hash` on every event
and the exact canonical-JSON recipe (see [CONTRACT_EXTENSION_PROPOSAL.md](CONTRACT_EXTENSION_PROPOSAL.md)).

### `POST /v1/retention/predict` and `POST /v1/integrity/trial-scan`

Not part of the backend contract (see below for why). `retention/predict` takes the participant fields
(`site_id`, `distance_km`, …; unknown fields such as `dropped_out` are rejected) and returns the full Phase 4 prediction.
`trial-scan` takes `visits` (the Phase 3 `visits.csv` columns), optional `participants` (`dropped_out`) and `ecgs`
(`ecg_id, visit_id, participant_id, site_id, image_file`, relative to `ML_ECG_DIR`) and returns site statistics, the
anomaly summary, ECG stats and findings with `ruleId, category, severity, entityType, entityId, siteId, explanation,
evidence, score, recommendedReviewAction`.

## Integration with the backend (for Person A)

Verified against `src/config/env.ts`, `src/ml/httpModels.ts`, `src/ml/gateway.ts` and `docs/ML_INTEGRATION.md`.

```env
ML_RISK_ENABLED=true
ML_RISK_URL=http://localhost:8001
ML_INTEGRITY_ENABLED=true
ML_INTEGRITY_URL=http://localhost:8001      # docs suggest :8002; one process serves both paths, so :8001 works
ML_TIMEOUT_MS=3000
ML_API_KEY=                                 # optional; if set on both sides the service enforces it
```

* The backend appends `/v1/risk/predict` and `/v1/integrity/predict` to the base URL (trailing `/` is stripped).
* **Timeouts:** the backend aborts after `ML_TIMEOUT_MS` (plus a 500 ms outer guard) and falls back. The service's own
  deadline is `ML_REQUEST_TIMEOUT_S` (default 10 s); typical latency is ~30 ms for a risk request after startup.
* **Fallback:** any HTTP ≥ 400, timeout, connection error, non-JSON/schema violation, major-version mismatch or
  `requestId` mismatch → baseline engine, with `fallback.used = true`. This service returns: `400` unsupported contract
  major · `401` bad bearer token · `413` body too large · `422` validation / unsupported features · `500` engine error ·
  `503` model or engine unavailable · `504` inference deadline. All use `{"error":{"code","message","requestId","details?"}}`.
* **Checked, not assumed:** the backend's own `HttpRiskModel` / `HttpIntegrityModel` classes (run read-only through `tsx`)
  parse this service's responses against the real zod schemas. The risk route answered with a valid response for participant
  features and `model_error` (HTTP 422) for the backend's current v1 features, as designed.

**Integration is not complete.** The service works on its own and the contract surface is wired, but:

1. `/v1/risk/predict` cannot score any request the backend sends today (features mismatch) — every risk call falls back.
2. The Site C checks (BP digit preference/variance, ECG reuse, rapid entry) need trial-visit data the integrity contract
   does not carry. They are exposed through the non-contract `trial-scan` route only.

[CONTRACT_EXTENSION_PROPOSAL.md](CONTRACT_EXTENSION_PROPOSAL.md) lists the smallest additions for Person A's approval.
Nothing in `src/` or `docs/` was changed.

## Retention engine

Phase 4 (details, metrics and limitations in [`app/retention/README.md`](app/retention/README.md)). Logistic regression
(C=10) selected on validation PR-AUC from 13 candidates (Dummy, logistic regression, HistGradientBoosting); held-out test
ROC-AUC 0.812, PR-AUC 0.678, Brier 0.138. Thresholds are chosen on validation data only (operational 0.18 maximises F2;
high 0.39). Explanations are exact SHAP values over the whole pipeline, described as associations, never causes. Support
actions come from transparent rules independent of the model. The API route calls `RetentionPredictor.predict`; it does not
duplicate any logic. Ramesh's integrated demo prediction is **69.2/100, HIGH** (the backend derives his reimbursement delay as
11.6 days, the mean of his 7 paid claims; the Phase 3 CSV rounds it to 12 days, which the model scores at 70.0 -- the same
participant with a slightly different input, not a discrepancy).

## Integrity detection

All thresholds are in [`app/integrity/config.py`](app/integrity/config.py) (frozen dataclasses, overridable per engine).
Philosophy: one weak rule is a LOW data-quality warning; only several independent signals escalate; no finding says
"fraud".

**A. Visit-level rules** (`visit_rules.py`; completed visits only): missing OTP; entry > 24 h after the visit; visit date
> 7 days from schedule; entry at 23:00–05:00 in the timestamp's own offset; implausible values (SBP 70–250, DBP 40–150,
HR 30–220, weight 25–250, glucose 30–600, SBP ≤ DBP); unparsable/offset-less/inconsistent timestamps; missing mandatory
fields; rapid entry (≥ 5 entries at a site within 15 minutes). A visit with one signal gets one LOW/MEDIUM data-quality
finding; a visit with ≥ 2 signals including a behavioural one gets one `visit.multiple_integrity_signals` finding
(MEDIUM, HIGH at ≥ 3).

**B. Site-level statistics** (`site_stats.py`): each site is compared with the *pooled other sites*, one-sided, α = 0.001,
and only if it has ≥ 20 participants and ≥ 60 completed visits (otherwise a LOW `site.insufficient_data` note).
Retention (binomial; also needs ≥ 15 points excess) · SBP last-digit preference (binomial vs 20% for 0/5; ≥ 15 points excess)
· SBP variance (F-test, ratio ≤ 0.5) · missing-OTP, late-night and delayed-entry rates (Fisher exact, minimum counts).
High retention alone is LOW. Two signals → MEDIUM `site.multiple_integrity_signals`, three or more → HIGH.

**C. ECG duplicates** (`ecg_dupes.py`): 64-bit perceptual hash (`imagehash.phash`), Hamming distance (all pairs, vectorised), connected-component clusters.
Distance 0 = identical, ≤ 4 = near-identical (Phase 3 keeps distinct ECGs ≥ 8 apart). Cross-participant identical → HIGH.
Missing, corrupt, non-image, out-of-root (including symlinks that leave the ECG directory) and **featureless** files become
`ecg.file_unavailable` findings (data quality, MEDIUM: "could not be checked"); the scan continues. A featureless image
(grey-level std below `EcgConfig.min_pixel_std` = 2.0; the Phase 3 ECGs measure 35-91) has an uninformative hash that any other
blank image shares, so it is never clustered: two different blank captures are not a "duplicate". Hashes are cached by
(path, mtime, size). Byte-identical copies have distance 0.

**D. Anomaly signal** (`anomaly.py`): Isolation Forest (200 trees, `random_state` 42, contamination 0.02 *assumed*) over
**participant-level recording profiles** (SD of SBP/DBP/HR/glucose, share of BP values ending in 0/5, SBP range; ≥ 4
visits each; never fewer than 100 profiles). Identifiers are never features. A site is reported only if its participants'
scores are significantly higher than the others' (Mann-Whitney U). A visit-level forest was tried and dropped: it flagged
honest visits that merely had a missing OTP (double counting a rule). Counting outliers per site also failed, because a
coordinated site forms a dense cluster; comparing score distributions works. The signal overlaps the variance/digit
statistics, so treat it as corroboration, not independent evidence.

**E. Hash chain**: see the boundary above.

## Configuration and thresholds

| Area | Field (`IntegrityConfig`) | Default |
|---|---|---|
| visit | `late_entry_hours`, `visit_window_days`, `night_start_hour`/`night_end_hour` | 24, 7, 23/5 |
| visit | `burst_window_minutes`, `burst_min_entries`, `min_signals_for_review` | 15, 5, 2 |
| site | `min_participants`, `min_visits`, `alpha` | 20, 60, 1e-3 |
| site | `retention_min_excess`, `digit_pref_min_excess`, `variance_ratio_max` | 0.15, 0.15, 0.5 |
| site | `otp_min_count`, `night_min_count`, `late_entry_min_count`, `min_signals_for_site_review` | 5, 3, 3, 3 |
| ecg | `identical_max_distance`, `near_max_distance`, `hash_size` | 0, 4, 8 |
| anomaly | `min_rows`, `contamination`, `random_state`, `site_enrichment_alpha` | 100, 0.02, 42, 1e-3 |
| audit | `otp_failure_burst`, `claim_burst_count/minutes`, `overdue_visits_per_patient` | 5, 4/10, 3 |

With five sites and several tests each, an α of 0.001 is a pragmatic guard against false alarms, not a formal
multiple-comparison correction.

## Error handling and reliability

* Model and engine load in the FastAPI lifespan. A load failure does **not** stop the process: `/ready` returns 503 with the
  reason and inference routes return `503 model_unavailable`. No request ever receives a guessed prediction.
* Every failure is a non-2xx JSON error with the request id; unexpected exceptions are logged with a traceback and returned
  as a generic `500` without internals. Inference never mutates model state, so one bad request cannot affect the next.
* Blocking inference runs in a thread pool under a deadline (a timed-out thread cannot be killed; its result is dropped).
  SHAP/sklearn calls are serialised by a lock.
* Logs are one JSON object per line (event, request id, method, path, status, duration). Bodies, entity ids and feature
  values are not logged.
* Request limits: body size, list lengths (events ≤ 5000, open visits ≤ 2000, trial visits ≤ 20000), findings ≤ 1000.
* Body-size enforcement uses the `Content-Length` header; put a proxy limit in front for chunked uploads.

## Testing

```bash
cd ml-service && python -m pytest                # everything: Phase 3 + Phase 4 + Phase 5 (no network)
python -m pytest tests/integrity tests/service   # Phase 5 / 6 only
python -m pytest tests/service/test_http_socket.py   # real uvicorn subprocess + urllib (Ramesh-like request, Site C scan)
python tests/perf/measure_integrity_scan.py --scenario A   # 20k-visit timing (A-E; not part of pytest)
```
Last full run (this branch): **see `docs/phase6/08_PERSON_B_COMPLETION_REPORT.md` §6** for exact counts.

`tests/integrity` — visit rules, site statistics (incl. insufficient data, honest-site false positives), ECG duplicates (with
corrupt/missing files), Isolation Forest, audit rules, and the Phase 3 demo trial (Site C found, honest sites quiet).
`tests/service` — health/ready, risk and integrity contract shapes, validation, request-id propagation, model unavailable,
corrupt artifacts, engine errors, timeouts, auth, body limits, log hygiene.

## Demo workflow

```bash
cd ml-service
python -m app.data_generation.generate_all
python -m app.retention.train                     # → reports/retention/ (Ramesh from the Phase 3 CSV: 70.0/100 HIGH; integrated path: 69.2)
python -m app.integrity.demo                      # → reports/integrity/integrity_demo.{md,json}
uvicorn app.main:app --port 8001
```

On the Phase 3 data the integrity demo flags Site C only: BP digit preference (89% of SBP readings end in 0/5), variance
ratio 0.07, 18 completed visits without OTP (all also late and at night), three rapid-entry clusters of 6, perfect retention
(LOW), and 6 ECG images reused by 4 participants each (Hamming distance 0). 18 of Site C's 480 visits get a visit-level
finding; the honest sites receive nothing above LOW. The report lists the observed limitations.

## Known limitations

* **Synthetic ground truth.** The fraud patterns were injected by the same author as the detectors; success here is a sanity
  check, not a performance estimate. Real fabrication would be subtler.
* **Contract v1.1 is implemented on the Python side and exercised live** (backend suite 19/19 against this service). Participants
  with no resolved reminder history (`missed_reminders = null`) are refused with 422 and fall back to the backend baseline by
  design -- the model is never given an invented value.
* **ECG detection is perceptual-hash based**: it finds re-used or lightly re-encoded images, not an ECG re-drawn from the same
  waveform, and a featureless image is reported as "cannot be checked", not as a duplicate.
* **Recommendations are operational rules, not predictions**: they suggest support actions for the factors present; nothing
  claims an action prevents dropout.
* **Honest-site noise.** Honest sites still raise LOW missing-OTP warnings (~0.6% of visits).
* **Isolation Forest** is a weak, partly redundant signal and works only as a group-level comparison.
* **Retention model:** validation thresholds were optimistic on 300 rows; the operational threshold flags ~51% of
  participants; logistic regression wins because the synthetic labels are logistic. XGBoost is not used (`libomp`).
* Digit-preference and variance tests treat visits as independent, though visits of one participant are correlated.
* Timestamps without a UTC offset are treated as invalid rather than guessed.
* Not validated for clinical, regulatory or HR use.

---

# Phase 3 — synthetic data generation

> All data here is fictional and synthetic.

The generator builds one reproducible dataset for the fictional trial **GLU-301** (Type 2 diabetes, 5 sites in India)
that feeds the dropout-prediction model, the retention dashboards, the trial-integrity detectors and the end-to-end demo.
It does not touch the TypeScript backend or its database.

## Generate the data

Python 3.9+ (tested on 3.9.6). From the repo root, using the existing `.venv-ml`:

```bash
source .venv-ml/bin/activate
pip install -r ml-service/requirements.txt
cd ml-service                         # the working directory must be ml-service/
python -m app.data_generation.generate_all
```

Options: `--output-dir PATH`, `--seed N`, `--no-ecg`, `--skip-reproducibility-check`.
A full run takes ~10 s (it also re-generates everything once into a temp dir to prove reproducibility).
Note: the module path is relative to `ml-service/` (where the `app` package lives), not the repo root.

`neurokit2` is pinned `<0.2.12` because 0.2.12 does not import on Python 3.9.

## Configuration

Everything tunable is in [`app/config.py`](app/config.py) (`TrialConfig`): trial id, seed (42), 2,000 training / 300 demo
participants, 8 visits every 28 days, ₹350 per verified visit, site profiles, dropout coefficients, fraud settings,
Ramesh's profile, ECG flag (`generate_ecg`) and output dir. Override with `dataclasses.replace(cfg, ...)`.

## Output (`generated_data/`, git-ignored except `.gitkeep`)

| File | Content |
|---|---|
| `training/dropout_training.csv` | 2,000 rows: `participant_id, site_id, age, distance_km, daily_wage_worker, scheduled_visits, missed_reminders, reimbursement_delay_days, side_effects_reported, phone_changed, visits_missed, dropped_out` |
| `demo/participants.csv` | 300 rows: id, name, site, sex, age, enrollment date, the same risk features, `dropped_out`, `dropout_visit`, `status` |
| `demo/visits.csv` | 2,400 rows (300 × 8): `visit_id, participant_id, site_id, visit_number, visit_type, scheduled_date, status (completed/missed), device_timestamp, entry_timestamp, otp_verified (1/0, blank if missed), systolic_bp, diastolic_bp, heart_rate, weight_kg, glucose_mg_dl, ecg_id, ecg_file` |
| `demo/sites.csv` | 5 sites (A Roorkee, B Pune, C Nagpur, D Kochi, E Lucknow) |
| `demo/reimbursements.csv` | one ₹350 claim per OTP-verified completed visit, with claim/paid dates and `delay_days` |
| `demo/ecg_metadata.csv` | one row per ECG reference: ids, image file, SHA-256, participant/visit/site, 500 Hz, 10 s |
| `ecgs/ecg_001.png … ecg_030.png` | 30 distinct simulated ECGs (1000×300 px) |
| `metadata/generation_summary.json` | seed, timestamp, counts, class distribution, per-site retention / OTP rate / measurement stats, validation results |
| `metadata/fraud_ground_truth.csv` | which visits had an injected anomaly (for *evaluating* detectors; keep it away from model features) |

IDs: sites `SITE-A…E`; demo participants `P-<site>-<nnn>`; visits `V-<site>-<nnn>-<vv>`; training `T-nnnnn`.
Timestamps are ISO-8601 in IST (`+05:30`). `entry_timestamp` is when the record was keyed in; `device_timestamp` when measured.
The backend stores money as `amount_cents`; these CSVs use whole rupees (`amount_inr`, ₹350 = 35 000 paise).

## Dropout label generation

`P(dropout) = sigmoid(z)`, `dropped_out ~ Bernoulli(P)` — so the label is noisy, never deterministic, and nothing is tuned to a target AUC.

```
z = -2.80 + site_offset
    + 0.70 * (distance_km - 25) / 20
    + 0.50 * daily_wage_worker
    + 0.45 * missed_reminders
    + 0.60 * (reimbursement_delay_days - 6) / 5
    + 0.50 * side_effects_reported
    + 0.80 * phone_changed
    + 0.55 * visits_missed
```

Assumptions: missing numeric inputs are imputed at their reference value inside `z`; `site_offset` (−0.10…+0.20) is
latent and not a feature; the intercept gives a ~26 % dropout rate; features are correlated (daily-wage workers live
farther away and receive later reimbursements; reminders grow with distance); `visits_missed` is drawn *before* the label
(sporadic misses), and capped at 6 of 8, so it cannot encode the outcome. Missingness is injected only in `age` (~1 %) and
`reimbursement_delay_days` (~3 %, "no claim yet"). The training set uses this label process at **all** sites, including Site C,
so a trained model does not learn fraud-site artefacts. `validation.py` checks class balance (15–45 %) and no single feature
with |r| ≥ 0.6 against the label.

In the demo cohort `visits_missed` counts misses *before* dropout only (post-dropout misses are in `visits.csv`), for the same
leakage reason. Ramesh's score is never stored — the trained model must compute it.

## Demo cohort & Ramesh

60 participants per site, enrolled over 8 weeks from 2026-01-05, visits every 28 days; the snapshot date is 2026-11-01 so every
scheduled visit has resolved. A dropout (drawn from the same logistic model + site offset) misses every visit from `dropout_visit` on.

**Ramesh Verma** (`P-A-001`, Roorkee, Site A): 40 km, 2 missed reminders, 12-day reimbursement delay, daily-wage worker, one reported
side effect, visit 4 missed, still active. The generating model gives him P ≈ 0.72 (top ~10 % of the cohort) — high enough
for a retention engine to recommend instant reimbursement and teleconsultation.

| Site | Profile |
|---|---|
| A Roorkee | honest, baseline mix |
| B Pune | honest, more visit-timing jitter, wider BP spread |
| **C Nagpur** | **fraudulent** |
| D Kochi | honest, older, more daily-wage workers, longer distances, lower BP |
| E Lucknow | honest, natural variation, slightly better retention |

## Fraud injection (Site C only, `FraudConfig`)

| Pattern | Implementation | Evidence kept in the data |
|---|---|---|
| ~100 % retention | no dropouts, no missed visits | `participants.dropped_out`, `visits.status` |
| BP digit preference | 85 % of readings snapped to multiples of 5 (≈89 % end in 0/5 vs ≈20 % honest) | `systolic_bp`, `diastolic_bp` |
| Low BP variance | person and visit sd cut to ~2 mmHg (overall sd ≈ 4 vs 11–16 elsewhere) | same |
| ≥ 9 visits without OTP | 18 completed visits flagged `otp_verified = 0` | `visits.otp_verified` |
| Batch, late-night entry | in 3 bursts of 6, keyed 1–3 min apart between 00:30 and 02:00, 4–21 days after the visit | `entry_timestamp` vs `device_timestamp` |
| Reused ECGs | 6 images reused by 4 different participants each (24 refs, 18 reuses) | `ecg_metadata.image_sha256`, `ecg_id` |

Honest sites get ~1 % random OTP failures entered at ordinary hours, never in bursts, and unique ECG images (6 per site,
distinct pHash, ≥ 8 bits apart). Set `FraudConfig(enabled=False)` for a clean trial; each pattern has its own field.

## ECG generation

`neurokit2.ecg_simulate` (500 Hz, 10 s) rendered with Matplotlib to PNG, 30 images total (24 honest + 6 reused at Site C).
Each has its own heart rate (48–120 bpm), amplitude, framing and stroke, re-styled deterministically until its perceptual hash is
≥ 8 bits from every earlier image (when `imagehash` is installed), so honest ECGs don't collide in duplicate detection.
Duplicates are references to the *same file*, hence identical bytes. PNG metadata is stripped so re-runs are byte-identical.
ECG is optional: with `generate_ecg=False`, `--no-ecg`, a missing NeuroKit2 or a rendering failure the pipeline continues, no ECG
references are written, and the summary reports `ecg.status: skipped: …`.

## Validation

Run automatically at the end of generation (and fails loudly with `DataValidationError`): unique ids, valid sites, visit→participant and
reimbursement→visit integrity, no orphans, 8 visits/participant, schedule and timestamp ranges, numeric ranges, 0/1 booleans,
ECG files and metadata links, class balance and leakage, Site C anomalies present, honest-site anomalies absent, Ramesh's profile,
and reproducibility (a second full run into a temp dir must match byte-for-byte; `generated_at` is excluded).
Results are stored in `generation_summary.json`.

## Tests

```bash
cd ml-service && python -m pytest
```

34 tests cover counts, foreign keys, Ramesh, Site C patterns, honest-site variability, ECG files/duplicates/pHash, graceful ECG failure,
reproducibility and the validators' ability to detect corrupted data.

## Retention model (Phase 4)

Dropout-risk model, explanations and support-action rules built on `training/dropout_training.csv`: see [`app/retention/README.md`](app/retention/README.md) (`python -m app.retention.train`).

## Limitations

- Every relationship is an assumption written into the generator; models trained on it learn those assumptions, not biology or real trial behaviour.
- Measurements are person-baseline + noise: no circadian, medication, comorbidity or inter-measurement correlation (e.g. glucose vs weight).
- ECGs are NeuroKit2 simulations of a normal rhythm — no pathology and not usable for ECG analysis.
- Fraud is stylised and easy to see; real misconduct is subtler. Detectors that score well here are not thereby validated.
- Dropout is visit-level absorbing and the demo cohort is a single post-hoc snapshot with no time-varying features.
- Names, sites and institutions are invented; city names are real places used only as locations.
