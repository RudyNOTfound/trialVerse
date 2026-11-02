"""Contract v1.1 -- `trialData` on POST /v1/integrity/predict (spec 01 §4). Test ids refer to 04_INTEGRATION_TEST_PLAN.md."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1] / "integrity"))
from integ_helpers import fabricate_site, honest_trial, visit  # noqa: E402

from app.api.app import create_app  # noqa: E402
from app.api.settings import Settings  # noqa: E402
from golden_requests import build_trial_data, from_internal, id_maps, integrity_request  # noqa: E402

SEV = {"low", "medium", "high", "critical"}


def post(client, trial=None, **kw):
    body = integrity_request(trial, **kw) if trial is not None else integrity_request({}, **kw)
    if trial is None:
        body.pop("trialData")
    return client.post("/v1/integrity/predict", json=body)


def findings(r):
    assert r.status_code == 200, r.text
    return r.json()["findings"]


def rules(fs, site=None):
    return {f["ruleId"] for f in fs if site is None or f["details"].get("siteId") == site}


def assert_contract_finding(f):
    """Mirror of the backend's zod `integrityFindingSchema` (src/ml/contracts.ts): optional keys are absent, never null."""
    assert 1 <= len(f["ruleId"]) <= 100 and 1 <= len(f["entityType"]) <= 50 and 1 <= len(f["entityId"]) <= 100
    assert f["severity"] in SEV and 1 <= len(f["message"]) <= 1000
    assert "score" not in f or (isinstance(f["score"], (int, float)) and 0 <= f["score"] <= 1)
    assert "dedupeKey" not in f or (isinstance(f["dedupeKey"], str) and len(f["dedupeKey"]) <= 200)
    assert isinstance(f["details"], dict) and f["details"]["category"] in ("technical_violation", "suspicious_pattern", "data_quality")
    assert f["details"]["recommendedReviewAction"]
    assert not any(v is None for k, v in f.items())


@pytest.fixture(scope="module")
def honest():
    return honest_trial()


def one_visit(**kw):
    """A single completed visit as a (visits, parts) pair at one site."""
    v = visit(1, "SITE-X", "P-1", 1, **kw)
    return [v], [{"participant_id": "P-1", "site_id": "SITE-X", "dropped_out": False}]


# ================================================================ T7 / T12 / T13: golden Phase 3 scan
@pytest.fixture(scope="module")
def golden(model_dir_module, cfg, summary):
    s = Settings(model_dir=model_dir_module, ecg_dir=cfg.output_dir, request_timeout_s=120.0)
    with TestClient(create_app(s), raise_server_exceptions=False) as c:
        trial = build_trial_data(cfg.output_dir)
        r = c.post("/v1/integrity/predict", json=integrity_request(trial))
        assert r.status_code == 200, r.text
        yield {"findings": r.json()["findings"], "maps": id_maps(cfg.output_dir), "client": c, "trial": trial, "cfg": cfg}


@pytest.fixture(scope="module")
def model_dir_module(tmp_path_factory):
    """Integrity does not need the retention model, but the app expects a directory; reuse the session model."""
    from app.config import default_config
    from app.data_generation.participants import generate_demo_participants, generate_training_data
    from app.retention.config import RetentionConfig
    from app.retention.train import run_training
    root = tmp_path_factory.mktemp("gold_model")
    demo = root / "participants.csv"
    generate_demo_participants(default_config()).to_csv(demo, index=False)
    c = RetentionConfig(lr_C=(1.0,), hgb_learning_rate=(0.1,), hgb_max_depth=(2,), hgb_max_iter=(30,), bootstrap_resamples=20,
                        shap_background_rows=10, importance_rows=20, model_dir=root / "m", report_dir=root / "r", demo_participants_csv=demo)
    run_training(generate_training_data(default_config(n_training_participants=600)), c, c.model_dir, c.report_dir, demo_csv=demo)
    return c.model_dir


