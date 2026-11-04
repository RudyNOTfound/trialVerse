"""Visit-level rule checks. A single weak rule is a data-quality warning; only combined signals escalate."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List

import pandas as pd

from .config import VisitRuleConfig
from .findings import Finding

SIGNAL_TEXT = {
    "missing_otp": "completed without OTP verification",
    "late_entry": "entered long after the visit",
    "night_entry": "entered late at night",
    "outside_window": "performed outside the scheduled visit window",
    "implausible_measurement": "contains an implausible measurement",
    "invalid_timestamp": "has an invalid or inconsistent timestamp",
    "missing_mandatory": "is missing mandatory fields",
    "rapid_entry": "was entered in a rapid burst of entries",
}
# Rules that describe a defective record rather than behaviour; they never escalate on their own.
DATA_QUALITY_SIGNALS = {"implausible_measurement", "invalid_timestamp", "missing_mandatory"}
REVIEW = {
    "missing_otp": "Confirm with the site that the participant attended; obtain the OTP/consent record.",
    "late_entry": "Ask the site why the entry was delayed and compare with source documents.",
    "night_entry": "Check who entered data at this hour and why.",
    "outside_window": "Verify the actual visit date against source documents.",
    "implausible_measurement": "Query the measurement with the site for correction or confirmation.",
    "invalid_timestamp": "Query the timestamps with the site.",
    "missing_mandatory": "Request the missing fields from the site.",
}


def _is_night(hour: Any, cfg: VisitRuleConfig) -> bool:
    return hour is not None and not pd.isna(hour) and (hour >= cfg.night_start_hour or hour < cfg.night_end_hour)


def visit_signals(df: pd.DataFrame, cfg: VisitRuleConfig) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """visit_id -> {signal: evidence}. Missed visits legitimately have no measurements and are not checked."""
    out: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for r in df.itertuples(index=False):
        if r.status != "completed":
            continue
        s = out[r.visit_id]
        if r.otp_verified == 0:
            # Missing OTP is a signal that needs review, never proof of fraud. A documented exception is shown as
            # evidence but does not lower the severity or suppress the finding.
            s["missing_otp"] = {"otp_verified": 0, "exceptionDocumented": bool(r.otp_exception_reason),
                                **({"otpExceptionReason": r.otp_exception_reason} if r.otp_exception_reason else {})}
        if r.lag_hours is not None and not pd.isna(r.lag_hours) and r.lag_hours > cfg.late_entry_hours:
            s["late_entry"] = {"hours_after_visit": round(float(r.lag_hours), 1), "threshold_hours": cfg.late_entry_hours}
        if _is_night(r.entry_hour, cfg):
            s["night_entry"] = {"entry_timestamp": r.entry_raw}
        if r.window_offset_days is not None and not pd.isna(r.window_offset_days) and abs(r.window_offset_days) > cfg.visit_window_days:
            s["outside_window"] = {"days_from_schedule": int(r.window_offset_days), "window_days": cfg.visit_window_days}
        bad = {m: getattr(r, m) for m, (lo, hi) in cfg.plausible_ranges.items()
               if getattr(r, m) is not None and not pd.isna(getattr(r, m)) and not lo <= getattr(r, m) <= hi}
        sbp, dbp = r.systolic_bp, r.diastolic_bp
        if sbp is not None and dbp is not None and not pd.isna(sbp) and not pd.isna(dbp) and sbp <= dbp:
            bad["systolic_not_above_diastolic"] = f"{sbp}/{dbp}"
        if bad:
            s["implausible_measurement"] = bad
        invalid = []
        if r.device_raw not in (None, "") and pd.isna(r.device_dt):
            invalid.append("device_timestamp unparsable or lacks a UTC offset")
        if r.entry_raw not in (None, "") and pd.isna(r.entry_dt):
            invalid.append("entry_timestamp unparsable or lacks a UTC offset")
        if r.lag_hours is not None and not pd.isna(r.lag_hours) and r.lag_hours < -0.1:
            invalid.append("entry_timestamp is before device_timestamp")
        if invalid:
            s["invalid_timestamp"] = {"problems": invalid}
        missing = [f for f in cfg.mandatory_completed_fields if _missing(r, f)]
        if missing:
            s["missing_mandatory"] = {"fields": missing}
    return {k: v for k, v in out.items() if v}


def _missing(r: Any, field: str) -> bool:
    v = {"device_timestamp": r.device_raw, "entry_timestamp": r.entry_raw}.get(field, getattr(r, field, None))
    return v is None or v == "" or (isinstance(v, float) and pd.isna(v))


def rapid_entry_clusters(df: pd.DataFrame, cfg: VisitRuleConfig) -> List[Dict[str, Any]]:
    """Per site: groups of >= burst_min_entries completed entries inside burst_window_minutes."""
    clusters: List[Dict[str, Any]] = []
    done = df[(df.status == "completed") & df.entry_dt.notna()]
    for site, g in done.groupby("site_id"):
        g = g.sort_values("entry_dt")
        t = [x.timestamp() for x in g.entry_dt]
        ids = list(g.visit_id)
        i = 0
        while i < len(t):
            j = i
            while j + 1 < len(t) and t[j + 1] - t[i] <= cfg.burst_window_minutes * 60:
                j += 1
            if j - i + 1 >= cfg.burst_min_entries:
                clusters.append({"site_id": site, "visit_ids": ids[i:j + 1], "start": g.entry_raw.iloc[i],
                                 "end": g.entry_raw.iloc[j], "span_minutes": round((t[j] - t[i]) / 60, 1)})
                i = j + 1
            else:
                i += 1
    return clusters


def _review_action(signal: str, evidence: Dict[str, Any]) -> str:
    if signal == "missing_otp" and evidence.get("exceptionDocumented"):
        return (f"Review the recorded OTP exception (reason: {evidence.get('otpExceptionReason')}) against source documents; "
                "a documented exception is not proof of misconduct and does not remove the need for review.")
    if signal == "missing_otp":
        return REVIEW[signal] + " No OTP exception was documented for this visit."
    return REVIEW.get(signal, "Review the record.")


def visit_findings(df: pd.DataFrame, signals: Dict[str, Dict[str, Dict[str, Any]]], cfg: VisitRuleConfig) -> List[Finding]:
    site_of = dict(zip(df.visit_id, df.site_id))
    part_of = dict(zip(df.visit_id, df.participant_id))
    out: List[Finding] = []
    for vid, sig in signals.items():
        behavioural = [k for k in sig if k not in DATA_QUALITY_SIGNALS]
        base = {"participantId": part_of.get(vid), "signals": sorted(sig), "signalEvidence": sig}
        if len(sig) >= cfg.min_signals_for_review and behavioural:
            sev = "high" if len(sig) >= 3 else "medium"
            out.append(Finding(
                "visit.multiple_integrity_signals", "visit", vid, sev, "suspicious_pattern",
                f"Visit {vid} {'; '.join(SIGNAL_TEXT[k] for k in sorted(sig))}. Several independent signals together warrant review.",
                "Review this visit against source documents with the site coordinator before drawing conclusions.",
                {**base, "signalCount": len(sig)}, score=min(1.0, len(sig) / 5), dedupe_key=vid, site_id=site_of.get(vid)))
        else:
            for k, ev in sig.items():
                out.append(Finding(
                    f"visit.{k}", "visit", vid, "medium" if k in ("invalid_timestamp", "implausible_measurement") else "low",
                    "data_quality",
                    f"Visit {vid} {SIGNAL_TEXT[k]}. A single signal is a data-quality warning, not evidence of misconduct.",
                    _review_action(k, ev), {**base, "evidence": ev}, dedupe_key=vid, site_id=site_of.get(vid)))
    return out
