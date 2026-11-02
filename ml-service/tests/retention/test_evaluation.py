import numpy as np
import pytest
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from app.retention import evaluate
from app.retention.config import RetentionConfig

Y = np.array([1, 1, 1, 0, 0, 0, 0, 0])
P = np.array([0.9, 0.6, 0.3, 0.7, 0.4, 0.2, 0.1, 0.05])


def test_confusion_and_threshold_metrics_by_hand():
    assert evaluate.confusion(Y, P, 0.5) == {"tp": 2, "fn": 1, "fp": 1, "tn": 4}
    m = evaluate.threshold_metrics(Y, P, 0.5)
    assert m["precision"] == pytest.approx(2 / 3) and m["recall"] == pytest.approx(2 / 3) and m["f1"] == pytest.approx(2 / 3)
    assert m["specificity"] == pytest.approx(0.8) and m["accuracy"] == pytest.approx(6 / 8) and m["flagged_share"] == pytest.approx(3 / 8)


def test_threshold_is_inclusive_and_degenerate_cases_do_not_divide_by_zero():
    assert evaluate.confusion(Y, P, 0.9)["tp"] == 1
    m = evaluate.threshold_metrics(Y, P, 0.99)               # nothing flagged
    assert m["precision"] == 0.0 and m["recall"] == 0.0 and m["f1"] == 0.0


def test_compute_metrics_matches_sklearn_and_is_not_hardcoded():
    m = evaluate.compute_metrics(Y, P, {"default_0.5": 0.5})
    assert m["roc_auc"] == pytest.approx(roc_auc_score(Y, P)) and m["pr_auc"] == pytest.approx(average_precision_score(Y, P))
    assert m["brier"] == pytest.approx(brier_score_loss(Y, P))
    m2 = evaluate.compute_metrics(Y, np.clip(P[::-1], 0, 1), {"default_0.5": 0.5})
    assert m2["roc_auc"] != m["roc_auc"]                      # changes with the predictions
    assert m["prevalence"] == pytest.approx(3 / 8) and m["n"] == 8


def test_calibration_summary_perfectly_and_badly_calibrated():
    rng = np.random.default_rng(0)
    p = rng.random(5000)
    y = (rng.random(5000) < p).astype(int)
    assert evaluate.calibration_summary(y, p, 10)["ece"] < 0.05
    assert evaluate.calibration_summary(y, np.clip(p * 0.2, 0, 1), 10)["ece"] > 0.15
    const = evaluate.calibration_summary(np.array([0, 1, 0, 1]), np.full(4, 0.5))
    assert const["ece"] == 0.0 and len(const["bins"]) == 1


def test_bootstrap_ci_is_seeded_and_brackets_estimate():
    rng = np.random.default_rng(1)
    p = rng.random(300)
    y = (rng.random(300) < p).astype(int)
    a = evaluate.bootstrap_ci(y, p, roc_auc_score, 200, 7)
    assert a == evaluate.bootstrap_ci(y, p, roc_auc_score, 200, 7)
    assert a["lower"] <= a["estimate"] <= a["upper"]


def test_select_thresholds_uses_recall_weighted_criterion_on_given_data_only():
    rng = np.random.default_rng(3)
    p = rng.random(1000)
    y = (rng.random(1000) < p ** 2).astype(int)
    f2 = evaluate.select_thresholds(y, p, RetentionConfig(f_beta=2.0))
    f05 = evaluate.select_thresholds(y, p, RetentionConfig(f_beta=0.5))
    assert f2["operational_threshold"] < f05["operational_threshold"]       # caring about recall lowers the bar
    assert f2["operational_threshold"] != 0.5
    assert f2["high_threshold"] > f2["operational_threshold"]
    assert f2["validation_at_operational"]["recall"] > f05["validation_at_operational"]["recall"]
    # the chosen operational threshold really is the grid optimum
    lo, hi, step = RetentionConfig().threshold_grid
    best = max(np.round(np.arange(lo, hi + 1e-9, step), 4),
               key=lambda t: (evaluate._fbeta(*[evaluate.threshold_metrics(y, p, t)[k] for k in ("precision", "recall")], 2.0), t))
    assert f2["operational_threshold"] == pytest.approx(best)


def test_high_threshold_precision_target_and_fallback():
    y = np.array([0, 1] * 50)
    p_uninformative = np.full(100, 0.5)
    r = evaluate.select_thresholds(y, p_uninformative, RetentionConfig())
    assert r["high_threshold_fallback_used"] is True
    p_sep = np.full(100, 0.2)                                      # negatives; half the positives score high, the rest sit just above
    pos = np.flatnonzero(y == 1)
    p_sep[pos[:25]], p_sep[pos[25:]] = 0.3, 0.9
    r = evaluate.select_thresholds(y, p_sep, RetentionConfig())
    assert r["high_threshold_fallback_used"] is False and r["validation_at_high"]["precision"] >= 0.75
    assert r["operational_threshold"] < r["high_threshold"]


def test_trained_model_metrics_are_computed_from_predictions(trained):
    s = trained["summary"]
    assert 0.5 < s["test"]["roc_auc"] < 1 and s["test"]["pr_auc"] > s["test"]["prevalence"]
    cm = s["test"]["at_threshold"]["operational"]["confusion_matrix"]
    assert sum(cm.values()) == s["test"]["n"] and cm["tp"] + cm["fn"] == round(s["test"]["prevalence"] * s["test"]["n"])
    # the dummy baseline is a no-skill model
    dummy = next(r for r in s["comparison"] if r["family"] == "dummy_most_frequent")
    assert dummy["val_roc_auc"] == 0.5 and dummy["val_recall_at_0.5"] == 0.0
