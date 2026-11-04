"""The service over a real TCP socket: uvicorn in a subprocess, plain `urllib` clients -- no TestClient, no in-process app.

Covers the realistic v1.1 flows: a Ramesh-like retention request and the Site C integrity scan built from the committed
Phase 3 demo data. Everything is synthetic. Skipped when the trained model or demo data are not present.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from golden_requests import build_trial_data, id_maps, integrity_request  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "generated_data"
KEY = "socket-test-key"
pytestmark = pytest.mark.skipif(not (ROOT / "models" / "retention" / "pipeline.joblib").is_file() or not (DATA / "demo" / "visits.csv").is_file(),
                                reason="trained model or Phase 3 demo data not present")

# Ramesh (P-A-001) as the backend derives him from stored rows: his reimbursement delay is the mean of 7 paid claims
# (14+10+13+12+11+10+11)/7 = 11.6 days. The Phase 3 CSV rounds it to 12, which gives 70.0 -- same participant, different input.
RAMESH = dict(site_id="SITE-A", age=52, distance_km=40, daily_wage_worker=1, scheduled_visits=8, missed_reminders=2,
              reimbursement_delay_days=11.6, side_effects_reported=1, phone_changed=0, visits_missed=1)


def call(base, path, body=None, key=KEY, raw=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(base + path, data=data, headers=headers, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


def risk_body(features, **kw):
    b = {"contractVersion": "1.1", "requestId": "sock-1", "entityType": "patient", "entityId": "P-A-001", "featureSchemaVersion": "2",
         "features": features, "requestedAt": "2026-11-03T09:00:00.000Z"}
    b.update(kw)
    return b


@pytest.fixture(scope="module")
def base():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {"PATH": "/usr/bin:/bin", "ML_API_KEY": KEY, "ML_ECG_DIR": str(DATA), "ML_LOG_LEVEL": "WARNING", "PYTHONPATH": str(ROOT)}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(240):
            if proc.poll() is not None:
                pytest.fail("uvicorn exited during start-up")
            try:
                if call(url, "/health", key=None)[0] == 200:
                    break
            except Exception:
                time.sleep(0.25)
        else:
            pytest.fail("service did not start within 60 s")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---- operations and authentication ------------------------------------------------------------------------------------
def test_health_and_ready_over_the_socket(base):
    st, j, h = call(base, "/health", key=None)
    assert st == 200 and j["status"] == "ok" and h.get("x-request-id")
    st, j, _ = call(base, "/ready", key=None)
    assert st == 200 and j["ready"] is True and j["contractVersion"] == "1.1"
    assert j["components"]["retention_model"]["knownSiteCategories"] == ["SITE-A", "SITE-B", "SITE-C", "SITE-D", "SITE-E"]
    assert "logistic_regression" in j["components"]["retention_model"]["modelVersion"]


def test_v1_endpoints_require_the_bearer_key_but_ops_endpoints_do_not(base):
    for key in (None, "wrong"):
        st, j, _ = call(base, "/v1/risk/predict", risk_body(RAMESH), key=key)
        assert st == 401 and j["error"]["code"] == "unauthorized" and "requestId" in j["error"]
        assert call(base, "/v1/integrity/predict", {}, key=key)[0] == 401


def test_request_id_is_echoed(base):
    req = urllib.request.Request(base + "/health", headers={"x-request-id": "abc-123"})
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.headers["x-request-id"] == "abc-123"


# ---- retention: a Ramesh-like request --------------------------------------------------------------------------------
def test_ramesh_like_request_is_scored_by_the_model_with_explanation_and_actions(base):
    st, j, _ = call(base, "/v1/risk/predict", risk_body(RAMESH))
    assert st == 200 and j["contractVersion"] == "1.1" and j["requestId"] == "sock-1"
    assert j["score"] == pytest.approx(69.2, abs=0.05)                         # 69.2 / 100 with the backend-derived inputs
    assert j["retentionRiskLevel"] == "high" and j["modelName"] == "retention-dropout-risk"
    assert "logistic_regression" in j["modelVersion"] and "confidence" not in j
    top = {f["name"]: f["contribution"] for f in j["factors"] if f["contribution"] > 0}
    assert top["missed_reminders"] == pytest.approx(10.5, abs=0.1) and top["reimbursement_delay_days"] == pytest.approx(9.7, abs=0.1)
    assert [f["contribution"] > 0 for f in j["factors"]] == sorted([f["contribution"] > 0 for f in j["factors"]], reverse=True)
    acts = {a["action_type"]: a for a in j["recommendedActions"]}
    assert {"reminder_escalation", "reimbursement_priority", "remote_or_home_visit"} <= set(acts)
    assert all(set(a) == {"action_type", "title", "reason", "priority"} and a["priority"] in ("high", "medium", "low") for a in acts.values())
    assert "retention model category: high" in j["explanation"] and "not validated for clinical use" in j["explanation"]


def test_same_participant_with_the_csv_rounded_delay_scores_70_0(base):
    st, j, _ = call(base, "/v1/risk/predict", risk_body(dict(RAMESH, reimbursement_delay_days=12)))
    assert st == 200 and j["score"] == pytest.approx(70.0, abs=0.05)


def test_scores_are_deterministic_across_calls(base):
    a = call(base, "/v1/risk/predict", risk_body(RAMESH))[1]
    b = call(base, "/v1/risk/predict", risk_body(RAMESH))[1]
    assert a["score"] == b["score"] and a["factors"] == b["factors"] and a["recommendedActions"] == b["recommendedActions"]


def test_a_participant_with_fewer_risk_drivers_scores_lower_and_gets_fewer_actions(base):
    calm = dict(RAMESH, distance_km=3, daily_wage_worker=0, missed_reminders=0, reimbursement_delay_days=2, side_effects_reported=0, visits_missed=0)
    hi, lo = call(base, "/v1/risk/predict", risk_body(RAMESH))[1], call(base, "/v1/risk/predict", risk_body(calm))[1]
    assert lo["score"] < hi["score"] and lo["retentionRiskLevel"] == "low" and len(lo["recommendedActions"]) < len(hi["recommendedActions"])


@pytest.mark.parametrize("patch,status,code", [
    ({"missed_reminders": None}, 422, "unsupported_feature_schema"),       # no reminder history: null, never scored as zero
    ({"scheduled_visits": None}, 422, "unsupported_feature_schema"),
    ({"site_id": "SITE-ZZ"}, 422, "unknown_site_category"),
    ({"site_id": None}, 422, "unsupported_feature_schema"),
    ({"distance_km": -5}, 422, "invalid_features"),
    ({"daily_wage_worker": "yes"}, 422, "invalid_features"),
])
def test_invalid_risk_requests_get_a_precise_422(base, patch, status, code):
    st, j, _ = call(base, "/v1/risk/predict", risk_body(dict(RAMESH, **patch)))
    assert st == status and j["error"]["code"] == code and j["error"]["requestId"]


def test_missed_reminders_zero_is_a_real_value_and_is_scored(base):
    assert call(base, "/v1/risk/predict", risk_body(dict(RAMESH, missed_reminders=0)))[0] == 200


def test_malformed_and_wrong_version_requests(base):
    assert call(base, "/v1/risk/predict", raw=b"{not json")[0] == 422
    st, j, _ = call(base, "/v1/risk/predict", risk_body(RAMESH, contractVersion="2.0"))
    assert st == 400 and j["error"]["code"] == "unsupported_contract_version"
    assert call(base, "/v1/risk/predict", risk_body(RAMESH, entityType="visit"))[1]["error"]["code"] == "unsupported_entity_type"


# ---- integrity: the Site C scan ---------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def site_c(base):
    trial = build_trial_data(DATA)
    t0 = time.perf_counter()
    st, j, _ = call(base, "/v1/integrity/predict", integrity_request(trial))
    return {"status": st, "body": j, "seconds": time.perf_counter() - t0, "maps": id_maps(DATA),
            "truth": pd.read_csv(DATA / "metadata" / "fraud_ground_truth.csv")}


def test_site_c_scan_over_the_socket_succeeds_quickly(site_c):
    assert site_c["status"] == 200 and site_c["body"]["contractVersion"] == "1.1"
    assert site_c["body"]["modelName"] == "trialguard-integrity" and site_c["seconds"] < 30
    assert 0 < len(site_c["body"]["findings"]) <= 1000


def test_site_c_late_night_unverified_batch_is_exactly_the_ground_truth(site_c):
    to_phase3 = site_c["maps"]["visit"]
    flagged = {to_phase3[f["entityId"]] for f in site_c["body"]["findings"] if f["ruleId"] == "visit.multiple_integrity_signals"}
    truth = set(site_c["truth"].query("anomaly_type == 'unverified_batch_late_night_entry'").visit_id)
    assert len(truth) == 18 and flagged == truth


def test_site_c_reused_ecgs_are_the_ground_truth_visits(site_c):
    to_phase3 = site_c["maps"]["visit"]
    clusters = [f for f in site_c["body"]["findings"] if f["ruleId"] == "ecg.duplicate_image"]
    got = {to_phase3[v] for c in clusters for v in c["details"]["visitIds"]}
    truth = set(site_c["truth"].query("anomaly_type == 'reused_ecg_image'").visit_id)
    assert len(truth) == 24 and got == truth and all(c["details"]["crossParticipant"] for c in clusters)


def test_only_site_c_gets_site_level_findings_and_the_expected_statistical_rules_fire(site_c):
    site_level = [f for f in site_c["body"]["findings"] if f["entityType"] == "site"]
    assert {site_c["maps"]["site"][f["entityId"]] for f in site_level} == {"SITE-C"}
    rules = {f["ruleId"] for f in site_level}
    assert {"site.bp_digit_preference", "site.low_bp_variance", "site.late_night_entries", "site.delayed_entries",
            "site.missing_otp_rate", "site.rapid_entry_cluster", "site.multiple_integrity_signals"} <= rules
    assert next(f for f in site_level if f["ruleId"] == "site.multiple_integrity_signals")["severity"] == "high"


def test_findings_are_evidence_based_and_never_accuse(site_c):
    for f in site_c["body"]["findings"]:
        assert f["severity"] in ("low", "medium", "high", "critical") and len(f["message"]) <= 1000 and f["details"].get("category")
        assert f["details"].get("recommendedReviewAction")
        assert not any(w in f["message"].lower() for w in ("fraudulent", "guilty", "committed fraud", "is fraud", "cheat"))
    assert all(f["severity"] == "low" for f in site_c["body"]["findings"] if f["ruleId"] == "visit.missing_otp")


def test_scan_is_repeatable(base, site_c):
    again = call(base, "/v1/integrity/predict", integrity_request(build_trial_data(DATA)))[1]
    key = lambda fs: sorted((f["ruleId"], f["entityId"], f["severity"], f.get("dedupeKey")) for f in fs)  # noqa: E731
    assert key(again["findings"]) == key(site_c["body"]["findings"])


def test_invalid_trial_data_is_refused_over_the_wire(base):
    trial = build_trial_data(DATA)
    bad_tz = json.loads(json.dumps(trial))
    bad_tz["sites"][0]["timezone"] = "Etc/GMT+5"
    st, j, _ = call(base, "/v1/integrity/predict", integrity_request(bad_tz))
    assert st == 422 and j["error"]["code"] == "invalid_request" and "timezone" in json.dumps(j)
    dangling = json.loads(json.dumps(trial))
    dangling["visits"][0]["ecgRecordId"] = "ECGR-DOES-NOT-EXIST"
    dangling.pop("ecgs")
    assert call(base, "/v1/integrity/predict", integrity_request(dangling))[0] == 422             # F1 regression, over HTTP


def test_audit_only_request_without_trial_data_still_works(base):
    body = integrity_request(build_trial_data(DATA))
    body.pop("trialData")
    st, j, _ = call(base, "/v1/integrity/predict", body)
    assert st == 200 and j["findings"] == []
