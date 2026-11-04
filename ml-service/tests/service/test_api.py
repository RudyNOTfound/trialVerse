from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from app.api.app import create_app
from app.api.settings import Settings
from svc_helpers import CONTRACT_FEATURES, integrity_body, risk_body

SEVERITIES = {"low", "medium", "high", "critical"}


# ---------------------------------------------------------------- health / ready
def test_health_needs_no_model(tmp_path):
    with TestClient(create_app(Settings(model_dir=tmp_path / "missing", ecg_dir=tmp_path))) as c:
        r = c.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok", "service": "trialguard-ml-service", "version": r.json()["version"]}


def test_ready_when_everything_loaded(client):
    r = client.get("/ready")
    j = r.json()
    assert r.status_code == 200 and j["ready"] is True and j["status"] == "ready"
    assert j["components"]["retention_model"]["loaded"] and j["components"]["integrity_engine"]["available"]
    assert all(j["components"]["artifacts"]["files"].values())


def test_not_ready_and_503_when_artifacts_missing(tmp_path):
    with TestClient(create_app(Settings(model_dir=tmp_path / "none", ecg_dir=tmp_path))) as c:
        r = c.get("/ready")
        assert r.status_code == 503 and r.json()["ready"] is False
        assert r.json()["components"]["retention_model"]["loaded"] is False and r.json()["components"]["artifacts"]["all_present"] is False
        assert "train" in r.json()["components"]["retention_model"]["error"].lower()
        p = c.post("/v1/risk/predict", json=risk_body())
        assert p.status_code == 503 and p.json()["error"]["code"] == "model_unavailable"
        assert c.post("/v1/retention/predict", json=CONTRACT_FEATURES).status_code == 503
        assert c.post("/v1/integrity/predict", json=integrity_body()).status_code == 200      # integrity does not need the model


def test_corrupt_artifact_does_not_crash_startup(model_dir, tmp_path):
    import shutil
    d = tmp_path / "m"
    shutil.copytree(model_dir, d)
    (d / "pipeline.joblib").write_bytes(b"garbage")
    with TestClient(create_app(Settings(model_dir=d, ecg_dir=tmp_path))) as c:
        assert c.get("/health").status_code == 200
        r = c.get("/ready")
        assert r.status_code == 503 and r.json()["components"]["retention_model"]["error"]


# ---------------------------------------------------------------- risk (contract)
def test_risk_valid_request_matches_contract_shape(client):
    r = client.post("/v1/risk/predict", json=risk_body())
    j = r.json()
    assert r.status_code == 200
    assert j["contractVersion"] == "1.1" and j["requestId"] == "req-123"
    assert j["modelName"] == "retention-dropout-risk" and j["modelVersion"].startswith("1.0.0+")
    assert 0 <= j["score"] <= 100 and isinstance(j["explanation"], str) and len(j["explanation"]) <= 2000
    assert 0 < len(j["factors"]) <= 50 and all({"name", "contribution", "detail"} <= set(f) for f in j["factors"])
    assert "not validated" in j["explanation"]
    assert j["retentionRiskLevel"] in {"low", "medium", "high"} and j["recommendedActions"]
    assert "confidence" not in j                      # zod `.optional()` rejects null; omit instead
    assert all(v is not None for v in j.values()) and all(f.get("detail") is not None for f in j["factors"])


def test_risk_score_equals_engine_prediction(client, settings):
    from app.retention.predict import RetentionPredictor
    expected = RetentionPredictor.load(settings.model_dir).predict(dict(CONTRACT_FEATURES, participant_id="x")).risk_score
    assert client.post("/v1/risk/predict", json=risk_body()).json()["score"] == pytest.approx(expected)


def test_request_id_preserved_in_body_and_header(client):
    r = client.post("/v1/risk/predict", json=risk_body(requestId="abc-999"), headers={"x-request-id": "hdr-1"})
    assert r.json()["requestId"] == "abc-999" and r.headers["x-request-id"] == "hdr-1"
    assert client.get("/health").headers["x-request-id"]                                  # generated when absent


def test_risk_optional_values_may_be_null_or_absent(client):
    f = dict(CONTRACT_FEATURES, age=None)
    del f["reimbursement_delay_days"]
    r = client.post("/v1/risk/predict", json=risk_body(f))
    assert r.status_code == 200


def test_risk_unknown_features_ignored(client):
    r = client.post("/v1/risk/predict", json=risk_body(dict(CONTRACT_FEATURES, patient_failed_otp_24h=6, visit_status="x")))
    assert r.status_code == 200


