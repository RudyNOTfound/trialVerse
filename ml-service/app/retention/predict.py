"""Inference: validate one participant, score with the saved model, explain and recommend support."""
from __future__ import annotations

import warnings
from pathlib import Path
from typing import Any, Dict, Optional, Union

import numpy as np
import pandas as pd

from app.config import RameshConfig
from app.retention.artifacts import LoadedArtifacts, load_artifacts
from app.retention.config import RetentionConfig
from app.retention.explain import CAUSATION_NOTE, ExplanationError, RetentionExplainer
from app.retention.interventions import recommend_actions
from app.retention.preprocessing import frame_from_features
from app.retention.schemas import ParticipantFeatures, RetentionPrediction, validate_features


def assign_risk_level(probability: float, operational_threshold: float, high_threshold: float) -> str:
    """low < operational <= medium < high threshold <= high (thresholds are chosen on validation data)."""
    if probability >= high_threshold:
        return "high"
    if probability >= operational_threshold:
        return "medium"
    return "low"


class RetentionPredictor:
    """Wraps a loaded artifact bundle. Never retrains."""

    def __init__(self, artifacts: LoadedArtifacts, cfg: Optional[RetentionConfig] = None):
        self.cfg = cfg or RetentionConfig()
        self.pipeline = artifacts.pipeline
        self.metadata = artifacts.metadata
        self.model_version: str = self.metadata["model_version"]
        self.t_op: float = self.metadata["thresholds"]["operational_threshold"]
        self.t_high: float = self.metadata["thresholds"]["high_threshold"]
        self.known_sites = set(self.metadata["features"]["known_sites"])
        self._background = artifacts.background
        self._explainer: Optional[RetentionExplainer] = None
        self._explainer_error: Optional[str] = None

    @classmethod
    def load(cls, model_dir: Optional[Path] = None, cfg: Optional[RetentionConfig] = None) -> "RetentionPredictor":
        cfg = cfg or RetentionConfig()
        return cls(load_artifacts(model_dir or cfg.model_dir), cfg)

    def _get_explainer(self) -> Optional[RetentionExplainer]:
        if self._explainer is None and self._explainer_error is None:
            try:
                self._explainer = RetentionExplainer(self.pipeline, self._background, sorted(self.known_sites))
            except Exception as exc:
                self._explainer_error = f"explainer could not be built: {exc}"
        return self._explainer

    def predict_proba(self, features: Union[dict, ParticipantFeatures]) -> float:
        """Dropout probability (0-1) only; no explanation."""
        f = validate_features(features)
        return float(self.pipeline.predict_proba(frame_from_features(f.model_dump()))[:, 1][0])

    def predict(self, features: Union[dict, ParticipantFeatures], explain: bool = True) -> RetentionPrediction:
        """Full prediction. Raises `InvalidInputError` for malformed input."""
        f = validate_features(features)
        raw = f.model_dump()
        frame = frame_from_features(raw)
        proba = float(self.pipeline.predict_proba(frame)[:, 1][0])
        level = assign_risk_level(proba, self.t_op, self.t_high)

        warns = []
        if f.site_id not in self.known_sites:
            warns.append(f"site_id '{f.site_id}' was not seen in training; no site-specific effect is applied")
        for opt in ("age", "reimbursement_delay_days"):
            if raw[opt] is None:
                warns.append(f"{opt} not provided; the training median is used")

        increasing, decreasing, baseline, status, note = [], [], None, "unavailable", ""
        explainer = self._get_explainer() if explain else None
        if explainer is not None:
            try:
                e = explainer.explain_one(frame, raw, self.cfg.top_factors, self.cfg.min_factor_points)
                increasing, decreasing, baseline = e["increasing"], e["decreasing"], e["baseline_risk_score"]
                status, note = "ok", CAUSATION_NOTE
            except ExplanationError as exc:
                note = f"explanation unavailable: {exc}"
        else:
            note = "explanation not requested" if not explain else f"explanation unavailable: {self._explainer_error}"

        actions = recommend_actions(raw, level, [c["feature"] for c in increasing], self.cfg.interventions)
        return RetentionPrediction(
            participant_id=f.participant_id, risk_score=round(proba * 100, 2), risk_level=level,
            flagged_for_support=proba >= self.t_op, model_version=self.model_version,
            top_risk_factors=increasing, protective_factors=decreasing, recommended_actions=actions,
            explanation_status=status, explanation_note=note,
            baseline_risk_score=None if baseline is None else round(baseline, 2), warnings=warns)


def load_ramesh_features(cfg: Optional[RetentionConfig] = None, csv_path: Optional[Path] = None) -> Dict[str, Any]:
    """Ramesh's feature vector, read from the Phase 3 demo participants file (nothing hardcoded)."""
    cfg = cfg or RetentionConfig()
    path = Path(csv_path or cfg.demo_participants_csv)
    if not path.exists():
        raise FileNotFoundError(f"{path} not found. Run: cd ml-service && python -m app.data_generation.generate_all")
    df = pd.read_csv(path)
    name = RameshConfig().name
    rows = df[df["participant_name"] == name]
    if len(rows) != 1:
        raise ValueError(f"expected exactly one participant named {name!r}, found {len(rows)}")
    r = rows.iloc[0]
    cols = ["participant_id", "site_id", "age", "distance_km", "daily_wage_worker", "scheduled_visits", "missed_reminders",
            "reimbursement_delay_days", "side_effects_reported", "phone_changed", "visits_missed"]
    out: Dict[str, Any] = {}
    for c in cols:
        v = r[c]
        out[c] = None if pd.isna(v) else (v.item() if isinstance(v, np.generic) else v)
    return out
