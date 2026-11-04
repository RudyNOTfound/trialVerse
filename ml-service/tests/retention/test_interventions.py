import dataclasses
import re

import pytest

from app.retention import interventions as iv
from app.retention.config import InterventionThresholds
from helpers import ELEVATED, NORMAL

TH = InterventionThresholds()


def types(actions):
    return {a["action_type"] for a in actions}


@pytest.mark.parametrize("change,action_type", [
    ({"distance_km": 40}, "remote_or_home_visit"), ({"daily_wage_worker": 1}, "flexible_scheduling"),
    ({"missed_reminders": 2}, "reminder_escalation"), ({"reimbursement_delay_days": 12}, "reimbursement_priority"),
    ({"side_effects_reported": 1}, "clinician_follow_up"), ({"phone_changed": 1}, "verify_contact_details"),
    ({"visits_missed": 1}, "coordinator_follow_up"),
])
def test_each_rule_fires_alone_for_its_factor(change, action_type):
    f = {**NORMAL, **change}
    assert types(iv.recommend_actions(f, "high", [])) == {action_type}


def test_normal_participant_gets_no_actions():
    assert iv.recommend_actions(NORMAL, "low", []) == []
    assert iv.recommend_actions(NORMAL, "medium", []) == []     # nothing triggered -> nothing recommended at any level


def test_not_every_intervention_for_every_participant():
    partial = {**NORMAL, "distance_km": 45, "phone_changed": 1}
    assert types(iv.recommend_actions(partial, "high", ["distance_km"])) == {"remote_or_home_visit", "verify_contact_details"}
    assert len(iv.recommend_actions(ELEVATED, "high", [])) == len(iv.RULES)        # only a participant with every factor gets all


@pytest.mark.parametrize("name,value,below", [("distance_km", 30, 29.9), ("missed_reminders", 2, 1),
                                              ("reimbursement_delay_days", 10, 9), ("visits_missed", 1, 0)])
def test_threshold_boundaries(name, value, below):
    assert types(iv.recommend_actions({**NORMAL, name: value}, "high", [])) != set()
    assert types(iv.recommend_actions({**NORMAL, name: below}, "high", [])) == set()


def test_thresholds_are_configurable():
    f = {**NORMAL, "distance_km": 20}
    assert iv.recommend_actions(f, "high", []) == []
    assert types(iv.recommend_actions(f, "high", [], dataclasses.replace(TH, distance_km=15))) == {"remote_or_home_visit"}


def test_missing_optional_reimbursement_delay_does_not_crash():
    assert iv.recommend_actions({**NORMAL, "reimbursement_delay_days": None}, "high", []) == []


def test_low_risk_is_gated_by_the_model_flag():
    f = {**NORMAL, "daily_wage_worker": 1, "phone_changed": 1}
    assert iv.recommend_actions(f, "low", []) == []
    only = iv.recommend_actions(f, "low", ["phone_changed"])
    assert types(only) == {"verify_contact_details"} and only[0]["priority"] == "medium"


def test_priorities_and_sorting():
    acts = iv.recommend_actions(ELEVATED, "high", ["missed_reminders", "distance_km", "daily_wage_worker"])
    pr = {a["action_type"]: a["priority"] for a in acts}
    assert pr["reminder_escalation"] == "high" and pr["remote_or_home_visit"] == "high"      # top-2 model drivers at high risk
    assert pr["flexible_scheduling"] == "medium" and pr["reimbursement_priority"] == "medium"
    order = {"high": 0, "medium": 1, "low": 2}
    assert [order[a["priority"]] for a in acts] == sorted(order[a["priority"]] for a in acts)
    med = iv.recommend_actions({**NORMAL, "distance_km": 50}, "medium", [])
    assert med[0]["priority"] == "medium"


def test_structure_and_supportive_non_clinical_language():
    acts = iv.recommend_actions(ELEVATED, "high", ["distance_km"])
    for a in acts:
        assert set(a) == {"action_type", "title", "reason", "priority"} and all(a.values())
    text = " ".join(a["title"] + " " + a["reason"] for a in acts).lower()
    for banned in ("prescribe", "dose", "dosage", "diagnos", "medication", "treatment", "penal", "warn", "non-complian", "blame"):
        assert banned not in text
    assert "clinician" in text                        # side effects are routed to a clinician, not handled here


def test_reasons_reflect_actual_values():
    acts = {a["action_type"]: a for a in iv.recommend_actions({**NORMAL, "distance_km": 40, "reimbursement_delay_days": 12, "missed_reminders": 2}, "high", [])}
    assert "40 km" in acts["remote_or_home_visit"]["reason"] and "12 days" in acts["reimbursement_priority"]["reason"] and "2 reminders" in acts["reminder_escalation"]["reason"]
    assert "teleconsultation" in acts["remote_or_home_visit"]["title"].lower() and "reimbursement" in acts["reimbursement_priority"]["title"].lower()


def test_rules_are_independent_of_the_ml_model():
    src = open(iv.__file__).read()
    assert not re.search(r"^\s*(import|from)\s+(sklearn|shap|joblib|xgboost)", src, re.M)
    assert "predict" not in src.lower().replace("predicted", "")
    assert len({r.action_type for r in iv.RULES}) == len(iv.RULES) == 7
