"""Metrics, calibration, bootstrap intervals and threshold selection. Every number is computed from predictions."""
from __future__ import annotations

from typing import Callable, Dict, Optional

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from app.retention.config import RetentionConfig


def confusion(y_true: np.ndarray, proba: np.ndarray, threshold: float) -> Dict[str, int]:
    """tn/fp/fn/tp for `proba >= threshold`."""
    y = np.asarray(y_true).astype(int)
    pred = (np.asarray(proba) >= threshold).astype(int)
    return {"tn": int(((y == 0) & (pred == 0)).sum()), "fp": int(((y == 0) & (pred == 1)).sum()),
            "fn": int(((y == 1) & (pred == 0)).sum()), "tp": int(((y == 1) & (pred == 1)).sum())}


def threshold_metrics(y_true: np.ndarray, proba: np.ndarray, threshold: float) -> Dict[str, object]:
    """Precision / recall / F1 / specificity / accuracy and the confusion matrix at one threshold."""
    c = confusion(y_true, proba, threshold)
    tp, fp, fn, tn = c["tp"], c["fp"], c["fn"], c["tn"]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"threshold": float(threshold), "precision": precision, "recall": recall, "f1": f1,
            "specificity": tn / (tn + fp) if tn + fp else 0.0, "accuracy": (tp + tn) / max(1, len(y_true)),
            "flagged_share": (tp + fp) / max(1, len(y_true)), "confusion_matrix": c}


def calibration_summary(y_true: np.ndarray, proba: np.ndarray, n_bins: int = 8) -> Dict[str, object]:
    """Quantile-binned reliability table and expected calibration error (ECE)."""
    y, p = np.asarray(y_true).astype(float), np.asarray(proba, dtype=float)
    edges = np.unique(np.quantile(p, np.linspace(0, 1, n_bins + 1)))
    if len(edges) < 3:  # constant predictions: a single bin
        return {"bins": [{"mean_predicted": float(p.mean()), "observed_rate": float(y.mean()), "n": int(len(y))}],
                "ece": float(abs(p.mean() - y.mean()))}
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, len(edges) - 2)
    bins, ece = [], 0.0
    for b in range(len(edges) - 1):
        m = idx == b
        if not m.any():
            continue
        bins.append({"mean_predicted": float(p[m].mean()), "observed_rate": float(y[m].mean()), "n": int(m.sum())})
        ece += m.mean() * abs(p[m].mean() - y[m].mean())
    return {"bins": bins, "ece": float(ece)}


def compute_metrics(y_true: np.ndarray, proba: np.ndarray, thresholds: Dict[str, float], n_bins: int = 8) -> Dict[str, object]:
    """Threshold-free metrics plus threshold metrics at every named threshold (e.g. default 0.5, operational)."""
    y = np.asarray(y_true).astype(int)
    return {
        "n": int(len(y)), "prevalence": float(y.mean()),
        "roc_auc": float(roc_auc_score(y, proba)), "pr_auc": float(average_precision_score(y, proba)),
        "brier": float(brier_score_loss(y, proba)),
        "calibration": calibration_summary(y, proba, n_bins),
        "at_threshold": {name: threshold_metrics(y, proba, t) for name, t in thresholds.items()},
    }


def bootstrap_ci(y_true: np.ndarray, proba: np.ndarray, metric: Callable[[np.ndarray, np.ndarray], float],
                 n_resamples: int, seed: int, alpha: float = 0.05) -> Dict[str, float]:
    """Percentile bootstrap interval (seeded) - the test set is small, so point estimates are noisy."""
    rng = np.random.default_rng(seed)
    y, p = np.asarray(y_true), np.asarray(proba)
    vals = []
    for _ in range(n_resamples):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() == y[i].max():
            continue
        vals.append(metric(y[i], p[i]))
    lo, hi = np.quantile(vals, [alpha / 2, 1 - alpha / 2])
    return {"estimate": float(metric(y, p)), "lower": float(lo), "upper": float(hi), "resamples": len(vals)}


def _fbeta(precision: float, recall: float, beta: float) -> float:
    denom = beta ** 2 * precision + recall
    return (1 + beta ** 2) * precision * recall / denom if denom else 0.0


def select_thresholds(y_val: np.ndarray, p_val: np.ndarray, cfg: RetentionConfig) -> Dict[str, object]:
    """Choose thresholds from *validation* predictions only.

    operational: maximises F-beta (beta=cfg.f_beta, default 2, i.e. recall-weighted) - the boundary of "needs support".
    high: smallest grid threshold above `operational` whose validation precision >= cfg.high_precision_target
          (falls back to the midpoint between operational and 1.0 if never reached).
    Ties go to the higher threshold (fewer participants flagged).
    """
    lo, hi, step = cfg.threshold_grid
    grid = np.round(np.arange(lo, hi + 1e-9, step), 4)
    rows = [threshold_metrics(y_val, p_val, t) for t in grid]
    scores = np.array([_fbeta(r["precision"], r["recall"], cfg.f_beta) for r in rows])
    best = int(len(scores) - 1 - np.argmax(scores[::-1]))  # last index of the max (higher threshold wins ties)
    t_op = float(grid[best])
    high = next((float(r["threshold"]) for r in rows if r["threshold"] > t_op and r["precision"] >= cfg.high_precision_target), None)
    high_fallback = high is None
    t_high = high if high is not None else round((t_op + 1.0) / 2, 4)
    return {
        "operational_threshold": t_op, "high_threshold": t_high, "high_threshold_fallback_used": high_fallback,
        "criterion": f"operational = argmax F{cfg.f_beta:g} on validation; high = lowest threshold above it with "
                     f"validation precision >= {cfg.high_precision_target}",
        "validation_at_operational": rows[best],
        "validation_at_high": threshold_metrics(y_val, p_val, t_high),
    }
