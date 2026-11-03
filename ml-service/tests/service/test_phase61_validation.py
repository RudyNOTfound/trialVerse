"""Phase 6.1 regression tests: F1 (ECG reference validation), F2 (fixed-offset timezone names) and the documented location of
the OTP exception evidence. Self-contained: builds its own minimal `trialData`."""
from __future__ import annotations

import copy

import pytest

from app.integrity.contract_adapter import is_valid_iana
from svc_helpers import integrity_body


def trial(**over):
    t = {"scope": {"trialId": "t1", "asOf": "2026-11-01T12:00:00Z"},
         "sites": [{"siteId": "s1", "siteCode": "A", "timezone": "Asia/Kolkata"}],
         "participants": [{"participantId": "p1", "siteId": "s1", "droppedOut": False}],
         "visits": [{"visitId": "v1", "participantId": "p1", "siteId": "s1", "visitNumber": 1, "status": "completed",
                     "scheduledAt": "2026-10-20T04:00:00Z", "performedAt": "2026-10-20T04:30:00Z", "enteredAt": "2026-10-20T05:00:00Z",
                     "otpVerified": True, "systolicBp": 120, "diastolicBp": 80, "heartRate": 70, "weightKg": 70, "glucoseMgDl": 100}]}
    t.update(over)
    return t


def ecg(record="e1"):
    return {"ecgRecordId": record, "visitId": "v1", "participantId": "p1", "siteId": "s1", "imageRef": "no-such-file.png"}


def send(client, t):
    return client.post("/v1/integrity/predict", json=integrity_body(trialData=t))


def messages(r):
    return " ".join(d["message"] for d in r.json()["error"]["details"])


# ---- F1: every non-null ecgRecordId must resolve to an entry of ecgs[] ------------------------------------------------
def test_f1_ecg_record_id_with_ecgs_omitted_is_422(client):
    t = trial()
    t["visits"][0]["ecgRecordId"] = "e1"
    r = send(client, t)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
    assert "ecgRecordId e1" in messages(r) and "not in ecgs[]" in messages(r)


def test_f1_ecg_record_id_with_empty_ecgs_is_422(client):
    t = trial(ecgs=[])
    t["visits"][0]["ecgRecordId"] = "e1"
    r = send(client, t)
    assert r.status_code == 422 and "not in ecgs[]" in messages(r)


def test_f1_ecg_record_id_pointing_at_a_different_record_is_422(client):
    t = trial(ecgs=[ecg("e2")])
    t["visits"][0]["ecgRecordId"] = "e1"
    assert send(client, t).status_code == 422


def test_f1_ecg_record_id_with_matching_ecg_is_accepted(client):
    t = trial(ecgs=[ecg("e1")])
    t["visits"][0]["ecgRecordId"] = "e1"
    r = send(client, t)
    assert r.status_code == 200
    assert "ecg.file_unavailable" in {f["ruleId"] for f in r.json()["findings"]}      # the (missing) file is a finding, not a 422


@pytest.mark.parametrize("ecgs", [None, [], [ecg("e9")]], ids=["omitted", "empty", "unreferenced-record"])
def test_f1_null_ecg_record_id_is_accepted(client, ecgs):
    t = trial() if ecgs is None else trial(ecgs=ecgs)
    t["visits"][0]["ecgRecordId"] = None
    assert send(client, t).status_code == 200


def test_f1_omitting_ecg_record_id_entirely_is_accepted(client):
    assert send(client, trial()).status_code == 200


def test_f1_existing_ecg_consistency_checks_still_apply_when_ecgs_are_present(client):
    bad = ecg("e1")
    bad["siteId"] = "ghost"
    t = trial(ecgs=[bad])
    assert send(client, t).status_code == 422
    dup = trial(ecgs=[ecg("e1"), ecg("e1")])
    assert send(client, dup).status_code == 422


# ---- F2: fixed-offset 'Etc/GMT±N' names are offsets in disguise ---------------------------------------------------------
@pytest.mark.parametrize("name", ["Etc/GMT+5", "Etc/GMT-5", "Etc/GMT+12", "Etc/GMT-14", "Etc/GMT+0", "Etc/GMT-0", "Etc/GMT+1"])
def test_f2_etc_gmt_offset_names_are_rejected(client, name):
    assert not is_valid_iana(name)
    t = trial()
    t["sites"][0]["timezone"] = name
    r = send(client, t)
    assert r.status_code == 422 and "timezone" in messages(r)


@pytest.mark.parametrize("name", ["Asia/Kolkata", "Asia/Calcutta", "America/New_York", "Europe/London", "UTC", "Etc/UTC",
                                  "America/Argentina/Buenos_Aires", "Pacific/Kiritimati", "Australia/Adelaide"])
def test_f2_regional_zones_and_legacy_region_aliases_stay_accepted(client, name):
    assert is_valid_iana(name)
    t = trial()
    t["sites"][0]["timezone"] = name
    assert send(client, t).status_code == 200


@pytest.mark.parametrize("name", ["+05:30", "IST", "EST5EDT", "", "Nowhere/City", "GMT+5", "Etc/Nowhere", None, 5])
def test_f2_previous_rejections_are_unchanged(name):
    assert not is_valid_iana(name)


# ---- documented location of the OTP exception evidence (spec 01 §4.3) ----------------------------------------------------
def test_otp_exception_reason_location_on_a_single_signal_finding(client):
    t = trial()
    t["visits"][0].update(otpVerified=False, otpExceptionReason="device_offline")
    fs = [f for f in send(client, t).json()["findings"] if f["ruleId"] == "visit.missing_otp"]
    assert len(fs) == 1 and fs[0]["severity"] == "low"
    assert fs[0]["details"]["evidence"]["otpExceptionReason"] == "device_offline"
    assert "otpExceptionReason" not in fs[0]["details"]                       # not at the top level of details


def test_otp_exception_reason_location_on_a_combined_finding(client):
    t = trial()
    v = t["visits"][0]
    v.update(otpVerified=False, otpExceptionReason="coordinator_override", systolicBp=None, diastolicBp=None, heartRate=None,
             weightKg=None, glucoseMgDl=None)
    fs = [f for f in send(client, t).json()["findings"] if f["ruleId"] == "visit.multiple_integrity_signals"]
    assert len(fs) == 1
    assert fs[0]["details"]["signalEvidence"]["missing_otp"]["otpExceptionReason"] == "coordinator_override"


def test_otp_exception_without_a_reason_has_no_reason_key(client):
    t = trial()
    t["visits"][0]["otpVerified"] = False
    f = next(f for f in send(client, t).json()["findings"] if f["ruleId"] == "visit.missing_otp")
    assert "otpExceptionReason" not in f["details"]["evidence"]
    assert copy.deepcopy(f["details"]["evidence"])["exceptionDocumented"] is False