def test_t7_t12_golden_site_c_scan(golden):
    fs = golden["findings"]
    for f in fs:
        assert_contract_finding(f)
    maps, site_code = golden["maps"], lambda f: golden["maps"]["site"].get(f["details"].get("siteId"))
    c_rules = {f["ruleId"] for f in fs if site_code(f) == "SITE-C" and f["entityType"] == "site"}
    assert {"site.bp_digit_preference", "site.low_bp_variance", "site.missing_otp_rate", "site.late_night_entries", "site.delayed_entries",
            "site.high_retention", "site.anomaly_enrichment", "site.multiple_integrity_signals"} <= c_rules
    by = {f["ruleId"]: f for f in fs if f["entityType"] == "site" and site_code(f) == "SITE-C"}
    assert by["site.high_retention"]["severity"] == "low" and by["site.multiple_integrity_signals"]["severity"] == "high"
    assert len([f for f in fs if f["ruleId"] == "site.rapid_entry_cluster" and site_code(f) == "SITE-C"]) == 3
    # ids are the backend's, codes are for display only
    assert all(f["entityId"] in maps["site"] for f in fs if f["entityType"] == "site")
    assert all(f["details"]["siteCode"] == site_code(f) for f in fs if f["entityType"] == "site")
    assert not any(uuid in f["message"] for f in fs for uuid in maps["site"] if f["entityType"] == "site")        # message names the code, not the UUID
    assert any("SITE-C" in f["message"] for f in fs if f["entityType"] == "site" and site_code(f) == "SITE-C")


def test_t12_visit_findings_are_exactly_the_injected_ground_truth(golden):
    import pandas as pd
    truth = pd.read_csv(Path(golden["cfg"].output_dir) / "metadata" / "fraud_ground_truth.csv")
    inj = set(truth[truth.anomaly_type == "unverified_batch_late_night_entry"].visit_id)
    multi = {golden["maps"]["visit"][f["entityId"]] for f in golden["findings"] if f["ruleId"] == "visit.multiple_integrity_signals"}
    assert len(inj) == 18 and multi == inj


def test_t12_ecg_clusters_keyed_on_records(golden):
    dup = [f for f in golden["findings"] if f["ruleId"] == "ecg.duplicate_image"]
    assert len(dup) == 6
    for f in dup:
        d = f["details"]
        assert len(d["participantIds"]) == 4 and d["maxHammingDistance"] == 0 and d["crossParticipant"] is True
        assert len(d["ecgRecordIds"]) == 4 and len(set(d["ecgRecordIds"])) == 4          # one record per capture, not per image
        assert f["entityType"] == "ecg_cluster" and f["entityId"].startswith("ecg-cluster-") and len(f["entityId"]) <= 100


def test_t12_t13_honest_sites_stay_quiet(golden):
    quiet = [f for f in golden["findings"] if golden["maps"]["site"].get(f["details"].get("siteId")) in ("SITE-A", "SITE-B", "SITE-D", "SITE-E")]
    assert quiet and all(f["severity"] == "low" and f["details"]["category"] == "data_quality" for f in quiet)
    assert not [f for f in golden["findings"] if f["details"]["category"] == "technical_violation"]


def test_t7_contract_path_reproduces_the_native_scan(golden):
    """Same Phase 3 data through the legacy snake_case route (+05:30 offsets) and the v1.1 route (UTC + IANA zone) must agree."""
    from app.integrity.demo import run_demo
    native = run_demo(golden["cfg"].output_dir)["findings"]
    key = lambda rid, ent, sev: (rid, ent, sev)  # noqa: E731
    n = sorted(key(f.rule_id, f.entity_type, f.severity) for f in native)
    c = sorted(key(f["ruleId"], f["entityType"], f["severity"]) for f in golden["findings"])
    assert n == c
    nv = sorted(f.entity_id for f in native if f.entity_type == "visit")
    cv = sorted(golden["maps"]["visit"][f["entityId"]] for f in golden["findings"] if f["entityType"] == "visit")
    assert nv == cv


def test_t12_documented_exceptions_do_not_change_what_is_found(golden, cfg):
    """A documented OTP exception is evidence, never an exemption: the same findings and severities result."""
    trial = build_trial_data(cfg.output_dir, exception_reason="device_offline")
    fs = findings(golden["client"].post("/v1/integrity/predict", json=integrity_request(trial)))
    a = sorted((f["ruleId"], f["severity"]) for f in fs)
    b = sorted((f["ruleId"], f["severity"]) for f in golden["findings"])
    assert a == b
    docs = [f for f in fs if f["ruleId"] == "visit.multiple_integrity_signals"]
    assert all(f["details"]["signalEvidence"]["missing_otp"]["otpExceptionReason"] == "device_offline" for f in docs)


