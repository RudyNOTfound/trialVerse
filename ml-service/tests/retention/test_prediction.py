import dataclasses
import json
import warnings

import numpy as np
import pandas as pd
import pytest

from app.retention import artifacts
from app.retention.predict import RetentionPredictor, assign_risk_level, load_ramesh_features
from app.retention.schemas import InvalidInputError, RetentionPrediction, validate_features
from helpers import ELEVATED, NORMAL


def test_output_schema(predictor):
    p = predictor.predict(NORMAL)
    assert isinstance(p, RetentionPrediction)
    d = p.to_dict()
    assert {"participant_id", "risk_score", "risk_level", "model_version", "top_risk_factors", "recommended_actions"} <= set(d)
    assert 0 <= p.risk_score <= 100 and p.risk_level in ("low", "medium", "high")
    assert p.model_version == predictor.model_version and p.participant_id == "N-1"
    json.dumps(d)   # JSON-serialisable


def test_elevated_risk_participant_scores_above_normal(predictor):
    n, e = predictor.predict(NORMAL), predictor.predict(ELEVATED)
    assert e.risk_score > n.risk_score + 20
    assert e.risk_level == "high" and n.risk_level == "low"
    assert e.flagged_for_support and not n.flagged_for_support


def test_participant_id_never_affects_the_prediction(predictor):
    a = predictor.predict({**ELEVATED, "participant_id": "AAA"})
    b = predictor.predict({**ELEVATED, "participant_id": "ZZZ-999"})
    c = predictor.predict({k: v for k, v in ELEVATED.items() if k != "participant_id"})
    assert a.risk_score == b.risk_score == c.risk_score and c.participant_id is None


def test_missing_optional_values(predictor):
    p = predictor.predict({**NORMAL, "age": None, "reimbursement_delay_days": None})
    assert 0 <= p.risk_score <= 100
    assert any("age not provided" in w for w in p.warnings) and any("reimbursement_delay_days not provided" in w for w in p.warnings)
    no_keys = {k: v for k, v in NORMAL.items() if k not in ("age", "reimbursement_delay_days")}
    assert predictor.predict(no_keys).risk_score == p.risk_score          # absent == null


def test_unseen_site_is_handled_with_a_warning(predictor):
    p = predictor.predict({**ELEVATED, "site_id": "SITE-NEW"})
    assert 0 <= p.risk_score <= 100 and any("not seen in training" in w for w in p.warnings)
    assert p.explanation_status == "ok"


@pytest.mark.parametrize("change", [
    {"distance_km": -5}, {"distance_km": float("nan")}, {"distance_km": float("inf")}, {"distance_km": "far"},
    {"distance_km": "10"}, {"distance_km": True}, {"age": 200}, {"age": "abc"}, {"daily_wage_worker": 2},
    {"daily_wage_worker": "yes"}, {"phone_changed": -1}, {"missed_reminders": 1.5}, {"missed_reminders": -1},
    {"visits_missed": 9}, {"scheduled_visits": 0}, {"site_id": ""}, {"site_id": None}, {"dropped_out": 1},
    {"unknown_field": 1}, {"reimbursement_delay_days": -2}, {"participant_id": 5},
])
def test_invalid_input_raises_clear_error(predictor, change):
    with pytest.raises(InvalidInputError):
        predictor.predict({**NORMAL, **change})


@pytest.mark.parametrize("payload", [None, [], "text", 5])
def test_non_mapping_input(predictor, payload):
    with pytest.raises(InvalidInputError, match="mapping"):
        predictor.predict(payload)


def test_missing_required_field_is_named(predictor):
    bad = {k: v for k, v in NORMAL.items() if k != "distance_km"}
    with pytest.raises(InvalidInputError, match="distance_km"):
        predictor.predict(bad)


def test_numpy_and_pandas_values_are_accepted():
    row = pd.DataFrame([{k: v for k, v in NORMAL.items() if k != "participant_id"}]).iloc[0].to_dict()
    assert isinstance(row["missed_reminders"], (int, np.integer))
    validate_features(row)
    validate_features({**NORMAL, "daily_wage_worker": np.int64(1), "distance_km": np.float64(3.5), "visits_missed": np.int64(2)})


