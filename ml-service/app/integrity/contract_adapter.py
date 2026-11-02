"""Phase 6 `trialData` -> the integrity engine's internal visit/participant/ECG dicts.

Timestamps arrive as UTC instants (or with any offset). The engine's time-of-day and visit-window rules need the
*site-local* clock, so each timestamp is rewritten here with the site's IANA timezone. A site without a valid timezone
is rejected by the request schema (HTTP 422) -- this module never assumes one. An offset-less timestamp is passed on
unchanged so the existing `invalid_timestamp` rule reports it; it is never given a guessed offset.
"""
from __future__ import annotations

import functools
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo, available_timezones

from .findings import Finding


@functools.lru_cache(maxsize=1)
def _known_zones() -> frozenset:
    return frozenset(available_timezones())


def is_valid_iana(name: Any) -> bool:
    """Canonical IANA region names only ('Asia/Kolkata', 'UTC'). Offsets ('+05:30'), abbreviations ('IST'), legacy
    aliases without a region ('EST5EDT') and unknown names are rejected."""
    return isinstance(name, str) and (name == "UTC" or "/" in name) and name in _known_zones()


@functools.lru_cache(maxsize=512)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def parse_instant(value: Any) -> Optional[datetime]:
    """ISO-8601 -> datetime (naive if no offset). None when empty. ValueError when not ISO at all."""
    if value is None or value == "":
        return None
    return datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))


def to_local_iso(value: Any, tz: ZoneInfo) -> Optional[str]:
    """Instant -> ISO string in the site's local clock (with its UTC offset). Offset-less input is returned as-is."""
    dt = parse_instant(value)
    if dt is None:
        return None
    if dt.tzinfo is None:
        return str(value).strip()                       # reported as an invalid timestamp downstream, never guessed
    return dt.astimezone(tz).isoformat()


def to_internal(trial: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, str]]:
    """(visits, participants, ecgs, site_code_by_id) for `IntegrityEngine.scan_trial`. `trial` is a validated `TrialData`."""
    tz = {s.siteId: _zone(s.timezone) for s in trial.sites}
    codes = {s.siteId: s.siteCode for s in trial.sites}
    visits: List[Dict[str, Any]] = []
    for v in trial.visits:
        z = tz[v.siteId]
        sched = parse_instant(v.scheduledAt).astimezone(z)           # scheduledAt is validated to carry an offset
        visits.append({
            "visit_id": v.visitId, "participant_id": v.participantId, "site_id": v.siteId, "visit_number": v.visitNumber,
            "visit_type": v.visitType, "status": v.status, "scheduled_date": sched.date().isoformat(),
            "device_timestamp": to_local_iso(v.performedAt, z), "entry_timestamp": to_local_iso(v.enteredAt, z),
            "otp_verified": None if v.otpVerified is None else int(v.otpVerified),
            "otp_exception_reason": v.otpExceptionReason,
            "systolic_bp": v.systolicBp, "diastolic_bp": v.diastolicBp, "heart_rate": v.heartRate,
            "weight_kg": v.weightKg, "glucose_mg_dl": v.glucoseMgDl, "ecg_id": v.ecgRecordId})
    participants = [{"participant_id": p.participantId, "site_id": p.siteId, "dropped_out": p.droppedOut} for p in trial.participants]
    # Clusters are keyed on the capture (ecgRecordId), not on the image: a reused image has several records.
    ecgs = [{"ecg_id": e.ecgRecordId, "visit_id": e.visitId, "participant_id": e.participantId, "site_id": e.siteId,
             "image_file": e.imageRef} for e in (trial.ecgs or [])]
    return visits, participants, ecgs, codes


def relabel(findings: List[Finding], site_codes: Dict[str, str]) -> None:
    """Findings are produced with the backend's site id as the entity id. Add `details.siteCode` and name the site by
    its code in human-readable messages (ids stay in entityId / details.siteId)."""
    for f in findings:
        code = site_codes.get(f.site_id or "")
        if code:
            f.details["siteCode"] = code
            f.message = re.sub(r"(?<![\w-])" + re.escape(f.site_id) + r"(?![\w-])", lambda _m: code, f.message)
        if f.rule_id == "ecg.duplicate_image":
            f.details["ecgRecordIds"] = list(f.details.get("ecgIds", []))
            sites = [s for s in f.details.get("siteIds", []) if s in site_codes]
            if sites:
                f.details["siteCodes"] = [site_codes[s] for s in sites]


def merge_findings(*groups: List[Finding]) -> List[Finding]:
    """Concatenate, drop exact duplicates (same rule, entity and dedupe key; first/most severe kept), then sort."""
    from .findings import sort_findings
    seen: Dict[Tuple[str, str, str, str], Finding] = {}
    for f in sort_findings([x for g in groups for x in g]):
        seen.setdefault((f.rule_id, f.entity_type, f.entity_id, f.dedupe_key or ""), f)
    return sort_findings(list(seen.values()))
