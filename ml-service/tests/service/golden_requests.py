"""Golden request builder: Phase 3 synthetic CSVs (read-only) -> a contract v1.1 `trialData` payload.

The backend would send UTC instants, UUIDs and a site timezone; this builder does the same so the tests exercise the real
conversion path (UTC -> site-local). Phase 3 files are only read. Identifiers are deterministic (uuid5) and the maps back
to the Phase 3 ids are returned so findings can be compared with `fraud_ground_truth.csv`.

    python tests/service/golden_requests.py <phase3_output_dir> <out.json>      # write a fixture file (never into Phase 3 dirs)
"""
from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import pandas as pd

NS = uuid.UUID("6f1c2a0e-0000-4000-8000-00000000f00d")
SITE_TZ = "Asia/Kolkata"                 # Phase 3 timestamps carry +05:30; the demo sites are in India


def uid(kind: str, key: str) -> str:
    return str(uuid.uuid5(NS, f"{kind}:{key}"))


def _rows(path: Path) -> List[Dict[str, Any]]:
    df = pd.read_csv(path)
    return df.astype(object).where(df.notna(), None).to_dict("records")


def _utc(ts: Optional[str]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromisoformat(ts).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _local_midnight_utc(date_str: str, tz: str) -> str:
    d = datetime.fromisoformat(date_str)
    return d.replace(tzinfo=ZoneInfo(tz)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _usable(candidate: Optional[str], fallback: str) -> str:
    """A deliberately invalid/absent site timezone (negative tests) must not break building the unrelated scheduledAt."""
    try:
        ZoneInfo(candidate or "")
        return candidate  # type: ignore[return-value]
    except Exception:
        return fallback


def build_trial_data(demo_dir: Path, *, tz: str = SITE_TZ, with_ecgs: bool = True, exception_reason: Optional[str] = None) -> Dict[str, Any]:
    """`exception_reason`: when set, every missing-OTP visit is sent as a *documented* OTP exception with that reason."""
    d = Path(demo_dir) / "demo"
    visits, parts, ecgs = _rows(d / "visits.csv"), _rows(d / "participants.csv"), _rows(d / "ecg_metadata.csv")
    sites = sorted({v["site_id"] for v in visits})
    record_of_visit = {e["visit_id"]: e["ecg_record_id"] for e in ecgs}
    out_visits = []
    for v in visits:
        otp = None if v["otp_verified"] is None else bool(int(v["otp_verified"]))
        out_visits.append({
            "visitId": uid("visit", v["visit_id"]), "participantId": uid("participant", v["participant_id"]),
            "siteId": uid("site", v["site_id"]), "visitNumber": int(v["visit_number"]), "visitType": v["visit_type"],
            "status": v["status"], "scheduledAt": _local_midnight_utc(v["scheduled_date"], tz),
            "performedAt": _utc(v["device_timestamp"]), "enteredAt": _utc(v["entry_timestamp"]),
            "otpVerified": otp, "otpExceptionReason": exception_reason if otp is False else None,
            "systolicBp": v["systolic_bp"], "diastolicBp": v["diastolic_bp"], "heartRate": v["heart_rate"],
            "weightKg": v["weight_kg"], "glucoseMgDl": v["glucose_mg_dl"],
            "ecgRecordId": record_of_visit.get(v["visit_id"]) if with_ecgs else None})
    trial: Dict[str, Any] = {
        "scope": {"trialId": uid("trial", "demo"), "asOf": "2026-11-01T12:00:00.000Z"},
        "sites": [{"siteId": uid("site", s), "siteCode": s, "timezone": tz} for s in sites],
        "participants": [{"participantId": uid("participant", p["participant_id"]), "siteId": uid("site", p["site_id"]),
                          "droppedOut": bool(int(p["dropped_out"]))} for p in parts if p["participant_id"]],
        "visits": out_visits}
    if with_ecgs:
        trial["ecgs"] = [{"ecgRecordId": e["ecg_record_id"], "visitId": uid("visit", e["visit_id"]),
                          "participantId": uid("participant", e["participant_id"]), "siteId": uid("site", e["site_id"]),
                          "imageRef": e["image_file"]} for e in ecgs]
    return trial


def from_internal(visits: List[Dict[str, Any]], parts: List[Dict[str, Any]], *, tz: str = SITE_TZ, ecgs: Optional[List[Dict[str, Any]]] = None,
                  site_tz: Optional[Dict[str, Optional[str]]] = None, exception_reasons: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Small hand-built trials (tests/integrity/integ_helpers format) -> `trialData`. Ids are kept as given, so findings can be
    compared directly. `site_tz` overrides the timezone per site (None => the key is sent as null)."""
    site_tz = site_tz or {}
    exception_reasons = exception_reasons or {}
    sites = sorted({v["site_id"] for v in visits})
    zone = lambda s: site_tz.get(s, tz)  # noqa: E731
    out = []
    for v in visits:
        otp = None if v.get("otp_verified") is None else bool(int(v["otp_verified"]))
        out.append({"visitId": v["visit_id"], "participantId": v["participant_id"], "siteId": v["site_id"], "visitNumber": v["visit_number"],
                    "visitType": v.get("visit_type"), "status": v["status"],
                    "scheduledAt": _local_midnight_utc(v["scheduled_date"], _usable(zone(v["site_id"]), tz)),
                    "performedAt": _utc(v.get("device_timestamp")), "enteredAt": _utc(v.get("entry_timestamp")),
                    "otpVerified": otp, "otpExceptionReason": exception_reasons.get(v["visit_id"]) if otp is False else None,
                    "systolicBp": v.get("systolic_bp"), "diastolicBp": v.get("diastolic_bp"), "heartRate": v.get("heart_rate"),
                    "weightKg": v.get("weight_kg"), "glucoseMgDl": v.get("glucose_mg_dl"), "ecgRecordId": v.get("ecg_id")})
    trial: Dict[str, Any] = {"scope": {"trialId": "trial-1", "asOf": "2026-11-01T12:00:00.000Z"},
                             "sites": [{"siteId": s, "siteCode": s, "timezone": zone(s)} for s in sites],
                             "participants": [{"participantId": p["participant_id"], "siteId": p["site_id"], "droppedOut": bool(p["dropped_out"])} for p in parts],
                             "visits": out}
    if ecgs is not None:
        trial["ecgs"] = ecgs
    return trial


def id_maps(demo_dir: Path) -> Dict[str, Dict[str, str]]:
    """backend-style id -> Phase 3 id, for comparing findings with the ground truth."""
    d = Path(demo_dir) / "demo"
    return {"visit": {uid("visit", v["visit_id"]): v["visit_id"] for v in _rows(d / "visits.csv")},
            "site": {uid("site", s): s for s in {v["site_id"] for v in _rows(d / "visits.csv")}}}


def integrity_request(trial: Dict[str, Any], **kw: Any) -> Dict[str, Any]:
    body = {"contractVersion": "1.1", "requestId": "golden-1", "windowStart": "2026-10-25T12:00:00Z", "windowEnd": "2026-11-01T12:00:00Z",
            "events": [], "reimbursements": [], "openVisits": [],
            "chain": {"valid": True, "eventsChecked": 0, "errorCount": 0, "firstError": None}, "trialData": trial}
    body.update(kw)
    return body


if __name__ == "__main__":
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    if dst.resolve().is_relative_to(src.resolve()) if hasattr(Path, "is_relative_to") else str(dst.resolve()).startswith(str(src.resolve())):
        raise SystemExit("refusing to write inside the Phase 3 output directory")
    dst.write_text(json.dumps(integrity_request(build_trial_data(src)), indent=1))
    print(f"wrote {dst}")
