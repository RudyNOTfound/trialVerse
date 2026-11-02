"""Per-prediction and global explanations via exact SHAP on the whole pipeline.

`HistGradientBoostingClassifier` is not supported by SHAP's TreeExplainer, so the model is explained as a black box:
`shap.explainers.Exact` (exact Shapley values, feasible because there are only 9 raw features) over the full
preprocessing + model pipeline, with an interventional background sample from the training split. Attributions are
therefore per *original* feature (site is one feature, not four one-hot columns) and are in probability units; they
sum exactly to (prediction - baseline). They describe what the model does, not causes in the real world.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from app.retention.config import FEATURE_LABELS, MODEL_FEATURES

ADDITIVITY_TOLERANCE = 1e-6
UNSEEN_SITE_CODE = -1.0
CAUSATION_NOTE = ("Contributions show how the model's score depends on each input for this participant; "
                  "they are statistical attributions, not evidence that a factor causes dropout.")


class ExplanationError(RuntimeError):
    """Raised when an explanation cannot be produced or fails its consistency check."""


class RetentionExplainer:
    """Exact SHAP explanations for a fitted retention pipeline."""

    def __init__(self, pipeline, background: pd.DataFrame, sites: List[str]):
        import shap  # imported lazily so predictions still work if shap is unavailable
        self.pipeline = pipeline
        self.features = list(MODEL_FEATURES)
        self.sites = list(sites)
        self._site_code = {s: float(i) for i, s in enumerate(self.sites)}
        bg = self._encode(background[self.features])
        self._explainer = shap.explainers.Exact(self._predict_encoded, shap.maskers.Independent(bg, max_samples=len(bg)))

    def _encode(self, frame: pd.DataFrame) -> np.ndarray:
        d = frame[self.features].copy()
        d["site_id"] = d["site_id"].map(self._site_code).fillna(UNSEEN_SITE_CODE)
        return d.to_numpy(dtype=float)

    def _predict_encoded(self, arr: np.ndarray) -> np.ndarray:
        d = pd.DataFrame(arr, columns=self.features)
        d["site_id"] = d["site_id"].map(lambda c: self.sites[int(c)] if c >= 0 else "__unseen__")
        return self.pipeline.predict_proba(d)[:, 1]

    def shap_values(self, frame: pd.DataFrame) -> Dict[str, Any]:
        """Raw attributions (probability units) for each row plus the baseline, with an additivity check."""
        try:
            sv = self._explainer(self._encode(frame))
        except Exception as exc:  # never fabricate an explanation
            raise ExplanationError(f"SHAP failed: {exc}") from exc
        pred = self.pipeline.predict_proba(frame[self.features])[:, 1]
        err = float(np.max(np.abs(sv.values.sum(axis=1) + sv.base_values - pred)))
        if err > 1e-4:
            raise ExplanationError(f"SHAP values do not add up to the model output (max error {err:.2e})")
        return {"values": sv.values, "base": np.asarray(sv.base_values, dtype=float), "prediction": pred}

    def explain_one(self, frame: pd.DataFrame, raw: Dict[str, Any], top_n: int = 5, min_points: float = 0.5) -> Dict[str, Any]:
        """Top risk-increasing and protective factors for a single participant (frame has one row).

        Attributions smaller than `min_points` risk-score points are treated as negligible and not listed."""
        out = self.shap_values(frame.iloc[[0]])
        contribs = [make_contribution(f, raw.get(f), float(v) * 100.0) for f, v in zip(self.features, out["values"][0])
                    if abs(float(v) * 100.0) >= min_points]
        up = sorted([c for c in contribs if c["direction"] == "increases_risk"], key=lambda c: -c["contribution"])
        down = sorted([c for c in contribs if c["direction"] == "decreases_risk"], key=lambda c: c["contribution"])
        return {"baseline_risk_score": float(out["base"][0]) * 100.0, "increasing": up[:top_n], "decreasing": down[:top_n]}

    def global_importance(self, frame: pd.DataFrame) -> pd.DataFrame:
        """Mean |SHAP| (risk-score points) per feature, and mean signed SHAP, over `frame`."""
        out = self.shap_values(frame)
        return (pd.DataFrame({
            "feature": self.features, "label": [FEATURE_LABELS[f] for f in self.features],
            "mean_abs_contribution": np.abs(out["values"]).mean(axis=0) * 100.0,
            "mean_signed_contribution": out["values"].mean(axis=0) * 100.0,
        }).sort_values("mean_abs_contribution", ascending=False).reset_index(drop=True))


def describe_value(feature: str, value: Any) -> str:
    """Human-readable value, e.g. '40 km' or 'yes'."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "not recorded"
    if feature == "distance_km":
        return f"{value:g} km"
    if feature == "reimbursement_delay_days":
        return f"{value:g} days"
    if feature in ("daily_wage_worker", "side_effects_reported", "phone_changed"):
        return "yes" if value else "no"
    if feature == "age":
        return f"{value:g} years"
    return str(value if not isinstance(value, float) else f"{value:g}")


def make_contribution(feature: str, value: Any, points: float) -> Dict[str, Any]:
    """Structured factor entry; `points` is the signed change in risk score (percentage points)."""
    direction = "increases_risk" if points > 0 else "decreases_risk"
    label = FEATURE_LABELS[feature]
    verb = "raises" if points > 0 else "lowers"
    return {"feature": feature, "label": label, "value": None if value is None or (isinstance(value, float) and np.isnan(value)) else value,
            "contribution": round(points, 2), "direction": direction,
            "description": f"{label}: {describe_value(feature, value)} {verb} the model's risk score by {abs(points):.1f} points"}
