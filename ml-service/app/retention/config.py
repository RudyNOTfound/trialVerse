"""Configuration for the retention (dropout-risk) engine. Everything tunable lives here."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Tuple

from app.config import ML_SERVICE_ROOT

TARGET = "dropped_out"
ID_COLUMN = "participant_id"

# Columns of generated_data/training/dropout_training.csv (Phase 3), in file order.
REQUIRED_COLUMNS: Tuple[str, ...] = (
    "participant_id", "site_id", "age", "distance_km", "daily_wage_worker", "scheduled_visits",
    "missed_reminders", "reimbursement_delay_days", "side_effects_reported", "phone_changed",
    "visits_missed", "dropped_out",
)
# `scheduled_visits` is constant (8) in the training data, so it carries no signal and is not a model
# feature; it is still accepted at inference to validate `visits_missed <= scheduled_visits`.
NUMERIC_FEATURES: Tuple[str, ...] = ("age", "distance_km", "missed_reminders", "reimbursement_delay_days", "visits_missed")
BINARY_FEATURES: Tuple[str, ...] = ("daily_wage_worker", "side_effects_reported", "phone_changed")
CATEGORICAL_FEATURES: Tuple[str, ...] = ("site_id",)
MODEL_FEATURES: Tuple[str, ...] = NUMERIC_FEATURES + BINARY_FEATURES + CATEGORICAL_FEATURES
OPTIONAL_FEATURES: Tuple[str, ...] = ("age", "reimbursement_delay_days")  # may be missing (as in the training data)

FEATURE_LABELS: Dict[str, str] = {
    "age": "Age", "distance_km": "Distance from site", "daily_wage_worker": "Daily-wage worker",
    "missed_reminders": "Missed reminders", "reimbursement_delay_days": "Reimbursement delay",
    "side_effects_reported": "Side effects reported", "phone_changed": "Phone number changed",
    "visits_missed": "Previously missed visits", "site_id": "Study site",
}


@dataclass(frozen=True)
class InterventionThresholds:
    """Raw-feature triggers for the rule-based support actions (see interventions.py)."""

    distance_km: float = 30.0
    missed_reminders: int = 2
    reimbursement_delay_days: float = 10.0
    visits_missed: int = 1


@dataclass(frozen=True)
class RetentionConfig:
    seed: int = 42
    train_frac: float = 0.70
    val_frac: float = 0.15
    test_frac: float = 0.15
    model_version_base: str = "1.0.0"
    # Threshold selection (on validation data only)
    f_beta: float = 2.0               # recall counts 2x as much as precision: a missed at-risk participant is costlier
    high_precision_target: float = 0.75   # "high" risk = smallest threshold whose validation precision reaches this
    min_factor_points: float = 0.5    # attributions smaller than this (risk-score points) are not listed
    threshold_grid: Tuple[float, float, float] = (0.05, 0.95, 0.01)
    # Candidate hyper-parameter grids (searched on the validation set)
    lr_C: Tuple[float, ...] = (0.01, 0.1, 1.0, 10.0)
    hgb_learning_rate: Tuple[float, ...] = (0.05, 0.1)
    hgb_max_depth: Tuple[int, ...] = (2, 3)
    hgb_max_iter: Tuple[int, ...] = (100, 200)
    # Reporting / explanations
    calibration_bins: int = 8
    bootstrap_resamples: int = 1000
    shap_background_rows: int = 50
    importance_rows: int = 300        # test rows used for the global SHAP importance
    top_factors: int = 5
    interventions: InterventionThresholds = field(default_factory=InterventionThresholds)
    training_csv: Path = ML_SERVICE_ROOT / "generated_data" / "training" / "dropout_training.csv"
    demo_participants_csv: Path = ML_SERVICE_ROOT / "generated_data" / "demo" / "participants.csv"
    model_dir: Path = ML_SERVICE_ROOT / "models" / "retention"
    report_dir: Path = ML_SERVICE_ROOT / "reports" / "retention"