def test_risk_with_current_backend_features_is_refused_not_faked(client):
    body = risk_body({"patient_failed_otp_24h": 6, "patient_visits_7d": 1, "patient_missed_90d": 0}, featureSchemaVersion="1")
    r = client.post("/v1/risk/predict", json=body)
    e = r.json()["error"]
    assert r.status_code == 422 and e["code"] == "unsupported_feature_schema" and "site_id" in e["details"]["missingFeatures"]


def test_risk_missing_required_feature(client):
    f = dict(CONTRACT_FEATURES)
    del f["distance_km"]
    r = client.post("/v1/risk/predict", json=risk_body(f))
    assert r.status_code == 422 and r.json()["error"]["details"]["missingFeatures"] == ["distance_km"]


@pytest.mark.parametrize("bad", [{"distance_km": "far"}, {"distance_km": -4}, {"missed_reminders": 1.5}, {"visits_missed": 99},
                                 {"daily_wage_worker": 7}, {"age": 500}, {"distance_km": True}])
def test_risk_invalid_numeric_values(client, bad):
    r = client.post("/v1/risk/predict", json=risk_body(dict(CONTRACT_FEATURES, **bad)))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_features"


def test_risk_unknown_site_is_refused_on_the_contract_route(client):
    """Phase 6 decision D1 (intentional change): the contract route never scores without a site effect. The previous
    behaviour (200 + warning) is kept on the native /v1/retention/predict route (see test_contract_v11_risk.py)."""
    r = client.post("/v1/risk/predict", json=risk_body(dict(CONTRACT_FEATURES, site_id="SITE-ZZ")))
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_site_category"


