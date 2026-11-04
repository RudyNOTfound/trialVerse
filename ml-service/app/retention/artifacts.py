"""Saving and loading of the trained retention model and its metadata."""
from __future__ import annotations

import json
import platform
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict

import joblib
import numpy as np
import pandas as pd
import sklearn

from app.retention.config import MODEL_FEATURES

PIPELINE_FILE = "pipeline.joblib"
METADATA_FILE = "metadata.json"
BACKGROUND_FILE = "explainer_background.csv"


class ArtifactError(RuntimeError):
    """Artifacts are missing, incomplete or inconsistent."""


@dataclass
class LoadedArtifacts:
    pipeline: Any
    metadata: Dict[str, Any]
    background: pd.DataFrame


def library_versions() -> Dict[str, str]:
    """Versions that affect (de)serialisation and numerics."""
    import shap
    return {"python": platform.python_version(), "scikit-learn": sklearn.__version__, "numpy": np.__version__,
            "pandas": pd.__version__, "shap": shap.__version__}


def save_artifacts(model_dir: Path, pipeline: Any, metadata: Dict[str, Any], background: pd.DataFrame) -> Dict[str, Path]:
    """Write pipeline.joblib, metadata.json and the (small) SHAP background sample."""
    model_dir = Path(model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    paths = {"pipeline": model_dir / PIPELINE_FILE, "metadata": model_dir / METADATA_FILE,
             "background": model_dir / BACKGROUND_FILE}
    joblib.dump(pipeline, paths["pipeline"])
    background[list(MODEL_FEATURES)].to_csv(paths["background"], index=False, float_format="%.6g")
    paths["metadata"].write_text(json.dumps(metadata, indent=2, sort_keys=True, default=str) + "\n")
    return paths


def load_artifacts(model_dir: Path) -> LoadedArtifacts:
    """Load a trained model; never retrains. Raises `ArtifactError` with the fix if anything is missing."""
    model_dir = Path(model_dir)
    for name in (PIPELINE_FILE, METADATA_FILE, BACKGROUND_FILE):
        if not (model_dir / name).exists():
            raise ArtifactError(f"{model_dir / name} not found. Train first: cd ml-service && python -m app.retention.train")
    metadata = json.loads((model_dir / METADATA_FILE).read_text())
    if list(metadata.get("features", {}).get("model_features", [])) != list(MODEL_FEATURES):
        raise ArtifactError("artifact feature schema does not match the current code; retrain the model")
    trained_with = metadata.get("library_versions", {}).get("scikit-learn")
    if trained_with and trained_with != sklearn.__version__:
        warnings.warn(f"model trained with scikit-learn {trained_with}, loading with {sklearn.__version__}")
    return LoadedArtifacts(joblib.load(model_dir / PIPELINE_FILE), metadata, pd.read_csv(model_dir / BACKGROUND_FILE))
