"""Fixtures for the retention tests: a small Phase 3 dataset and a quickly trained model (no network, no disk artifacts)."""
from __future__ import annotations

import dataclasses

import pytest

from app.config import default_config
from app.data_generation.participants import generate_demo_participants, generate_training_data
from app.retention.config import RetentionConfig
from app.retention.train import run_training

@pytest.fixture(scope="session")
def small_df() -> pd.DataFrame:
    return generate_training_data(default_config(n_training_participants=900))


@pytest.fixture(scope="session")
def fast_cfg() -> RetentionConfig:
    return RetentionConfig(lr_C=(1.0,), hgb_learning_rate=(0.1,), hgb_max_depth=(2,), hgb_max_iter=(50,),
                           bootstrap_resamples=50, shap_background_rows=20, importance_rows=40)


@pytest.fixture(scope="session")
def demo_csv(tmp_path_factory):
    path = tmp_path_factory.mktemp("demo") / "participants.csv"
    generate_demo_participants(default_config()).to_csv(path, index=False)
    return path


@pytest.fixture(scope="session")
def trained(small_df, fast_cfg, demo_csv, tmp_path_factory):
    root = tmp_path_factory.mktemp("retention")
    cfg = dataclasses.replace(fast_cfg, model_dir=root / "models", report_dir=root / "reports", demo_participants_csv=demo_csv)
    summary = run_training(small_df, cfg, cfg.model_dir, cfg.report_dir, demo_csv=demo_csv)
    return {"summary": summary, "cfg": cfg, "model_dir": cfg.model_dir, "report_dir": cfg.report_dir}


@pytest.fixture(scope="session")
def predictor(trained):
    from app.retention.predict import RetentionPredictor
    return RetentionPredictor.load(trained["model_dir"], trained["cfg"])
