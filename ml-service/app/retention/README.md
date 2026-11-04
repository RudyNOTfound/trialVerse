# Retention engine — dropout-risk model (Phase 4)

> **Prototype trained on synthetic data. Not validated for real clinical-trial use, and not a clinical decision tool.**
> Reported metrics show how well the model recovers the Phase 3 generator's assumptions, not real-world performance.

Scores a participant's probability of dropping out of the trial (0–100), explains the score, and suggests operational
support actions. It is independent of the TypeScript backend: no API, no database access, no contract changes (that is Phase 5).

## Commands (working directory: `ml-service/`, venv: `.venv-ml`)

```bash
cd ml-service
python -m app.data_generation.generate_all        # Phase 3, once (creates the training CSV)
python -m app.retention.train                     # train + select + evaluate + save + Ramesh demo (~12 s)
python -m pytest                                  # whole suite (Phase 3 + retention): 148 tests
python -m pytest tests/retention                  # retention only: 114 tests
```
Options: `--csv PATH`, `--model-dir PATH`, `--report-dir PATH`, `--seed N`.

```python
from app.retention.predict import RetentionPredictor
p = RetentionPredictor.load()                     # loads models/retention/, never retrains
p.predict({"site_id": "SITE-A", "age": 52, "distance_km": 40, "daily_wage_worker": 1, "missed_reminders": 2,
           "reimbursement_delay_days": 12, "side_effects_reported": 1, "phone_changed": 0, "visits_missed": 1}).to_dict()
```

## Data and target

Input: `generated_data/training/dropout_training.csv` (2,000 rows, 12 columns, produced by Phase 3). Schema is verified on load
(`preprocessing.validate_training_frame`): exact column set, unique ids, 0/1 target with both classes, 0/1 binaries, no nulls outside
`age` / `reimbursement_delay_days`, non-negative counts, `visits_missed <= scheduled_visits`.
**Target** `dropped_out` (1 = left the trial; 26 % of rows).

| Feature | Type | Handling |
|---|---|---|
| `age`, `reimbursement_delay_days` | numeric, may be missing (~1 %, ~3 %) | median-impute → standardise |
| `distance_km`, `missed_reminders`, `visits_missed` | numeric | standardise |
| `daily_wage_worker`, `side_effects_reported`, `phone_changed` | binary | passed through |
| `site_id` | categorical | one-hot, unknown sites → all zeros |
| `participant_id` | identifier | **never a feature** |
| `scheduled_visits` | constant (8) | dropped (no signal); only used to validate `visits_missed` at inference |

`visits_missed` keeps its Phase 3 meaning — misses *before* any dropout — and is never rebuilt from `visits.csv`.

## Method

- **Preprocessing leakage:** one scikit-learn `Pipeline` (`ColumnTransformer` + classifier); the split happens on raw rows *before* any
  imputation/scaling/encoding, and all statistics are fitted on the training split only (tested).
- **Split:** stratified 70 / 15 / 15 (1,400 / 300 / 300; seed 42). 2,000 rows is small, so the test set holds ~78 dropouts and the metrics are
  noisy; 95 % bootstrap intervals are reported. The test split is used once, after model and thresholds are frozen (tested by spying on every metric call).
- **Models compared (13 configurations, trained on train, scored on validation):** most-frequent `DummyClassifier`; `LogisticRegression`
  (C ∈ {0.01, 0.1, 1, 10}); `HistGradientBoostingClassifier` (8 combos of learning rate, depth, iterations).
  XGBoost is listed in `requirements.txt` and installed, but **cannot be loaded in this environment** (`libomp.dylib` is missing; `brew install libomp`
  would fix it), so HistGradientBoosting is the documented tree-ensemble alternative. No class weighting: probabilities should stay calibrated and imbalance
  (26 %) is mild; the trade-off is handled by the threshold instead.
- **Selection rule:** highest validation PR-AUC among non-baseline models, ties to the lower Brier score. Accuracy is not used.

## Results (computed by `train.py`; see `reports/retention/`)

Validation (used for selection):

| Model | Params | ROC-AUC | PR-AUC | Brier |
|---|---|---|---|---|
| Dummy (most frequent) | – | 0.500 | 0.260 | 0.260 |
| **Logistic regression (selected)** | C = 10 | 0.875 | 0.761 | 0.116 |
| HistGradientBoosting | lr 0.1, depth 2, 100 iter | 0.851 | 0.696 | 0.126 |

Held-out test (n = 300, 26.0 % dropouts) for the selected model: **ROC-AUC 0.812** (95 % CI 0.749–0.871), **PR-AUC 0.678** (0.568–0.768; no-skill = 0.260),
**Brier 0.138**, expected calibration error 0.044 (`calibration_curve.png`). On test, the boosting model scored 0.809 / 0.643 / 0.140 — no better.

| Threshold | Value | Precision | Recall | F1 | TP | FP | FN | TN | Flagged |
|---|---|---|---|---|---|---|---|---|---|
| Default | 0.50 | 0.638 | 0.474 | 0.544 | 37 | 21 | 41 | 201 | 19 % |
| **Operational** | 0.18 | 0.422 | 0.833 | 0.560 | 65 | 89 | 13 | 133 | 51 % |
| High-risk | 0.39 | 0.573 | 0.603 | 0.587 | 47 | 35 | 31 | 187 | 27 % |

