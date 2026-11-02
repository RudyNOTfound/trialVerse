"""Shared fixtures: one full pipeline run (seed 42, default config) reused by all tests."""
from __future__ import annotations

import pytest

from app.config import default_config
from app.data_generation import validation
from app.data_generation.generate_all import run_pipeline


@pytest.fixture(scope="session")
def cfg(tmp_path_factory):
    return default_config(output_dir=tmp_path_factory.mktemp("glu301"))


@pytest.fixture(scope="session")
def summary(cfg):
    return run_pipeline(cfg, validate=True, check_reproducibility=False)


@pytest.fixture(scope="session")
def ds(cfg, summary):
    return validation.load_dataset(cfg.output_dir)