def test_t13_scan_without_site_c_has_no_site_finding_above_low(golden, cfg):
    trial = copy.deepcopy(golden["trial"])
    c_id = next(s["siteId"] for s in trial["sites"] if s["siteCode"] == "SITE-C")
    drop_v = {v["visitId"] for v in trial["visits"] if v["siteId"] == c_id}
    trial["sites"] = [s for s in trial["sites"] if s["siteId"] != c_id]
    trial["participants"] = [p for p in trial["participants"] if p["siteId"] != c_id]
    trial["visits"] = [v for v in trial["visits"] if v["visitId"] not in drop_v]
    trial["ecgs"] = [e for e in trial["ecgs"] if e["visitId"] not in drop_v]
    fs = findings(golden["client"].post("/v1/integrity/predict", json=integrity_request(trial)))
    assert not [f for f in fs if f["entityType"] == "site" and f["severity"] != "low"]
    assert not [f for f in fs if f["details"]["category"] == "technical_violation"]


# ================================================================ T8: optional parts
def test_t8_without_trial_data_only_audit_rules_run_and_nothing_is_fabricated(client):
    r = post(client)
    assert r.status_code == 200 and r.json()["contractVersion"] == "1.1" and r.json()["findings"] == []
    broken = post(client, chain={"valid": False, "eventsChecked": 9, "errorCount": 1, "firstError": {"type": "hash_mismatch", "seq": 4, "message": "bad"}})
    f = findings(broken)
    assert [x["ruleId"] for x in f] == ["ml.chain_broken"] and f[0]["severity"] == "critical" and f[0]["details"]["verifiedBy"] == "backend"


def test_t8_v1_0_payload_is_unchanged_behaviour(client):
    r = post(client, contractVersion="1.0")
    assert r.status_code == 200 and r.json()["findings"] == []


def test_t8_chain_verdict_is_reported_next_to_trial_findings_and_sorted_first(client, honest):
    v, p = honest
    trial = from_internal(v, p)
    r = post(client, trial, chain={"valid": False, "eventsChecked": 9, "errorCount": 1, "firstError": {"type": "hash_mismatch", "seq": 4, "message": "bad"}})
    fs = findings(r)
    assert fs[0]["ruleId"] == "ml.chain_broken"
    assert [f["severity"] for f in fs] == sorted((f["severity"] for f in fs), key=["critical", "high", "medium", "low"].index)


def test_t8_missing_optional_ecgs_skips_the_ecg_step(client, honest):
    v, p = honest
    fs = findings(post(client, from_internal(v, p)))
    assert not [f for f in fs if f["ruleId"].startswith("ecg.")]


def test_t8_missing_measurements_on_a_completed_visit_is_a_data_quality_finding(client):
    v, p = one_visit(systolic_bp=None, diastolic_bp=None, heart_rate=None)
    fs = findings(post(client, from_internal(v, p)))
    f = next(f for f in fs if f["ruleId"] == "visit.missing_mandatory")
    assert f["details"]["category"] == "data_quality" and f["severity"] == "low" and set(f["details"]["evidence"]["fields"]) >= {"systolic_bp", "heart_rate"}


@pytest.mark.parametrize("status", ["scheduled", "otp_pending", "verified", "cancelled", "missed"])
def test_t8_only_completed_visits_are_rule_checked(client, status):
    v, p = one_visit(status=status, systolic_bp=None, diastolic_bp=None, heart_rate=None, device_timestamp=None, entry_timestamp=None, otp_verified=None)
    assert not [f for f in findings(post(client, from_internal(v, p))) if f["ruleId"].startswith("visit.")]


def test_t8_every_backend_visit_status_is_accepted_and_others_rejected(client):
    v, p = one_visit()
    t = from_internal(v, p)
    t["visits"][0]["status"] = "paused"
    assert post(client, t).status_code == 422


# ================================================================ T9: implausible measurements
@pytest.mark.parametrize("bad", [dict(systolic_bp=300), dict(heart_rate=5), dict(systolic_bp=70, diastolic_bp=90), dict(weight_kg=500), dict(glucose_mg_dl=1)])
def test_t9_implausible_numbers_are_findings_not_errors(client, bad):
    v, p = one_visit(**bad)
    r = post(client, from_internal(v, p))
    f = [x for x in findings(r) if x["ruleId"] == "visit.implausible_measurement"]
    assert len(f) == 1 and f[0]["details"]["category"] == "data_quality" and f[0]["entityId"] == "V-SITE-X-00001"


