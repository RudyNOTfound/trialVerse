import dataclasses
import json

import numpy as np
import pytest

from app.retention import evaluate, preprocessing, train
from app.retention.config import RetentionConfig
from app.retention.predict import RetentionPredictor
from app.retention.train import run_training


def test_candidates_include_baseline_logistic_and_boosting():
    fams = {c["family"] for c in train.candidate_models(RetentionConfig())}
    assert fams == {"dummy_most_frequent", "logistic_regression", "hist_gradient_boosting"}
    dummy = next(c for c in train.candidate_models(RetentionConfig()) if c["family"] == "dummy_most_frequent")["make"]()
    assert dummy.strategy == "most_frequent"


def test_select_best_ignores_dummy_and_breaks_ties_on_brier():
    rows = [{"family": "dummy_most_frequent", "val_pr_auc": 0.99, "val_brier": 0.0},
            {"family": "a", "val_pr_auc": 0.7, "val_brier": 0.2}, {"family": "b", "val_pr_auc": 0.7, "val_brier": 0.1},
            {"family": "c", "val_pr_auc": 0.6, "val_brier": 0.01}]
    assert train.select_best(rows)["family"] == "b"


def test_xgboost_not_required_and_fallback_documented():
    # The primary candidate is HistGradientBoosting (XGBoost needs libomp, which may be absent).
    assert not any("xgboost" in c["family"] for c in train.candidate_models(RetentionConfig()))


def test_training_produces_all_artifacts_and_reports(trained):
    for f in ("pipeline.joblib", "metadata.json", "explainer_background.csv"):
        assert (trained["model_dir"] / f).exists()
    for f in ("metrics.json", "evaluation_report.md", "calibration_curve.png", "feature_importance.csv", "ramesh_demo.json", "ramesh_demo.md"):
        assert (trained["report_dir"] / f).exists()
    meta = json.loads((trained["model_dir"] / "metadata.json").read_text())
    assert meta["random_seed"] == 42 and meta["model_version"] and set(meta["thresholds"]) >= {"operational_threshold", "high_threshold"}
    assert "participant_id" in meta["features"]["excluded"] and "participant_id" not in meta["features"]["model_features"]
    assert meta["library_versions"]["scikit-learn"]
    assert "not validated" in meta["prototype_notice"].lower()


def test_split_sizes_and_no_row_overlap(trained, small_df):
    sizes = trained["summary"]["split_sizes"]
    assert sum(sizes.values()) == len(small_df)
    assert sizes["test"] == sizes["val"] and sizes["train"] > 3 * sizes["val"]


def test_test_split_is_not_used_for_selection_or_thresholds(small_df, fast_cfg, tmp_path, monkeypatch):
    """Spy on every metric/threshold call: before the model is frozen only validation labels may be seen."""
    splits = preprocessing.make_split(small_df, fast_cfg)
    val_y, test_y = tuple(splits["val"]["dropped_out"]), tuple(splits["test"]["dropped_out"])
    assert val_y != test_y
    events = []
    orig_cm, orig_sel = evaluate.compute_metrics, evaluate.select_thresholds
    monkeypatch.setattr(evaluate, "compute_metrics", lambda y, p, *a, **k: (events.append(("metrics", tuple(np.asarray(y)))), orig_cm(y, p, *a, **k))[1])
    monkeypatch.setattr(evaluate, "select_thresholds", lambda y, p, *a, **k: (events.append(("thresholds", tuple(np.asarray(y)))), orig_sel(y, p, *a, **k))[1])
    run_training(small_df, fast_cfg, tmp_path / "m", tmp_path / "r", with_importance=False)
    first_test = next(i for i, (_, y) in enumerate(events) if y == test_y)
    assert all(y == val_y for _, y in events[:first_test])                       # candidates + thresholds: validation only
    assert any(k == "thresholds" for k, _ in events[:first_test])                # thresholds were frozen before testing
    assert all(k == "metrics" for k, y in events if y == test_y)                 # test labels only ever scored, never tuned on


def test_selected_model_is_best_on_validation(trained):
    s = trained["summary"]
    non_dummy = [r for r in s["comparison"] if r["family"] != "dummy_most_frequent"]
    assert s["selected"]["val_pr_auc"] == max(r["val_pr_auc"] for r in non_dummy)
    assert s["selected"]["val_pr_auc"] > next(r for r in s["comparison"] if r["family"] == "dummy_most_frequent")["val_pr_auc"]


def test_training_is_reproducible(small_df, fast_cfg, tmp_path):
    a = run_training(small_df, fast_cfg, tmp_path / "m1", tmp_path / "r1", with_importance=False)
    b = run_training(small_df, fast_cfg, tmp_path / "m2", tmp_path / "r2", with_importance=False)
    assert (tmp_path / "r1" / "metrics.json").read_bytes() == (tmp_path / "r2" / "metrics.json").read_bytes()
    pa, pb = RetentionPredictor.load(tmp_path / "m1", fast_cfg), RetentionPredictor.load(tmp_path / "m2", fast_cfg)
    f = {"site_id": "SITE-B", "age": 50, "distance_km": 33.0, "daily_wage_worker": 1, "missed_reminders": 2,
         "reimbursement_delay_days": 9, "side_effects_reported": 0, "phone_changed": 1, "visits_missed": 1}
    assert pa.predict_proba(f) == pb.predict_proba(f)
    assert a["selected"]["params"] == b["selected"]["params"]
    c = run_training(small_df, dataclasses.replace(fast_cfg, seed=7), tmp_path / "m3", tmp_path / "r3", with_importance=False)
    assert c["split_sizes"] == a["split_sizes"] and c["test"]["roc_auc"] != a["test"]["roc_auc"]   # the seed matters


def test_training_rejects_invalid_data(small_df, fast_cfg, tmp_path):
    with pytest.raises(preprocessing.SchemaError):
        run_training(small_df.drop(columns="age"), fast_cfg, tmp_path / "m", tmp_path / "r")
