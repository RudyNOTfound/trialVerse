"""Contract v1.1 -- patient risk route (spec 01 §3). Test ids refer to 04_INTEGRATION_TEST_PLAN.md."""
from __future__ import annotations

import pytest

from svc_helpers import CONTRACT_FEATURES, risk_body

REQUIRED = ["site_id", "distance_km", "daily_wage_worker", "scheduled_visits", "missed_reminders", "side_effects_reported",
            "phone_changed", "visits_missed"]
V1_KEYS = dict(patient_failed_otp_24h=0, patient_visits_7d=0, patient_missed_90d=1, patient_unverified_overdue=0,
               patient_duplicate_reimbursements=0, patient_reimbursement_total_30d_cents=0)


def post(client, features=None, **kw):
    return client.post("/v1/risk/predict", json=risk_body(features, **kw))


# ---- T1 --------------------------------------------------------------------------------------------------
def test_t1_complete_payload_matches_engine_and_echoes_contract_1_1(client):
    feats = dict(CONTRACT_FEATURES, **V1_KEYS)                    # v1 keys are still sent alongside the new ones
    j = post(client, feats).json()
    direct = client.app.state.svc.predictor.predict(dict(CONTRACT_FEATURES))
    assert j["contractVersion"] == "1.1"                          # D13: fixed "1.1"
    assert j["score"] == pytest.approx(direct.risk_score, abs=1e-9)
    assert j["factors"] and j["modelName"] == "retention-dropout-risk"
    assert j["retentionRiskLevel"] == direct.risk_level and j["recommendedActions"] is not None
    assert "confidence" not in j                                  # omitted, never null (zod .optional() rejects null)
    assert all(v is not None for v in j.values())
    assert [f["contribution"] > 0 for f in j["factors"]] == sorted([f["contribution"] > 0 for f in j["factors"]], reverse=True)


def test_t1_contract_version_is_fixed_not_echoed(client):
    assert post(client, contractVersion="1.0").json()["contractVersion"] == "1.1"
    assert post(client, contractVersion="1.7").json()["contractVersion"] == "1.1"


# ---- T2 / D12 --------------------------------------------------------------------------------------------
@pytest.mark.parametrize("key", REQUIRED)
@pytest.mark.parametrize("how", ["omitted", "null"])
def test_t2_each_missing_required_feature_is_refused_never_defaulted(client, key, how):
    feats = dict(CONTRACT_FEATURES)
    feats.pop(key) if how == "omitted" else feats.__setitem__(key, None)
    r = post(client, feats)
    e = r.json()["error"]
    assert r.status_code == 422 and e["code"] == "unsupported_feature_schema"
    assert e["details"]["missingFeatures"] == [key] and e["details"]["featureSchemaVersion"] == "2"


def test_d12_scheduled_visits_has_no_default_on_the_contract_route_but_keeps_it_on_the_native_route(client):
    feats = {k: v for k, v in CONTRACT_FEATURES.items() if k != "scheduled_visits"}
    assert post(client, feats).status_code == 422
    assert client.post("/v1/retention/predict", json=feats).status_code == 200


def test_t2_missed_reminders_null_means_no_reminder_history_not_zero(client):
    r = post(client, dict(CONTRACT_FEATURES, missed_reminders=None))
    assert r.status_code == 422 and r.json()["error"]["details"]["missingFeatures"] == ["missed_reminders"]
    assert post(client, dict(CONTRACT_FEATURES, missed_reminders=0)).status_code == 200      # a real zero is fine


# ---- T3 --------------------------------------------------------------------------------------------------
def test_t3_optional_values_may_be_null_or_omitted_and_are_disclosed_not_hidden(client):
    feats = {k: v for k, v in CONTRACT_FEATURES.items() if k != "reimbursement_delay_days"}
    feats["age"] = None
    r = post(client, feats)
    j = r.json()
    assert r.status_code == 200 and 0 <= j["score"] <= 100
    assert "age not provided" in j["explanation"] and "reimbursement_delay_days not provided" in j["explanation"]
    assert "invented" not in j["explanation"].lower()


# ---- T4 --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bad", [{"distance_km": "far"}, {"distance_km": -4}, {"distance_km": True}, {"missed_reminders": 1.5},
                                 {"visits_missed": 9}, {"daily_wage_worker": 7}, {"age": 500}, {"scheduled_visits": 0},
                                 {"scheduled_visits": 101}, {"side_effects_reported": 2}, {"site_id": 5}])
def test_t4_invalid_values_are_422_with_field_message(client, bad):
    r = post(client, dict(CONTRACT_FEATURES, **bad))
    e = r.json()["error"]
    assert r.status_code == 422 and e["code"] in ("invalid_features", "unknown_site_category")
    assert e["message"]


def test_t4_visits_missed_cannot_exceed_scheduled_visits(client):
    r = post(client, dict(CONTRACT_FEATURES, scheduled_visits=4, visits_missed=5))
    assert r.status_code == 422 and "visits_missed" in r.json()["error"]["message"]


def test_t4_binary_inputs_accept_zero_one_or_boolean(client):
    assert post(client, dict(CONTRACT_FEATURES, daily_wage_worker=True, phone_changed=False)).status_code == 200


