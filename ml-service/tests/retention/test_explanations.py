import numpy as np
import pytest

from app.retention import explain, preprocessing
from app.retention.config import FEATURE_LABELS, MODEL_FEATURES
from app.retention.explain import CAUSATION_NOTE, ExplanationError, RetentionExplainer
from helpers import ELEVATED, NORMAL


@pytest.fixture(scope="module")
def explainer(predictor):
    return RetentionExplainer(predictor.pipeline, predictor._background, sorted(predictor.known_sites))


def _frame(row):
    return preprocessing.frame_from_features({k: v for k, v in row.items() if k in MODEL_FEATURES})


def test_shap_values_add_up_to_the_model_output(explainer, predictor):
    for row in (NORMAL, ELEVATED, {**ELEVATED, "age": None}):
        f = _frame(row)
        out = explainer.shap_values(f)
        pred = predictor.pipeline.predict_proba(f)[:, 1]
        assert np.allclose(out["values"].sum(axis=1) + out["base"], pred, atol=1e-6)


def test_explanation_matches_the_reported_risk_score(predictor, explainer):
    p = predictor.predict(ELEVATED)
    assert p.explanation_status == "ok"
    # Untruncated attribution (all features, no minimum size) reproduces the score exactly (up to 2-dp rounding).
    full = explainer.explain_one(_frame(ELEVATED), ELEVATED, top_n=len(MODEL_FEATURES), min_points=0.0)
    total = full["baseline_risk_score"] + sum(c["contribution"] for c in full["increasing"] + full["decreasing"])
    assert total == pytest.approx(p.risk_score, abs=0.1)
    # The displayed list is a top-N subset of that full attribution, strongest first.
    shown = {c.feature: c.contribution for c in p.top_risk_factors}
    assert len(shown) <= predictor.cfg.top_factors
    assert all(full_c["contribution"] == shown[full_c["feature"]] for full_c in full["increasing"] if full_c["feature"] in shown)


def test_directions_and_ordering(predictor):
    p = predictor.predict(ELEVATED)
    assert p.top_risk_factors and all(c.direction == "increases_risk" and c.contribution > 0 for c in p.top_risk_factors)
    assert all(c.direction == "decreases_risk" and c.contribution < 0 for c in p.protective_factors)
    contribs = [c.contribution for c in p.top_risk_factors]
    assert contribs == sorted(contribs, reverse=True) and len(contribs) <= predictor.cfg.top_factors
    # a clearly low-risk profile is explained mostly by protective factors
    n = predictor.predict(NORMAL)
    assert sum(c.contribution for c in n.protective_factors) < -sum(c.contribution for c in n.top_risk_factors)


def test_the_expected_drivers_are_found_and_named_readably(predictor):
    p = predictor.predict(ELEVATED)
    names = {c.feature for c in p.top_risk_factors}
    assert {"distance_km", "missed_reminders"} <= names
    for c in p.top_risk_factors + p.protective_factors:
        assert c.label == FEATURE_LABELS[c.feature] and c.label in c.description and "points" in c.description
        assert "participant" not in c.feature
    assert next(c for c in p.top_risk_factors if c.feature == "distance_km").description.startswith("Distance from site: 60 km raises")


def test_no_causal_language_and_note_present(predictor):
    p = predictor.predict(ELEVATED)
    assert p.explanation_note == CAUSATION_NOTE and "not evidence" in CAUSATION_NOTE
    text = " ".join(c.description for c in p.top_risk_factors + p.protective_factors).lower()
    assert "cause" not in text and "because" not in text


def test_same_inputs_same_explanation(predictor):
    assert predictor.predict(ELEVATED).to_dict() == predictor.predict(ELEVATED).to_dict()


def test_explanation_failure_is_reported_not_fabricated(predictor, monkeypatch):
    def boom(*a, **k):
        raise ExplanationError("simulated failure")
    monkeypatch.setattr(RetentionExplainer, "explain_one", boom)
    p = predictor.predict(ELEVATED)
    assert p.explanation_status == "unavailable" and "simulated failure" in p.explanation_note
    assert p.top_risk_factors == [] and p.protective_factors == [] and p.baseline_risk_score is None
    assert 0 <= p.risk_score <= 100 and p.recommended_actions       # prediction + rule-based actions still work


def test_explainer_unavailable_is_reported(predictor, monkeypatch):
    monkeypatch.setattr(type(predictor), "_get_explainer", lambda self: None)
    p = predictor.predict(ELEVATED)
    assert p.explanation_status == "unavailable" and p.top_risk_factors == []
    assert predictor.predict(ELEVATED, explain=False).explanation_note == "explanation not requested"


def test_additivity_violation_raises(explainer, monkeypatch):
    class Bad:
        values = np.zeros((1, len(MODEL_FEATURES)))
        base_values = np.array([0.99])
    monkeypatch.setattr(explainer, "_explainer", lambda arr: Bad())
    with pytest.raises(ExplanationError, match="do not add up"):
        explainer.shap_values(_frame(NORMAL))


def test_unseen_site_can_be_explained(explainer):
    out = explainer.shap_values(_frame({**ELEVATED, "site_id": "SITE-NEW"}))
    assert np.isfinite(out["values"]).all()


def test_global_importance(explainer, small_df):
    imp = explainer.global_importance(preprocessing.split_features_target(small_df.head(40))[0])
    assert set(imp["feature"]) == set(MODEL_FEATURES) and (imp["mean_abs_contribution"] >= 0).all()
    assert imp["mean_abs_contribution"].is_monotonic_decreasing
    assert imp.iloc[0]["feature"] in ("distance_km", "missed_reminders")      # strongest generator coefficients (Phase 3)
    assert imp.set_index("feature").loc["age", "mean_abs_contribution"] < imp.iloc[0]["mean_abs_contribution"] / 2   # age is not in the label model


def test_make_contribution_and_describe_value():
    c = explain.make_contribution("distance_km", 40.0, 8.5)
    assert c["direction"] == "increases_risk" and "40 km" in c["description"] and "raises" in c["description"]
    c = explain.make_contribution("phone_changed", 0, -1.3)
    assert c["direction"] == "decreases_risk" and "no" in c["description"] and "lowers" in c["description"]
    assert explain.describe_value("age", None) == "not recorded" and explain.describe_value("age", float("nan")) == "not recorded"