@pytest.mark.parametrize("value", ["300", "high", True, [120]])
def test_t9_structurally_wrong_numeric_fields_are_422(client, value):
    v, p = one_visit()
    t = from_internal(v, p)
    t["visits"][0]["systolicBp"] = value
    r = post(client, t)
    assert r.status_code == 422 and "systolicBp" in json.dumps(r.json()["error"]["details"])


def test_t9_nan_and_infinity_are_422(client):
    v, p = one_visit()
    raw = json.dumps(integrity_request(from_internal(v, p))).replace('"systolicBp": 124', '"systolicBp": NaN')
    assert client.post("/v1/integrity/predict", content=raw, headers={"content-type": "application/json"}).status_code == 422


# ================================================================ T10: ECG references
def _png(path, seed):
    rng = np.random.default_rng(seed)
    base = np.kron(rng.integers(0, 255, (12, 12)).astype("uint8"), np.ones((8, 8), dtype="uint8"))
    Image.fromarray(base).save(path)


def ecg_trial(tmp_path, refs):
    """Three-site-free trial with one ECG per visit; `refs` = list of (imageRef, participant) tuples."""
    v, p = [], []
    for i, _ in enumerate(refs, 1):
        v.append(visit(i, "SITE-X", f"P-{i}", 1, ecg_id=f"R{i}"))
        p.append({"participant_id": f"P-{i}", "site_id": "SITE-X", "dropped_out": False})
    ecgs = [{"ecgRecordId": f"R{i}", "visitId": v[i - 1]["visit_id"], "participantId": f"P-{i}", "siteId": "SITE-X", "imageRef": ref}
            for i, (ref, _) in enumerate(refs, 1)]
    return from_internal(v, p, ecgs=ecgs)


def test_t10_bad_ecg_references_yield_findings_and_the_scan_completes(client, tmp_path):
    _png(tmp_path / "ok1.png", 1)
    _png(tmp_path / "ok2.png", 2)
    (tmp_path / "corrupt.png").write_bytes(b"not an image")
    refs = [("ok1.png", 0), ("ok2.png", 0), ("missing.png", 0), ("corrupt.png", 0), ("../secret.png", 0), ("/etc/passwd", 0), ("", 0)]
    fs = findings(post(client, ecg_trial(tmp_path, refs)))
    bad = {f["details"]["problem"] for f in fs if f["ruleId"] == "ecg.file_unavailable"}
    assert len([f for f in fs if f["ruleId"] == "ecg.file_unavailable"]) == 5
    assert any("not found" in b for b in bad) and any("not a readable image" in b for b in bad)
    assert any("escapes" in b for b in bad) and any("no image_file" in b for b in bad)
    assert all(f["severity"] == "medium" and f["details"]["category"] == "data_quality" for f in fs if f["ruleId"] == "ecg.file_unavailable")
    assert not [f for f in fs if f["ruleId"] == "ecg.duplicate_image"]                 # the two readable, distinct files are not duplicates


def test_t10_missing_image_ref_key_is_a_422_because_the_field_is_required(client, tmp_path):
    t = ecg_trial(tmp_path, [("x.png", 0)])
    del t["ecgs"][0]["imageRef"]
    assert post(client, t).status_code == 422


def test_t10_image_bytes_are_never_part_of_a_request(client, tmp_path):
    t = ecg_trial(tmp_path, [("x.png", 0)])
    t["ecgs"][0]["imageBase64"] = "AAAA"
    r = post(client, t)
    assert r.status_code == 200 and "AAAA" not in r.text                                # unknown keys are ignored, never used or echoed


def test_ecg_clusters_are_keyed_on_ecg_record_not_image_and_client_hashes_are_ignored(client, tmp_path):
    _png(tmp_path / "a.png", 1)
    (tmp_path / "a_copy.png").write_bytes((tmp_path / "a.png").read_bytes())
    _png(tmp_path / "b.png", 2)
    t = ecg_trial(tmp_path, [("a.png", 0), ("a_copy.png", 0), ("a.png", 0), ("b.png", 0)])      # a.png reused by two records
    for e, h in zip(t["ecgs"], ["ffffffffffffffff", "0000000000000000", "1234123412341234", "ffffffffffffffff"]):
        e["imagePhash"] = h                                                                # v1.1 does not accept client hashes
    dup = [f for f in findings(post(client, t)) if f["ruleId"] == "ecg.duplicate_image"]
    assert len(dup) == 1
    d = dup[0]["details"]
    assert sorted(d["ecgRecordIds"]) == ["R1", "R2", "R3"] and "R4" not in d["ecgRecordIds"] and d["maxHammingDistance"] == 0
    assert dup[0]["severity"] == "high" and dup[0]["entityId"].startswith("ecg-cluster-")