@pytest.mark.parametrize("p,expected", [(0.05, "low"), (0.1799, "low"), (0.18, "medium"), (0.3899, "medium"), (0.39, "high"), (0.99, "high")])
def test_risk_level_boundaries(p, expected):
    assert assign_risk_level(p, 0.18, 0.39) == expected


def test_predictor_levels_follow_stored_thresholds(predictor):
    p = predictor.predict(ELEVATED)
    assert p.risk_level == assign_risk_level(p.risk_score / 100, predictor.t_op, predictor.t_high)
    assert predictor.t_op != 0.5


def test_artifact_roundtrip_and_no_retraining(trained, predictor, monkeypatch):
    import sklearn.base
    monkeypatch.setattr(sklearn.pipeline.Pipeline, "fit", lambda *a, **k: pytest.fail("inference must not retrain"))
    reloaded = RetentionPredictor.load(trained["model_dir"], trained["cfg"])
    assert reloaded.predict(ELEVATED).to_dict() == predictor.predict(ELEVATED).to_dict()


def test_artifact_errors(tmp_path, trained):
    with pytest.raises(artifacts.ArtifactError, match="Train first"):
        artifacts.load_artifacts(tmp_path)
    import shutil
    broken = tmp_path / "broken"
    shutil.copytree(trained["model_dir"], broken)
    meta = json.loads((broken / "metadata.json").read_text())
    meta["features"]["model_features"] = meta["features"]["model_features"][:-1]
    (broken / "metadata.json").write_text(json.dumps(meta))
    with pytest.raises(artifacts.ArtifactError, match="schema"):
        artifacts.load_artifacts(broken)


def test_ramesh_features_come_from_the_phase3_csv(demo_csv, trained):
    cfg = trained["cfg"]
    f = load_ramesh_features(cfg, demo_csv)
    row = pd.read_csv(demo_csv).query("participant_name == 'Ramesh Verma'").iloc[0]
    assert f["participant_id"] == row["participant_id"] and f["distance_km"] == row["distance_km"] == 40
    assert f["missed_reminders"] == 2 and f["reimbursement_delay_days"] == 12 and f["visits_missed"] >= 1 and f["site_id"] == "SITE-A"
    sites = pd.read_csv(demo_csv)  # Roorkee is SITE-A in Phase 3 config
    assert f["site_id"] == sites.loc[sites.participant_name == "Ramesh Verma", "site_id"].iloc[0]


def test_ramesh_risk_emerges_from_the_model(predictor, demo_csv, trained):
    f = load_ramesh_features(trained["cfg"], demo_csv)
    p = predictor.predict(f)
    cohort = pd.read_csv(demo_csv)
    scores = [predictor.predict_proba({**{c: (None if pd.isna(v) else (v.item() if hasattr(v, "item") else v)) for c, v in r.items() if c in f and c != "participant_id"}})
              for _, r in cohort.iterrows()]
    assert p.risk_score / 100 > np.quantile(scores, 0.75)            # top quartile of the 300-person cohort, per the model
    assert p.risk_level in ("medium", "high") and p.flagged_for_support
    # nothing hard-coded: removing the risk factors lowers the model's own score
    calmer = predictor.predict({**f, "distance_km": 5.0, "missed_reminders": 0, "reimbursement_delay_days": 2, "side_effects_reported": 0})
    assert calmer.risk_score < p.risk_score - 20
    saved = json.loads((trained["report_dir"] / "ramesh_demo.json").read_text())
    assert saved["prediction"]["risk_score"] == p.risk_score
    types = {a.action_type for a in p.recommended_actions}
    assert {"reimbursement_priority", "remote_or_home_visit"} <= types


def test_saved_artifacts_in_repo_if_present_are_consistent():
    from app.retention.config import RetentionConfig
    cfg = RetentionConfig()
    if not (cfg.model_dir / "pipeline.joblib").exists():
        pytest.skip("no trained artifacts in models/retention")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pred = RetentionPredictor.load(cfg.model_dir, cfg)
    meta = json.loads((cfg.model_dir / "metadata.json").read_text())
    assert pred.model_version == meta["model_version"]
    assert meta["thresholds"]["operational_threshold"] < meta["thresholds"]["high_threshold"]
    assert meta["data"]["split_sizes"]["test"] > 0
