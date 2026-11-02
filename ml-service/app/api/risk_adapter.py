"""Maps the backend's flat risk `features` onto the Phase 4 retention model and back.

The current backend feature schema (v1: OTP failures, claim velocity, ...) contains none of the retention model's
inputs, so such requests are refused (HTTP 422 -> backend falls back to its baseline). They are never padded with
defaults. Once the backend sends participant features under the same names, this route works unchanged.
"""
from __future__ import annotations

from typing import Any, Dict, List

from app.retention.config import MODEL_FEATURES, OPTIONAL_FEATURES
from app.retention.schemas import RetentionPrediction

# Required on the contract route: the model's non-optional inputs plus scheduled_visits (decision D12 -- the native
# route still defaults it, the contract route must not).
REQUIRED = tuple(f for f in MODEL_FEATURES if f not in OPTIONAL_FEATURES) + ("scheduled_visits",)
ACCEPTED = tuple(MODEL_FEATURES) + ("scheduled_visits",)


def missing_required(features: Dict[str, Any]) -> List[str]:
    return [f for f in REQUIRED if features.get(f) is None]


def to_retention_input(features: Dict[str, Any], entity_id: str) -> Dict[str, Any]:
    """Only the model's known features are passed on; unknown ones are ignored (contract rule)."""
    out = {k: features[k] for k in ACCEPTED if k in features}
    out["participant_id"] = entity_id             # echoed by the engine, never used as a feature
    return out


def explanation_text(p: RetentionPrediction) -> str:
    """The model's own category is labelled as such: the platform has a separate 25/50/75 risk scale (decision D7), and the
    two must never be conflated or relabelled."""
    drivers = ", ".join(f"{f.label.lower()} ({f.contribution:+.1f})" for f in p.top_risk_factors[:3]) or "no dominant factor"
    tail = ("Factors are statistical associations in synthetic training data, not causes. Prototype; not validated for clinical use.")
    notes = (" Data notes: " + "; ".join(p.warnings) + ".") if p.warnings else ""
    head = (f"Predicted dropout risk {p.risk_score:.0f}/100; retention model category: {p.risk_level} "
            f"(model thresholds, separate from the platform's risk levels). Largest risk-increasing factors: {drivers}. ")
    return (head + tail + notes)[:2000]


def factors_for_contract(p: RetentionPrediction) -> List[Dict[str, Any]]:
    fs = [{"name": f.feature, "contribution": f.contribution, "detail": f.description[:300]}
          for f in list(p.top_risk_factors) + list(p.protective_factors)]
    return fs[:50]