def test_ecg_visit_and_site_consistency_is_checked(client, tmp_path):
    t = ecg_trial(tmp_path, [("a.png", 0), ("b.png", 0)])
    t["visits"][0]["ecgRecordId"] = "R-UNLISTED"
    assert post(client, t).status_code == 422
    t = ecg_trial(tmp_path, [("a.png", 0), ("b.png", 0)])
    t["ecgs"][0]["participantId"] = "P-2"
    assert post(client, t).status_code == 422


# ================================================================ T11 / D2: timestamps and timezones
def test_t11_site_local_conversion_drives_the_night_rule(client):
    v, p = one_visit(device_timestamp="2026-04-29T20:00:00+00:00", entry_timestamp="2026-04-29T20:10:00+00:00", scheduled_date="2026-04-30")
    kol = [f["ruleId"] for f in findings(post(client, from_internal(v, p, tz="Asia/Kolkata")))]      # 01:40 local => night
    ny = [f["ruleId"] for f in findings(post(client, from_internal(v, p, tz="America/New_York")))]   # 16:10 local => daytime
    assert "visit.night_entry" in kol and "visit.night_entry" not in ny


def test_t11_utc_z_and_equivalent_offsets_give_identical_results(client):
    v, p = one_visit(device_timestamp="2026-04-29T20:00:00+00:00", entry_timestamp="2026-04-29T20:10:00+00:00", scheduled_date="2026-04-30")
    a = from_internal(v, p)
    b = copy.deepcopy(a)
    b["visits"][0]["performedAt"], b["visits"][0]["enteredAt"] = "2026-04-30T01:30:00+05:30", "2026-04-30T01:40:00+05:30"
    assert findings(post(client, a)) == findings(post(client, b))


def test_t11_window_rule_uses_the_site_local_scheduled_date(client):
    # scheduledAt 2026-04-16T20:30Z is 17 April in Kolkata. Performed 24 April local => 7 days (inside the 7-day window);
    # a UTC-date reading (16 April) would wrongly give 8 days.
    v, p = one_visit(device_timestamp="2026-04-24T10:00:00+05:30", entry_timestamp="2026-04-24T10:30:00+05:30", scheduled_date="2026-04-17")
    assert "visit.outside_window" not in rules(findings(post(client, from_internal(v, p, tz="Asia/Kolkata"))))
    v, p = one_visit(device_timestamp="2026-04-24T10:00:00+05:30", entry_timestamp="2026-04-24T10:30:00+05:30", scheduled_date="2026-04-16")
    t = from_internal(v, p, tz="UTC")                                                  # the same instants read in UTC
    assert "visit.outside_window" in rules(findings(post(client, t)))


def test_t11_offsetless_performed_or_entered_time_is_an_invalid_timestamp_finding_not_a_guess(client):
    v, p = one_visit()
    for field in ("performedAt", "enteredAt"):
        t = from_internal(v, p)
        t["visits"][0][field] = "2026-03-02T11:00:00"
        r = post(client, t)
        f = [x for x in findings(r) if x["ruleId"] == "visit.invalid_timestamp"]
        assert len(f) == 1 and "lacks a UTC offset" in json.dumps(f[0]["details"]) and f[0]["details"]["category"] == "data_quality"


@pytest.mark.parametrize("tz", ["Mars/Base", "+05:30", "IST", "EST5EDT", "", "asia/kolkata", "Asia/Kolkata ", "../etc/passwd", "Asia/"])
def test_d2_invalid_timezones_are_422_for_the_whole_call(client, tz):
    v, p = one_visit()
    r = post(client, from_internal(v, p, site_tz={"SITE-X": tz}))
    assert r.status_code == 422 and "timezone" in json.dumps(r.json()["error"]["details"])


@pytest.mark.parametrize("how", ["null", "missing"])
def test_d2_missing_timezone_is_never_assumed(client, how):
    v, p = one_visit()
    t = from_internal(v, p)
    t["sites"][0]["timezone"] = None
    if how == "missing":
        del t["sites"][0]["timezone"]
    assert post(client, t).status_code == 422


