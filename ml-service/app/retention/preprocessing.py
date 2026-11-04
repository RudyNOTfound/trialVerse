"""Loading, schema validation, splitting and the scikit-learn preprocessing pipeline."""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from app.retention.config import (BINARY_FEATURES, CATEGORICAL_FEATURES, ID_COLUMN, MODEL_FEATURES, NUMERIC_FEATURES,
                                  OPTIONAL_FEATURES, REQUIRED_COLUMNS, TARGET, RetentionConfig)


class SchemaError(ValueError):
    """The training data does not match the Phase 3 schema."""


def validate_training_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Check columns, target and value ranges. Returns the frame unchanged; raises `SchemaError`."""
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    extra = [c for c in df.columns if c not in REQUIRED_COLUMNS]
    if missing or extra:
        raise SchemaError(f"schema mismatch: missing={missing} unexpected={extra}")
    if df.empty:
        raise SchemaError("training data is empty")
    if df[ID_COLUMN].duplicated().any():
        raise SchemaError("duplicate participant_id values")
    if not df[TARGET].isin([0, 1]).all():
        raise SchemaError(f"{TARGET} must contain only 0/1 (no missing values)")
    if df[TARGET].nunique() < 2:
        raise SchemaError(f"{TARGET} has a single class; cannot train")
    for c in BINARY_FEATURES:
        if not df[c].isin([0, 1]).all():
            raise SchemaError(f"{c} must be 0/1")
    must_be_complete = [c for c in MODEL_FEATURES if c not in OPTIONAL_FEATURES]
    nulls = df[must_be_complete].isna().sum()
    if nulls.any():
        raise SchemaError(f"unexpected missing values: {nulls[nulls > 0].to_dict()}")
    if (df["distance_km"] < 0).any() or (df["missed_reminders"] < 0).any() or (df["visits_missed"] < 0).any():
        raise SchemaError("negative values in count/distance columns")
    if (df["visits_missed"] > df["scheduled_visits"]).any():
        raise SchemaError("visits_missed exceeds scheduled_visits")
    return df


def load_training_data(path: Path) -> pd.DataFrame:
    """Read and validate the Phase 3 training CSV."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Generate it first: cd ml-service && python -m app.data_generation.generate_all")
    return validate_training_frame(pd.read_csv(path))


def split_features_target(df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
    """Model features (no identifier, no target, no constant `scheduled_visits`) and the target."""
    return df[list(MODEL_FEATURES)].copy(), df[TARGET].astype(int).copy()


def make_split(df: pd.DataFrame, cfg: RetentionConfig) -> Dict[str, pd.DataFrame]:
    """Stratified train/validation/test split of the *raw* rows (nothing is imputed before this point)."""
    if abs(cfg.train_frac + cfg.val_frac + cfg.test_frac - 1.0) > 1e-9:
        raise ValueError("split fractions must sum to 1")
    train_val, test = train_test_split(df, test_size=cfg.test_frac, stratify=df[TARGET], random_state=cfg.seed)
    val_share = cfg.val_frac / (cfg.train_frac + cfg.val_frac)
    train, val = train_test_split(train_val, test_size=val_share, stratify=train_val[TARGET], random_state=cfg.seed)
    return {"train": train.reset_index(drop=True), "val": val.reset_index(drop=True), "test": test.reset_index(drop=True)}


def build_preprocessor() -> ColumnTransformer:
    """Median-impute + scale numerics, pass binaries through, one-hot the site (unknown sites -> all zeros).

    Fitted only as part of a Pipeline on the training split, so imputation statistics never see
    validation or test rows.
    """
    numeric = Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())])
    categorical = Pipeline([
        ("impute", SimpleImputer(strategy="constant", fill_value="UNKNOWN")),
        ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
    ])
    prep = ColumnTransformer([
        ("num", numeric, list(NUMERIC_FEATURES)),
        ("bin", "passthrough", list(BINARY_FEATURES)),
        ("cat", categorical, list(CATEGORICAL_FEATURES)),
    ], verbose_feature_names_out=False)
    prep.set_output(transform="pandas")
    return prep


def build_pipeline(estimator: BaseEstimator) -> Pipeline:
    """Preprocessing + classifier as one fit/predict object."""
    return Pipeline([("prep", build_preprocessor()), ("model", estimator)])


def transformed_feature_names(pipeline: Pipeline) -> list:
    """Names of the columns the classifier actually sees (after encoding)."""
    return list(pipeline.named_steps["prep"].get_feature_names_out())


def frame_from_features(row: dict) -> pd.DataFrame:
    """One-row raw feature frame in model column order (None -> NaN for optional values)."""
    data = {c: [np.nan if row.get(c) is None else row[c]] for c in MODEL_FEATURES}
    return pd.DataFrame(data, columns=list(MODEL_FEATURES))