# ---- T5 / D1 ---------------------------------------------------------------------------------------------
def test_t5_unknown_site_category_is_422_and_lists_the_known_ones(client):
    r = post(client, dict(CONTRACT_FEATURES, site_id="SITE-ZZ"))
    e = r.json()["error"]
    assert r.status_code == 422 and e["code"] == "unknown_site_category"
    known = client.get("/ready").json()["components"]["retention_model"]["knownSiteCategories"]
    assert e["details"]["siteId"] == "SITE-ZZ" and e["details"]["knownSiteCategories"] == known


@pytest.mark.parametrize("sid", ["site-a", " SITE-A", "SITE-A ", "", "UUID-5c1e0000"])
def test_t5_site_matching_is_exact_never_fuzzy(client, sid):
    r = post(client, dict(CONTRACT_FEATURES, site_id=sid))
    assert r.status_code == 422                               # '' or unknown: never mapped to a known site


def test_t5_unmapped_site_null_or_omitted_is_refused(client):
    assert post(client, dict(CONTRACT_FEATURES, site_id=None)).json()["error"]["details"]["missingFeatures"] == ["site_id"]
    assert post(client, {k: v for k, v in CONTRACT_FEATURES.items() if k != "site_id"}).status_code == 422


def test_t5_native_route_is_unchanged_and_still_scores_unknown_sites_with_a_warning(client):
    r = client.post("/v1/retention/predict", json=dict(CONTRACT_FEATURES, site_id="SITE-ZZ"))
    assert r.status_code == 200 and any("SITE-ZZ" in w for w in r.json()["warnings"])


def test_d1_ready_exposes_known_site_categories(client):
    cats = client.get("/ready").json()["components"]["retention_model"]["knownSiteCategories"]
    assert cats == sorted(cats) and "SITE-A" in cats and len(cats) >= 2


def test_d1_ready_lists_nothing_when_model_not_loaded(tmp_path):
    from fastapi.testclient import TestClient
    from app.api.app import create_app
    from app.api.settings import Settings
    with TestClient(create_app(Settings(model_dir=tmp_path / "none", ecg_dir=tmp_path))) as c:
        assert c.get("/ready").json()["components"]["retention_model"]["knownSiteCategories"] == []


# ---- T6 / T20 --------------------------------------------------------------------------------------------
def test_t6_v1_only_features_are_refused_so_the_backend_falls_back(client):
    r = client.post("/v1/risk/predict", json=risk_body(dict(V1_KEYS), featureSchemaVersion="1", contractVersion="1.0"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "unsupported_feature_schema"
    assert set(r.json()["error"]["details"]["missingFeatures"]) == set(REQUIRED)


def test_t20_non_patient_entities_still_fall_back(client):
    for et in ("visit", "reimbursement"):
        r = post(client, V1_KEYS, entityType=et, featureSchemaVersion="1")
        assert r.status_code == 422 and r.json()["error"]["code"] == "unsupported_entity_type"


def test_unknown_extra_feature_keys_are_ignored_on_the_contract_route(client):
    a = post(client, dict(CONTRACT_FEATURES, dropped_out=1, participant_name="Ramesh Verma")).json()
    b = post(client).json()
    assert a["score"] == b["score"] and "Ramesh" not in str(a)


# ---- D7: the two risk scales stay distinct -----------------------------------------------------------------
def test_d7_explanation_labels_the_model_category_and_does_not_claim_a_platform_level(client):
    j = post(client).json()
    assert "retention model category: " + j["retentionRiskLevel"] in j["explanation"]
    assert "separate from the platform's risk levels" in j["explanation"]
    assert "level" not in j and "riskLevel" not in j                      # no backend-style field is invented
    assert j["retentionRiskLevel"] in ("low", "medium", "high")           # never 'critical': that exists only in the backend scale


def test_d7_engine_category_follows_model_thresholds_not_the_25_50_75_scale(client):
    """Whatever the score, the category is the model's own; it is allowed to disagree with a 25/50/75 reading."""
    pred = client.app.state.svc.predictor
    for site in ("SITE-A", "SITE-B", "SITE-C"):
        for d in (5, 40, 120):
            j = post(client, dict(CONTRACT_FEATURES, site_id=site, distance_km=d)).json()
            p = pred.predict_proba(dict(CONTRACT_FEATURES, site_id=site, distance_km=d))
            expected = "high" if p >= pred.t_high else "medium" if p >= pred.t_op else "low"
            assert j["retentionRiskLevel"] == expected


# ---- T17 / T18 ---------------------------------------------------------------------------------------------
def test_t17_major_version_two_is_rejected(client):
    r = post(client, contractVersion="2.0")
    assert r.status_code == 400 and r.json()["error"]["code"] == "unsupported_contract_version"


def test_t18_bearer_token(model_dir, tmp_path):
    from fastapi.testclient import TestClient
    from app.api.app import create_app
    from app.api.settings import Settings
    with TestClient(create_app(Settings(model_dir=model_dir, ecg_dir=tmp_path, api_key="s3cret"))) as c:
        body = risk_body()
        assert c.post("/v1/risk/predict", json=body).status_code == 401
        assert c.post("/v1/risk/predict", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.post("/v1/risk/predict", json=body, headers={"Authorization": "Bearer s3cret"}).status_code == 200
        assert c.get("/health").status_code == 200                                       # ops endpoints stay open
