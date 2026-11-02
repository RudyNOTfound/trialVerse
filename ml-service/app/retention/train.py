"""Train, select, evaluate and save the retention model.

    cd ml-service && python -m app.retention.train
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import itertools
import json
import logging
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

from app.retention import evaluate, preprocessing
from app.retention.artifacts import library_versions, save_artifacts
from app.retention.config import (BINARY_FEATURES, CATEGORICAL_FEATURES, ID_COLUMN, MODEL_FEATURES, NUMERIC_FEATURES,
                                  TARGET, RetentionConfig)
from app.retention.explain import RetentionExplainer
from app.retention.predict import RetentionPredictor, load_ramesh_features
from app.retention.report import write_reports

log = logging.getLogger("retention.train")


def candidate_models(cfg: RetentionConfig) -> List[Dict[str, Any]]:
    """Baseline, interpretable baseline and primary candidate configurations (hyper-parameter grids)."""
    cands: List[Dict[str, Any]] = [{"family": "dummy_most_frequent", "params": {},
                                    "make": lambda: DummyClassifier(strategy="most_frequent")}]
    for C in cfg.lr_C:
        cands.append({"family": "logistic_regression", "params": {"C": C},
                      "make": lambda C=C: LogisticRegression(C=C, max_iter=2000, random_state=cfg.seed)})
    for lr, depth, iters in itertools.product(cfg.hgb_learning_rate, cfg.hgb_max_depth, cfg.hgb_max_iter):
        cands.append({"family": "hist_gradient_boosting",
                      "params": {"learning_rate": lr, "max_depth": depth, "max_iter": iters},
                      "make": lambda lr=lr, depth=depth, iters=iters: HistGradientBoostingClassifier(
                          learning_rate=lr, max_depth=depth, max_iter=iters, l2_regularization=1.0, min_samples_leaf=40,
                          early_stopping=False, random_state=cfg.seed)})
    return cands


def select_best(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Highest validation PR-AUC among non-baseline candidates; ties go to the lower Brier score."""
    pool = [r for r in results if r["family"] != "dummy_most_frequent"]
    return sorted(pool, key=lambda r: (-round(r["val_pr_auc"], 9), r["val_brier"]))[0]


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_training(df: pd.DataFrame, cfg: RetentionConfig, model_dir: Path, report_dir: Path,
                 data_path: Optional[Path] = None, demo_csv: Optional[Path] = None,
                 with_importance: bool = True) -> Dict[str, Any]:
    """Full pipeline on an in-memory validated frame. Returns a summary dict (also written to disk)."""
    preprocessing.validate_training_frame(df)
    splits = preprocessing.make_split(df, cfg)
    Xy = {k: preprocessing.split_features_target(v) for k, v in splits.items()}
    (X_tr, y_tr), (X_va, y_va), (X_te, y_te) = Xy["train"], Xy["val"], Xy["test"]
    assert not set(splits["train"][ID_COLUMN]) & (set(splits["val"][ID_COLUMN]) | set(splits["test"][ID_COLUMN]))
    assert not set(splits["val"][ID_COLUMN]) & set(splits["test"][ID_COLUMN])

    # 1) Fit every candidate on TRAIN, score on VALIDATION. The test split is not touched here.
    results, fitted = [], []
    for cand in candidate_models(cfg):
        pipe = preprocessing.build_pipeline(cand["make"]()).fit(X_tr, y_tr)
        p = pipe.predict_proba(X_va)[:, 1]
        m = evaluate.compute_metrics(y_va, p, {"default_0.5": 0.5}, cfg.calibration_bins)
        results.append({"family": cand["family"], "params": cand["params"], "val_roc_auc": m["roc_auc"],
                        "val_pr_auc": m["pr_auc"], "val_brier": m["brier"],
                        "val_f1_at_0.5": m["at_threshold"]["default_0.5"]["f1"],
                        "val_recall_at_0.5": m["at_threshold"]["default_0.5"]["recall"]})
        fitted.append(pipe)
    best = select_best(results)
    best_idx = results.index(best)
    pipeline = fitted[best_idx]
    best_per_family = {}
    for i, r in enumerate(results):
        cur = best_per_family.get(r["family"])
        if cur is None or (-r["val_pr_auc"], r["val_brier"]) < (-results[cur]["val_pr_auc"], results[cur]["val_brier"]):
            best_per_family[r["family"]] = i

    # 2) Thresholds from validation predictions of the selected model.
    p_val = pipeline.predict_proba(X_va)[:, 1]
    thresholds = evaluate.select_thresholds(y_va, p_val, cfg)
    t_named = {"default_0.5": 0.5, "operational": thresholds["operational_threshold"], "high": thresholds["high_threshold"]}
    val_metrics = evaluate.compute_metrics(y_va, p_val, t_named, cfg.calibration_bins)

    # 3) One-time evaluation on the held-out test split (selection and thresholds are already frozen).
    p_te = pipeline.predict_proba(X_te)[:, 1]
    test_metrics = evaluate.compute_metrics(y_te, p_te, t_named, cfg.calibration_bins)
    test_metrics["roc_auc_ci95"] = evaluate.bootstrap_ci(y_te, p_te, roc_auc_score, cfg.bootstrap_resamples, cfg.seed)
    test_metrics["pr_auc_ci95"] = evaluate.bootstrap_ci(y_te, p_te, average_precision_score, cfg.bootstrap_resamples, cfg.seed)
    family_test = {}  # descriptive only, reported after the decision was made
    for fam, i in best_per_family.items():
        pf = fitted[i].predict_proba(X_te)[:, 1]
        family_test[fam] = {"params": results[i]["params"],
                            **{k: v for k, v in evaluate.compute_metrics(y_te, pf, {"default_0.5": 0.5}, cfg.calibration_bins).items()
                               if k in ("roc_auc", "pr_auc", "brier")},
                            "at_default_0.5": evaluate.threshold_metrics(y_te, pf, 0.5)}

    # 4) Explanations: background sample + global importance (test rows, descriptive).
    background = X_tr.sample(n=min(cfg.shap_background_rows, len(X_tr)), random_state=cfg.seed)
    known_sites = sorted(X_tr["site_id"].unique())
    importance = None
    if with_importance:
        try:
            explainer = RetentionExplainer(pipeline, background, known_sites)
            sample = X_te.sample(n=min(cfg.importance_rows, len(X_te)), random_state=cfg.seed)
            importance = explainer.global_importance(sample)
        except Exception as exc:  # report honestly instead of fabricating
            log.warning("global importance unavailable: %s", exc)

    # 5) Save artifacts.
    data_hash = _sha256(data_path) if data_path else hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()
    model_version = f"{cfg.model_version_base}+{best['family']}.{data_hash[:8]}"
    metadata = {
        "model_name": "retention-dropout-risk", "model_version": model_version, "selected_family": best["family"],
        "selected_params": best["params"], "random_seed": cfg.seed, "target": TARGET,
        "prototype_notice": "Trained on synthetic data. Prototype only; not validated for clinical-trial use.",
        "thresholds": {k: thresholds[k] for k in ("operational_threshold", "high_threshold", "high_threshold_fallback_used", "criterion")},
        "features": {"model_features": list(MODEL_FEATURES), "numeric": list(NUMERIC_FEATURES), "binary": list(BINARY_FEATURES),
                     "categorical": list(CATEGORICAL_FEATURES), "optional_inputs": ["age", "reimbursement_delay_days"],
                     "excluded": [ID_COLUMN, TARGET, "scheduled_visits"], "known_sites": known_sites},
        "data": {"path": None if data_path is None else Path(data_path).name, "sha256": data_hash, "rows": int(len(df)),
                 "split_sizes": {k: int(len(v)) for k, v in splits.items()},
                 "prevalence": {k: float(v[TARGET].mean()) for k, v in splits.items()}},
        "training_config": json.loads(json.dumps(dataclasses.asdict(cfg), default=str)),
        "validation_metrics": {k: val_metrics[k] for k in ("roc_auc", "pr_auc", "brier")},
        "test_metrics": {k: test_metrics[k] for k in ("roc_auc", "pr_auc", "brier")},
        "library_versions": library_versions(),
    }
    paths = save_artifacts(model_dir, pipeline, metadata, background)

    # 6) Reload from disk (proves the artifact round-trip) and produce the Ramesh demo.
    predictor = RetentionPredictor.load(model_dir, cfg)
    demo = None
    try:
        feats = load_ramesh_features(cfg, demo_csv)
        demo = {"input": feats, "prediction": predictor.predict(feats).to_dict()}
    except FileNotFoundError as exc:
        log.warning("Ramesh demo skipped: %s", exc)

    summary = {"model_version": model_version, "selected": best, "comparison": results, "best_per_family": {f: results[i] for f, i in best_per_family.items()},
               "thresholds": thresholds, "validation": val_metrics, "test": test_metrics, "test_by_family": family_test,
               "split_sizes": metadata["data"]["split_sizes"], "importance": None if importance is None else importance.to_dict("records"),
               "ramesh_demo": demo, "artifacts": {k: str(v) for k, v in paths.items()}}
    write_reports(report_dir, summary, p_te, y_te)
    return summary


