"""API fixtures: a quickly trained retention model in a temp dir (no network, no disk artifacts needed)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.app import create_app
from app.api.settings import Settings
from app.config import default_config
from app.data_generation.participants import generate_demo_participants, generate_training_data
from app.retention.config import RetentionConfig
from app.retention.train import run_training

sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture(scope="session")
def model_dir(tmp_path_factory):
    root = tmp_path_factory.mktemp("svc_model")
    demo = root / "participants.csv"
    generate_demo_participants(default_config()).to_csv(demo, index=False)
    cfg = RetentionConfig(lr_C=(1.0,), hgb_learning_rate=(0.1,), hgb_max_depth=(2,), hgb_max_iter=(50,), bootstrap_resamples=50,
                          shap_background_rows=20, importance_rows=40, model_dir=root / "m", report_dir=root / "r",
                          demo_participants_csv=demo)
    run_training(generate_training_data(default_config(n_training_participants=900)), cfg, cfg.model_dir, cfg.report_dir, demo_csv=demo)
    return cfg.model_dir


@pytest.fixture()
def settings(model_dir, tmp_path):
    return Settings(model_dir=model_dir, ecg_dir=tmp_path, request_timeout_s=10.0)


@pytest.fixture()
def client(settings):
    with TestClient(create_app(settings), raise_server_exceptions=False) as c:
        yield c
