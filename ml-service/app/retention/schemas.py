"""Input and output schemas of the retention engine (pydantic v2)."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError, field_validator, model_validator


class InvalidInputError(ValueError):
    """Raised when a participant feature payload is malformed."""


def _plain(v: Any) -> Any:
    """Unwrap numpy scalars (e.g. from a pandas row) to plain Python values."""
    return v.item() if isinstance(v, np.generic) else v


def _number(v: Any) -> Any:
    """Numeric fields take real numbers only: numeric strings and booleans are malformed, not coerced."""
    v = _plain(v)
    if isinstance(v, (bool, str)):
        raise ValueError("must be a number (not a string or boolean)")
    return v


def _binary(v: Any) -> int:
    v = _plain(v)
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int) and v in (0, 1):
        return v
    if isinstance(v, float) and v in (0.0, 1.0):
        return int(v)
    raise ValueError("must be 0/1 or a boolean")


class ParticipantFeatures(BaseModel):
    """One participant's inputs. Unknown fields (including the target) are rejected; `participant_id` is
    echoed back but never used by the model. `age` and `reimbursement_delay_days` may be null."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    participant_id: Optional[str] = None
    site_id: str = Field(min_length=1, max_length=64)
    age: Optional[float] = Field(default=None, ge=0, le=120, allow_inf_nan=False)
    distance_km: float = Field(ge=0, le=2000, allow_inf_nan=False)
    daily_wage_worker: int
    scheduled_visits: StrictInt = Field(default=8, ge=1, le=100)
    missed_reminders: StrictInt = Field(ge=0, le=100)
    reimbursement_delay_days: Optional[float] = Field(default=None, ge=0, le=730, allow_inf_nan=False)
    side_effects_reported: int
    phone_changed: int
    visits_missed: StrictInt = Field(ge=0, le=100)

    @field_validator("age", "distance_km", "scheduled_visits", "missed_reminders", "reimbursement_delay_days",
                     "visits_missed", mode="before")
    @classmethod
    def _check_number(cls, v: Any) -> Any:
        return v if v is None else _number(v)

    @field_validator("daily_wage_worker", "side_effects_reported", "phone_changed", mode="before")
    @classmethod
    def _check_binary(cls, v: Any) -> int:
        return _binary(v)

    @model_validator(mode="after")
    def _missed_within_schedule(self) -> "ParticipantFeatures":
        if self.visits_missed > self.scheduled_visits:
            raise ValueError("visits_missed cannot exceed scheduled_visits")
        return self


def validate_features(payload: Any) -> ParticipantFeatures:
    """Validate a dict (or ParticipantFeatures); raise `InvalidInputError` with a readable message."""
    if isinstance(payload, ParticipantFeatures):
        return payload
    if not isinstance(payload, dict):
        raise InvalidInputError(f"expected a mapping of features, got {type(payload).__name__}")
    try:
        return ParticipantFeatures(**payload)
    except ValidationError as exc:
        msg = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}" for e in exc.errors())
        raise InvalidInputError(f"invalid participant features: {msg}") from exc


class FactorContribution(BaseModel):
    feature: str
    label: str
    value: Optional[Any] = None
    contribution: float = Field(description="Change in risk score (percentage points) attributed to this feature")
    direction: Literal["increases_risk", "decreases_risk"]
    description: str


class RecommendedAction(BaseModel):
    action_type: str
    title: str
    reason: str
    priority: Literal["high", "medium", "low"]


class RetentionPrediction(BaseModel):
    participant_id: Optional[str] = None
    risk_score: float = Field(ge=0, le=100, description="Predicted dropout probability x 100")
    risk_level: Literal["low", "medium", "high"]
    flagged_for_support: bool = Field(description="risk_score at or above the operational screening threshold")
    model_version: str
    top_risk_factors: List[FactorContribution]
    protective_factors: List[FactorContribution]
    recommended_actions: List[RecommendedAction]
    explanation_status: Literal["ok", "unavailable"]
    explanation_note: str
    baseline_risk_score: Optional[float] = None
    warnings: List[str] = Field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return self.model_dump()
