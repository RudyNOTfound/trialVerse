"""Leakage guards on the (synthetic) training data and the model inputs.

No single feature may (nearly) determine the label, no row may appear twice, participant ids are unique (so a split cannot put
one participant on both sides), and the target/id columns can never be model inputs.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest
from sklearn.metrics import roc_auc_score

from app.retention.config import ID_COLUMN, MODEL_FEATURES, TARGET

TRAINING_CSV = Path(__file__).resolve().parents[2] / "generated_data" / "training" / "dropout_training.csv"
MAX_SINGLE_FEATURE_AUC = 0.90          # the strongest real feature (distance_km) measures 0.743


def single_feature_aucs(df: pd.DataFrame) -> dict:
    out = {}
    for c in df.columns:
        if c in (ID_COLUMN, TARGET):
            continue
        x = df[c].astype("category").cat.codes if df[c].dtype == object else df[c]
        x = x.fillna(x.median())
        a = roc_auc_score(df[TARGET], x)
        out[c] = max(a, 1 - a)
    return out


def leaky_columns(df: pd.DataFrame) -> list:
    return [c for c, a in single_feature_aucs(df).items() if a > MAX_SINGLE_FEATURE_AUC]


def test_target_and_identifier_are_never_model_inputs():
    assert TARGET not in MODEL_FEATURES and ID_COLUMN not in MODEL_FEATURES
    assert not any("drop" in f for f in MODEL_FEATURES)


def test_the_detector_trips_on_a_leaky_column():
    """Canary: the check itself works (a copy of the label, and a noisy-but-near-perfect proxy, are both caught)."""
    df = pd.DataFrame({ID_COLUMN: range(200), "x": range(200), TARGET: [0, 1] * 100})
    df["leak_copy"] = df[TARGET]
    df["leak_proxy"] = df[TARGET] * 10 + (pd.Series(range(200)) % 3) * 0.1
    assert set(leaky_columns(df)) == {"leak_copy", "leak_proxy"}


@pytest.mark.skipif(not TRAINING_CSV.is_file(), reason="Phase 3 training data not present")
class TestCommittedTrainingData:
    @pytest.fixture(scope="class")
    def df(self):
        return pd.read_csv(TRAINING_CSV)

    def test_no_single_feature_determines_the_label(self, df):
        aucs = single_feature_aucs(df)
        assert leaky_columns(df) == [], aucs
        assert max(aucs.values()) < 0.80, aucs

    def test_participant_ids_are_unique_so_a_split_cannot_leak_a_participant(self, df):
        assert df[ID_COLUMN].is_unique and df[ID_COLUMN].notna().all()

    def test_no_duplicate_rows_apart_from_the_id(self, df):
        assert not df.drop(columns=[ID_COLUMN]).duplicated().any()

    def test_every_model_feature_is_a_column_and_nothing_else_is_used(self, df):
        assert set(MODEL_FEATURES) <= set(df.columns)
        assert set(df.columns) - set(MODEL_FEATURES) == {ID_COLUMN, TARGET, "scheduled_visits"}

    def test_label_is_binary_with_a_plausible_prevalence(self, df):
        assert set(df[TARGET].unique()) == {0, 1} and 0.1 < df[TARGET].mean() < 0.5
