"""Transparent, rule-based mapping from risk factors to operational support actions.

Rules read raw feature values only and are independent of the ML model. They suggest support
(scheduling, reminders, payments, follow-up calls); they never diagnose or prescribe treatment.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from app.retention.config import InterventionThresholds


@dataclass(frozen=True)
class Rule:
    factor: str                      # feature that triggers the rule
    action_type: str
    title: str
    triggered: Callable[[Mapping[str, Any], InterventionThresholds], bool]
    reason: Callable[[Mapping[str, Any]], str]


def _num(f: Mapping[str, Any], key: str) -> Optional[float]:
    v = f.get(key)
    return None if v is None else float(v)


RULES: List[Rule] = [
    Rule("distance_km", "remote_or_home_visit", "Offer teleconsultation or a home visit",
         lambda f, t: (_num(f, "distance_km") or 0) >= t.distance_km,
         lambda f: f"Lives {f['distance_km']:g} km from the site, so travel is a barrier to attending visits."),
    Rule("daily_wage_worker", "flexible_scheduling", "Offer flexible visit scheduling",
         lambda f, t: bool(f.get("daily_wage_worker")),
         lambda f: "Daily-wage worker: attending a visit may cost a day's income."),
    Rule("missed_reminders", "reminder_escalation", "Increase reminder frequency or use IVR calls",
         lambda f, t: (_num(f, "missed_reminders") or 0) >= t.missed_reminders,
         lambda f: f"{int(f['missed_reminders'])} reminders were missed."),
    Rule("reimbursement_delay_days", "reimbursement_priority", "Prioritise reimbursement resolution (instant payout where possible)",
         lambda f, t: (_num(f, "reimbursement_delay_days") or 0) >= t.reimbursement_delay_days,
         lambda f: f"Reimbursements are taking about {f['reimbursement_delay_days']:g} days."),
    Rule("side_effects_reported", "clinician_follow_up", "Arrange a clinician follow-up call",
         lambda f, t: bool(f.get("side_effects_reported")),
         lambda f: "The participant reported side effects; the study clinician should check in."),
    Rule("phone_changed", "verify_contact_details", "Verify and update contact details",
         lambda f, t: bool(f.get("phone_changed")),
         lambda f: "The phone number changed, so reminders may not be reaching the participant."),
    Rule("visits_missed", "coordinator_follow_up", "Coordinator follow-up",
         lambda f, t: (_num(f, "visits_missed") or 0) >= t.visits_missed,
         lambda f: f"{int(f['visits_missed'])} earlier visit(s) were missed."),
]

TOP_RANKS_HIGH = 2
_ORDER = {"high": 0, "medium": 1, "low": 2}


def triggered_rules(features: Mapping[str, Any], thresholds: InterventionThresholds) -> List[Rule]:
    """Rules whose raw-feature condition holds (no model involved)."""
    return [r for r in RULES if r.triggered(features, thresholds)]


def recommend_actions(features: Mapping[str, Any], risk_level: str, risk_increasing: Sequence[str],
                      thresholds: InterventionThresholds = InterventionThresholds()) -> List[Dict[str, str]]:
    """Return structured actions for the triggered rules.

    `risk_increasing` lists the model's risk-raising features, strongest first (empty if no explanation).
    Gating, so not everyone gets everything: a low-risk participant only receives actions for factors the model
    also flags. Priority: high = high risk AND the factor is one of the model's top `TOP_RANKS_HIGH` drivers;
    medium = the model flags the factor, or risk is medium/high; low = anything else that remains.
    """
    ranked = list(risk_increasing)
    actions = []
    for rule in triggered_rules(features, thresholds):
        model_flags = rule.factor in ranked
        if risk_level == "low" and not model_flags:
            continue
        if risk_level == "high" and model_flags and ranked.index(rule.factor) < TOP_RANKS_HIGH:
            priority = "high"
        elif model_flags or risk_level in ("medium", "high"):
            priority = "medium"
        else:
            priority = "low"
        actions.append({"action_type": rule.action_type, "title": rule.title, "reason": rule.reason(features),
                        "priority": priority})
    return sorted(actions, key=lambda a: _ORDER[a["priority"]])