def test_risk_wrong_entity_type_and_contract_version(client):
    assert client.post("/v1/risk/predict", json=risk_body(entityType="visit")).status_code == 422
    r = client.post("/v1/risk/predict", json=risk_body(contractVersion="2.0"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "unsupported_contract_version"
    assert client.post("/v1/risk/predict", json=risk_body(contractVersion="1.7")).status_code == 200      # minor bumps are fine


def test_risk_invalid_body(client):
    r = client.post("/v1/risk/predict", json={"nonsense": 1})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request" and r.json()["error"]["details"]
    r = client.post("/v1/risk/predict", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_internal_engine_error_is_500_and_service_recovers(client):
    state = client.app.state.svc
    original = state.predictor.predict
    state.predictor.predict = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    r = client.post("/v1/risk/predict", json=risk_body())
    assert r.status_code == 500 and r.json()["error"]["code"] == "internal_error" and "boom" not in r.text
    state.predictor.predict = original
    assert client.post("/v1/risk/predict", json=risk_body()).status_code == 200            # next request unaffected


def test_timeout_returns_504(model_dir, tmp_path):
    import time
    with TestClient(create_app(Settings(model_dir=model_dir, ecg_dir=tmp_path, request_timeout_s=0.2))) as c:
        c.app.state.svc.predictor.predict = lambda *a, **k: time.sleep(1.0)
        r = c.post("/v1/risk/predict", json=risk_body())
    assert r.status_code == 504 and r.json()["error"]["code"] == "timeout"


# ---------------------------------------------------------------- native retention
def test_retention_predict_native(client):
    r = client.post("/v1/retention/predict", json=dict(CONTRACT_FEATURES, participant_id="P-A-001"), headers={"x-request-id": "r1"})
    j = r.json()
    assert r.status_code == 200 and j["requestId"] == "r1" and j["participant_id"] == "P-A-001"
    assert j["risk_level"] in {"low", "medium", "high"} and j["top_risk_factors"] and j["recommended_actions"]
    assert {"action_type", "title", "reason", "priority"} <= set(j["recommended_actions"][0])


def test_retention_predict_rejects_unknown_and_missing(client):
    assert client.post("/v1/retention/predict", json=dict(CONTRACT_FEATURES, dropped_out=1)).status_code == 422
    assert client.post("/v1/retention/predict", json={"site_id": "SITE-A"}).status_code == 422


# ---------------------------------------------------------------- integrity (contract)
def test_integrity_valid_request_clean(client):
    r = client.post("/v1/integrity/predict", json=integrity_body())
    j = r.json()
    assert r.status_code == 200 and j["requestId"] == "int-1" and j["findings"] == []
    assert j["modelName"] and j["modelVersion"] and j["contractVersion"] == "1.1"


def test_integrity_findings_match_contract_schema(client):
    body = integrity_body(chain={"valid": False, "eventsChecked": 5, "errorCount": 1, "firstError": {"type": "hash", "seq": 3, "message": "bad"}},
                          events=[{"id": "e1", "seq": 1, "actorId": None, "action": "x", "entityType": "visit", "entityId": "v",
                                   "createdAt": "2026-10-30T10:00:00Z", "metadata": {}},
                                  {"id": "e9", "seq": 9, "actorId": None, "action": "x", "entityType": "visit", "entityId": "v",
                                   "createdAt": "2026-10-30T10:00:00Z", "metadata": {}}])
    j = client.post("/v1/integrity/predict", json=body).json()
    assert {f["ruleId"] for f in j["findings"]} == {"ml.chain_broken", "ml.audit_seq_gap"}
    for f in j["findings"]:
        assert set(f) <= {"ruleId", "entityType", "entityId", "severity", "score", "message", "details", "dedupeKey"}
        assert f["severity"] in SEVERITIES and f["message"] and isinstance(f["details"], dict) and len(f["ruleId"]) <= 100
        assert "fraud_probability" not in f and "fraud_probability" not in j
    assert j["findings"][0]["severity"] == "critical"                                   # most severe first


def test_integrity_invalid_and_wrong_version(client):
    assert client.post("/v1/integrity/predict", json={"requestId": "x"}).status_code == 422
    assert client.post("/v1/integrity/predict", json=integrity_body(contractVersion="3.0")).status_code == 400
    assert client.post("/v1/integrity/predict", json=integrity_body(events=[{"id": "e"}])).status_code == 422


def test_integrity_engine_error_is_500(client):
    client.app.state.svc.engine.scan_contract = lambda r: (_ for _ in ()).throw(ValueError("kaput"))
    r = client.post("/v1/integrity/predict", json=integrity_body())
    assert r.status_code == 500 and "kaput" not in r.text and r.json()["error"]["requestId"]


# ---------------------------------------------------------------- trial scan (non-contract)
def test_trial_scan_with_missing_ecg_file_reports_finding(client):
    visits = [dict(visit_id=f"V{i}", participant_id=f"P{i}", site_id="S", visit_number=1, scheduled_date="2026-03-01", status="completed",
                   device_timestamp="2026-03-01T11:00:00+05:30", entry_timestamp="2026-03-01T11:30:00+05:30", otp_verified=1,
                   systolic_bp=120, diastolic_bp=80, heart_rate=70) for i in range(3)]
    r = client.post("/v1/integrity/trial-scan", json={"requestId": "t1", "visits": visits,
                                                      "ecgs": [{"ecg_id": "e1", "image_file": "ecgs/none.png", "visit_id": "V0"}]})
    j = r.json()
    assert r.status_code == 200 and j["requestId"] == "t1"
    assert [f["ruleId"] for f in j["findings"] if f["ruleId"].startswith("ecg.")] == ["ecg.file_unavailable"]
    assert j["anomaly"]["status"] == "skipped"
    f = j["findings"][0]
    assert {"ruleId", "category", "severity", "entityType", "entityId", "siteId", "explanation", "evidence", "recommendedReviewAction"} <= set(f)


def test_trial_scan_validation(client):
    assert client.post("/v1/integrity/trial-scan", json={"visits": []}).status_code == 422
    assert client.post("/v1/integrity/trial-scan", json={"visits": [{"visit_id": "x"}]}).status_code == 422


# ---------------------------------------------------------------- reliability
def test_auth_required_only_when_key_configured(model_dir, tmp_path):
    with TestClient(create_app(Settings(model_dir=model_dir, ecg_dir=tmp_path, api_key="s3cret"))) as c:
        assert c.get("/health").status_code == 200 and c.get("/ready").status_code == 200
        assert c.post("/v1/integrity/predict", json=integrity_body()).status_code == 401
        assert c.post("/v1/integrity/predict", json=integrity_body(), headers={"authorization": "Bearer nope"}).status_code == 401
        assert c.post("/v1/integrity/predict", json=integrity_body(), headers={"authorization": "Bearer s3cret"}).status_code == 200


def test_body_size_limit(model_dir, tmp_path):
    with TestClient(create_app(Settings(model_dir=model_dir, ecg_dir=tmp_path, max_body_bytes=200))) as c:
        r = c.post("/v1/risk/predict", json=risk_body())
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"


def test_unknown_route_is_json_404(client):
    r = client.get("/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "http_error"


def test_logs_are_structured_and_hold_no_participant_data(client, caplog):
    with caplog.at_level(logging.INFO, logger="trialguard"):
        caplog.handler.setLevel(logging.INFO)
        client.app  # noqa: B018
        logging.getLogger("trialguard").propagate = True
        client.post("/v1/risk/predict", json=risk_body(dict(CONTRACT_FEATURES, site_id="SITE-A", distance_km=40), entityId="SECRET-ID-77"))
    text = " ".join(r.getMessage() + str(r.__dict__) for r in caplog.records)
    assert "SECRET-ID-77" not in text and "distance_km" not in text
    assert any(getattr(r, "event", None) == "request" and getattr(r, "status", None) == 200 for r in caplog.records)