**Threshold selection (validation data only).** A false negative is an at-risk participant who gets no extra support; a false positive is someone who receives an
unnecessary, cheap, non-clinical check-in. The operational threshold maximises F2 (recall weighted twice as much as precision) → **0.18**; at 0.5 the model misses
more than half of the dropouts. The "high" threshold is the lowest one above it whose validation precision reaches 0.75 → **0.39**. Risk levels:
`low` < 0.18 ≤ `medium` < 0.39 ≤ `high`. Cost: the operational threshold flags about half of all participants — appropriate only if support actions are cheap.

**Honest caveats:** (1) validation-chosen figures were optimistic on test (e.g. precision at the high threshold 0.75 → 0.573; recall at the operational threshold 0.91 → 0.83): the thresholds were
tuned on only 300 rows. (2) Logistic regression winning is expected, because the Phase 3 labels *are* generated from a logistic model; it says nothing about which model suits real data.
(3) Age has ~no attribution because the generator ignores it.

## Explainability

Exact SHAP (`shap.explainers.Exact`) over the whole pipeline, as a black box (HistGradientBoosting is not supported by `TreeExplainer`, and the exact method is cheap with 9 raw features). Attributions
are per *original* feature (site is one feature), in risk-score points, with an interventional background of 50 training rows. Each explanation is checked for additivity
(baseline + contributions = model output, tolerance 1e-4); on failure the prediction still returns, with `explanation_status: "unavailable"` and no invented factors. Contributions below 0.5 points are omitted and
the top 5 are shown (`top_risk_factors`, plus `protective_factors`). They are statistical attributions of the model's output, **not evidence of causation**; every response carries that note.
Global importance (mean |SHAP|, test sample): distance 10.9, missed reminders 6.1, daily-wage 4.6, previous missed visits 4.6, reimbursement delay 3.8, side effects 2.9, phone changed 2.1, site 1.0, age 0.2.

## Intervention rules (`interventions.py`, independent of the model)

| Trigger (raw values) | `action_type` | Suggested support |
|---|---|---|
| distance ≥ 30 km | `remote_or_home_visit` | teleconsultation or home visit |
| daily-wage worker | `flexible_scheduling` | flexible visit scheduling |
| missed reminders ≥ 2 | `reminder_escalation` | more frequent reminders / IVR |
| reimbursement delay ≥ 10 days | `reimbursement_priority` | prioritise reimbursement (instant payout where possible) |
| side effects reported | `clinician_follow_up` | clinician follow-up call (routed, not handled here) |
| phone changed | `verify_contact_details` | verify and update contact details |
| visits missed ≥ 1 | `coordinator_follow_up` | coordinator follow-up |

Thresholds are in `config.InterventionThresholds`. Output: `{action_type, title, reason, priority}`. Not everyone gets everything: a rule only fires if its condition holds, and a *low*-risk participant only
gets actions for factors the model also flags. Priority is `high` if risk is high and the factor is a top-2 model driver, else `medium`/`low`. Wording is supportive and operational; the tests reject clinical/punitive language.

## Ramesh demo (`reports/retention/ramesh_demo.{md,json}`)

Features are read from `generated_data/demo/participants.csv` (name lookup, nothing hard-coded): SITE-A (Roorkee), 52 y, 40 km, daily-wage worker, 2 missed reminders, 12-day reimbursement delay, side effects reported, 1 missed visit.
Model output (Phase 3 CSV inputs, 12-day delay): **risk score 70.0 / 100 — HIGH** (69.2 in the integrated path, where the backend derives an 11.6-day delay from his 7 paid claims) (cohort baseline 25.5). Top factors: missed reminders (+10.5), reimbursement delay (+10.4), daily-wage (+8.7), distance (+8.5), side effects (+7.8). Recommended: reminder escalation [high],
reimbursement priority incl. instant payout [high], teleconsultation/home visit, flexible scheduling, clinician follow-up, coordinator follow-up [medium]. The score is whatever the trained model returns; nothing is forced.

## Input validation

`schemas.ParticipantFeatures` (pydantic) rejects, with `InvalidInputError` naming the field: missing required fields, unknown fields (including `dropped_out`), negative or non-finite numbers, numeric strings and booleans in numeric fields,
non-0/1 binaries, non-integer counts, `visits_missed > scheduled_visits`, empty site, non-mapping input. `age` and `reimbursement_delay_days` may be omitted/null (a warning is returned; the training median is used). Unseen sites are accepted
with a warning. numpy scalars (e.g. from a pandas row) are accepted.

## Artifacts (`models/retention/`, `reports/retention/`)

`pipeline.joblib` (fitted preprocessing + model), `metadata.json` (version, selected params, thresholds, feature schema, seed, config, data SHA-256, split sizes, metrics, library versions),
`explainer_background.csv` (50 training rows). Reports: `metrics.json`, `evaluation_report.md`, `calibration_curve.png`, `feature_importance.{csv,json}`, `ramesh_demo.{json,md}`. Version string: `1.0.0+<family>.<data hash>`.
Loading warns if the scikit-learn version differs from training. Training is deterministic: two runs give byte-identical `metrics.json` (tested).

## Limitations

- Synthetic data whose labels come from a known logistic formula: performance, the model ranking, and the feature importances reflect that formula and are not evidence about real trials.
- Small data (300-row validation/test sets): wide intervals, optimistic validation-selected thresholds; no cross-validation or nested tuning.
- Static features; no time dimension, no site-level effects beyond one-hot (site offsets in the generator are latent and only weakly recoverable).
- Predicted probabilities are not guaranteed calibrated for other populations; no fairness analysis; no clinical validation.
- Intervention rules are heuristics with fixed thresholds, not tested for effectiveness.