@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Lord_Howe"])
def test_d2_valid_canonical_names_are_accepted(client, tz):
    v, p = one_visit()
    assert post(client, from_internal(v, p, tz=tz)).status_code == 200


def test_t11_non_iso_and_offsetless_scheduled_values_are_422(client):
    v, p = one_visit()
    for field, bad in (("scheduledAt", "2026-03-02"), ("scheduledAt", "2026-03-02T00:00:00"), ("scheduledAt", "tomorrow"),
                       ("performedAt", "yesterday"), ("enteredAt", 12345)):
        t = from_internal(v, p)
        t["visits"][0][field] = bad
        assert post(client, t).status_code == 422, (field, bad)


# ================================================================ T14: insufficient data
def test_t14_small_sites_get_insufficient_data_and_no_comparative_tests(client):
    v, p = honest_trial(sites=("SITE-A", "SITE-B"), per_site=5, visits_each=4)
    fs = findings(post(client, from_internal(v, p)))
    assert {f["entityId"] for f in fs if f["ruleId"] == "site.insufficient_data"} == {"SITE-A", "SITE-B"}
    assert all(f["severity"] == "low" and f["details"]["category"] == "data_quality" for f in fs if f["entityType"] == "site")
    assert not [f for f in fs if f["ruleId"].startswith("site.") and f["ruleId"] not in ("site.insufficient_data", "site.rapid_entry_cluster")]


# ================================================================ D3 / D6: OTP exceptions and dropout flag
def test_d3_exception_reason_enum_and_consistency(client):
    v, p = one_visit(otp_verified=0)
    for reason in ("device_offline", "participant_unreachable", "otp_delivery_failed", "coordinator_override", "other"):
        assert post(client, from_internal(v, p, exception_reasons={v[0]["visit_id"]: reason})).status_code == 200
    bad = from_internal(v, p)
    bad["visits"][0]["otpExceptionReason"] = "forgot"
    assert post(client, bad).status_code == 422
    for otp in (True, None):
        t = from_internal(v, p)
        t["visits"][0].update(otpVerified=otp, otpExceptionReason="other")
        assert post(client, t).status_code == 422                                       # a reason only makes sense when OTP was not verified


def test_t28_missing_otp_is_a_low_review_signal_alone_and_never_fraud_or_technical(client):
    for reason in (None, "device_offline", "coordinator_override"):
        v, p = one_visit(otp_verified=0)
        fs = findings(post(client, from_internal(v, p, exception_reasons={v[0]["visit_id"]: reason} if reason else None)))
        (f,) = [x for x in fs if x["ruleId"] == "visit.missing_otp"]
        assert f["severity"] == "low" and f["details"]["category"] == "data_quality"      # same severity documented or not
        assert f["details"]["evidence"]["exceptionDocumented"] is bool(reason)
        assert f["details"]["evidence"].get("otpExceptionReason") == reason or reason is None
        text = (f["message"] + f["details"]["recommendedReviewAction"]).lower()
        assert "fraud" not in text and "not evidence of misconduct" in f["message"]
        assert ("exception" in text) == bool(reason) or reason is None


def test_t28_missing_otp_escalates_only_together_with_other_signals(client):
    late = dict(otp_verified=0, device_timestamp="2026-03-02T11:00:00+05:30", entry_timestamp="2026-03-02T23:50:00+05:30")
    for reason in (None, "device_offline"):
        v, p = one_visit(**late)
        fs = findings(post(client, from_internal(v, p, exception_reasons={v[0]["visit_id"]: reason} if reason else None)))
        (f,) = [x for x in fs if x["ruleId"] == "visit.multiple_integrity_signals"]
        assert f["severity"] == "medium" and f["details"]["category"] == "suspicious_pattern"
        assert {"missing_otp", "night_entry"} <= set(f["details"]["signals"])
        assert f["details"]["signalEvidence"]["missing_otp"].get("otpExceptionReason") == reason


@pytest.mark.parametrize("documented", [0, 6, 15])
def test_t29_site_missing_otp_rate_counts_documented_and_undocumented(client, honest, documented):
    v, p = honest
    v2, p2 = fabricate_site(v, p, "SITE-C", round_bp=False, flat_bp=False, no_otp=15)
    no_otp = [x["visit_id"] for x in v2 if x["site_id"] == "SITE-C" and x.get("otp_verified") == 0]
    reasons = {vid: "device_offline" for vid in no_otp[:documented]}
    fs = findings(post(client, from_internal(v2, p2, exception_reasons=reasons)))
    (f,) = [x for x in fs if x["ruleId"] == "site.missing_otp_rate"]
    assert f["details"]["siteCode"] == "SITE-C" and f["details"]["count"] == 15 and f["details"]["category"] == "suspicious_pattern"