def main(argv: Optional[list] = None) -> None:
    """CLI entry point."""
    ap = argparse.ArgumentParser(description="Train and evaluate the retention (dropout-risk) model.")
    ap.add_argument("--csv", type=Path, default=None)
    ap.add_argument("--model-dir", type=Path, default=None)
    ap.add_argument("--report-dir", type=Path, default=None)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    warnings.filterwarnings("ignore", category=UserWarning)
    cfg = RetentionConfig()
    if args.seed is not None:
        cfg = dataclasses.replace(cfg, seed=args.seed)
    csv = args.csv or cfg.training_csv
    df = preprocessing.load_training_data(csv)
    s = run_training(df, cfg, args.model_dir or cfg.model_dir, args.report_dir or cfg.report_dir, data_path=csv)
    t = s["test"]
    log.info("selected %s %s | test ROC-AUC %.3f PR-AUC %.3f Brier %.3f | operational threshold %.2f",
             s["selected"]["family"], s["selected"]["params"], t["roc_auc"], t["pr_auc"], t["brier"],
             s["thresholds"]["operational_threshold"])
    if s["ramesh_demo"]:
        p = s["ramesh_demo"]["prediction"]
        log.info("Ramesh: risk %.1f (%s)", p["risk_score"], p["risk_level"])


if __name__ == "__main__":
    main()