def test_d6_dropped_out_is_required_and_strictly_boolean(client):
    v, p = one_visit()
    for mutate in (lambda t: t["participants"][0].pop("droppedOut"), lambda t: t["participants"][0].update(droppedOut=None),
                   lambda t: t["participants"][0].update(droppedOut="false"), lambda t: t["participants"][0].update(droppedOut=0)):
        t = from_internal(v, p)
        mutate(t)
        assert post(client, t).status_code == 422


def test_d6_dropped_out_flag_is_used_and_never_derived_from_visits(client, honest):
    v, p = honest
    base = findings(post(client, from_internal(v, p)))
    assert "site.high_retention" not in {f["ruleId"] for f in base}
    # Visits are untouched (they still show missed final visits at SITE-A); only the *flags* say nobody withdrew there.
    kept = [dict(x, dropped_out=False) if x["site_id"] == "SITE-A" else x for x in p]
    fs = findings(post(client, from_internal(v, kept)))
    (f,) = [x for x in fs if x["ruleId"] == "site.high_retention"]
    assert f["details"]["siteCode"] == "SITE-A" and f["details"]["site_rate"] == 1.0 and f["severity"] == "low"


# ================================================================ referential integrity and limits (T21)
def test_references_must_resolve_and_ids_must_be_unique(client):
    v, p = one_visit()
    cases = [lambda t: t["visits"][0].update(siteId="NOPE"), lambda t: t["visits"][0].update(participantId="NOPE"),
             lambda t: t["participants"][0].update(siteId="NOPE"), lambda t: t["visits"].append(dict(t["visits"][0])),
             lambda t: t["sites"].append(dict(t["sites"][0])), lambda t: t["participants"].append(dict(t["participants"][0]))]
    for mutate in cases:
        t = from_internal(v, p)
        mutate(t)
        assert post(client, t).status_code == 422


def test_t21_documented_list_caps_are_enforced(client):
    v, p = one_visit()
    base = from_internal(v, p)
    big = {"sites": lambda i: dict(base["sites"][0], siteId=f"S{i}"),
           "participants": lambda i: dict(base["participants"][0], participantId=f"P{i}"),
           "visits": lambda i: dict(base["visits"][0], visitId=f"V{i}"),
           "ecgs": lambda i: {"ecgRecordId": f"E{i}", "visitId": "V-SITE-X-00001", "participantId": "P-1", "siteId": "SITE-X", "imageRef": "x.png"}}
    for key, cap in (("sites", 200), ("participants", 5000), ("visits", 20000), ("ecgs", 2000)):
        t = copy.deepcopy(base)
        t[key] = [big[key](i) for i in range(cap + 1)]
        r = post(client, t)
        assert r.status_code == 422 and f"trialData.{key}" in json.dumps(r.json()["error"]["details"]), key


def test_t21_events_reimbursement_and_open_visit_caps_follow_the_spec(client):
    assert post(client, events=[{"id": str(i), "seq": i, "action": "a", "entityType": "e", "entityId": "x", "createdAt": "2026-01-01T00:00:00Z"}
                                for i in range(5001)]).status_code == 422
    assert post(client, reimbursements=[{"id": str(i), "patientId": "p", "visitId": "v", "category": "travel", "amountCents": 1, "status": "pending",
                                         "requestedBy": "u", "createdAt": "2026-01-01T00:00:00Z"} for i in range(2001)]).status_code == 422
    assert post(client, openVisits=[{"id": str(i), "patientId": "p", "status": "scheduled", "scheduledAt": "2026-01-01T00:00:00Z"}
                                    for i in range(2001)]).status_code == 422


def test_t21_full_20k_visit_payload_fits_the_default_body_limit_and_is_scanned(client):
    """20,000 visits / 2,500 participants at the documented cap: accepted, within ML_MAX_BODY_BYTES, answered 200."""
    import time
    v, p = honest_trial(sites=("SITE-A", "SITE-B", "SITE-C", "SITE-D", "SITE-E"), per_site=500, visits_each=8)
    assert len(v) == 20000
    body = json.dumps(integrity_request(from_internal(v, p))).encode()
    assert len(body) < Settings().max_body_bytes
    t0 = time.perf_counter()
    r = client.post("/v1/integrity/predict", content=body, headers={"content-type": "application/json"})
    elapsed = time.perf_counter() - t0
    assert r.status_code == 200 and len(r.json()["findings"]) <= 1000
    print(f"\n[T21] 20,000 visits: body {len(body) / 2**20:.1f} MB, {elapsed:.2f} s")
    assert elapsed < 10.0                                                 # the service's own deadline (ML_REQUEST_TIMEOUT_S)


def test_t21_oversized_body_is_413_and_the_default_limit_fits_a_20k_visit_payload(model_dir, tmp_path):
    assert Settings().max_body_bytes >= 25 * 1024 * 1024
    with TestClient(create_app(Settings(model_dir=model_dir, ecg_dir=tmp_path, max_body_bytes=2000))) as c:
        r = c.post("/v1/integrity/predict", content=b"{" + b" " * 3000 + b"}", headers={"content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"


# ================================================================ merge / sort / dedupe / cap
def test_merge_sorts_by_severity_and_drops_exact_duplicates():
    from app.integrity.contract_adapter import merge_findings
    from app.integrity.findings import Finding
    mk = lambda rid, sev, eid="x", dk="k", score=None: Finding(rid, "visit", eid, sev, "data_quality", "m", "r", dedupe_key=dk, score=score)  # noqa: E731
    out = merge_findings([mk("a", "low"), mk("b", "high")], [mk("a", "low"), mk("a", "medium", dk="other"), mk("c", "critical", eid="y")])
    assert [f.rule_id + f.severity for f in out] == ["ccritical", "bhigh", "amedium", "alow"]


def test_findings_are_capped_with_the_most_severe_kept():
    from app.integrity.config import IntegrityConfig
    from app.integrity.engine import IntegrityEngine
    from app.api.schemas import IntegrityRequest
    v, p = honest_trial(sites=("SITE-A", "SITE-B"), per_site=5, visits_each=4)
    for x in v:
        if x["status"] == "completed":
            x["systolic_bp"] = None                                  # many missing_mandatory findings
    req = IntegrityRequest(**integrity_request(from_internal(v, p), chain={"valid": False, "eventsChecked": 1, "errorCount": 1, "firstError": None}))
    eng = IntegrityEngine(IntegrityConfig(max_findings=5))
    out = eng.scan_request(req.model_dump(exclude={"trialData"}), req.trialData)
    assert len(out["findings"]) == 5 and out["truncated"] > 0 and out["findings"][0].rule_id == "ml.chain_broken"


# ================================================================ protocol / privacy
def test_t15_request_id_is_echoed_in_body_and_header(client):
    body = integrity_request({}, requestId="abc-1")
    body.pop("trialData")
    r = client.post("/v1/integrity/predict", json=body, headers={"x-request-id": "hdr-9"})
    assert r.status_code == 200 and r.json()["requestId"] == "abc-1" and r.headers["x-request-id"] == "hdr-9"


def test_t16_every_finding_satisfies_the_backend_schema(client, honest):
    v, p = honest
    v2, p2 = fabricate_site(v, p, "SITE-B")
    fs = findings(post(client, from_internal(v2, p2)))
    assert fs
    for f in fs:
        assert_contract_finding(f)


def test_pii_like_extra_keys_are_ignored_and_never_echoed(client):
    v, p = one_visit(otp_verified=0, systolic_bp=300)
    t = from_internal(v, p)
    t["participants"][0].update(participantName="Ramesh Verma", phone="+91 99999 00000", email="r@example.org", dob="1970-01-01")
    t["visits"][0].update(note="free text note", address="12 Some Street")
    t["sites"][0]["name"] = "Private Hospital"
    r = post(client, t)
    assert r.status_code == 200
    for needle in ("Ramesh", "99999", "example.org", "1970-01-01", "free text", "Some Street", "Private Hospital"):
        assert needle not in r.text


def test_findings_carry_only_ids_codes_and_measurements(client):
    v, p = one_visit(otp_verified=0, systolic_bp=300)
    blob = json.dumps(findings(post(client, from_internal(v, p))))
    assert "V-SITE-X-00001" in blob and "P-1" in blob           # pseudonymous ids only
