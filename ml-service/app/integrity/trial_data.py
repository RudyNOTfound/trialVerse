"""Normalises trial visit records (JSON dicts) into a frame the checks share."""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional

import pandas as pd

MEASURES = ("systolic_bp", "diastolic_bp", "heart_rate", "weight_kg", "glucose_mg_dl")


def parse_ts(value: Any) -> Optional[datetime]:
    """Timezone-aware ISO-8601 -> datetime; None when absent or unparsable (a missing offset is invalid)."""
    if value is None or (isinstance(value, float) and math.isnan(value)) or value == "":
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def prepare_visits(records: Iterable[Dict[str, Any]]) -> pd.DataFrame:
    rows: List[Dict[str, Any]] = []
    for r in records:
        dev, ent = parse_ts(r.get("device_timestamp")), parse_ts(r.get("entry_timestamp"))
        try:
            sched: Optional[date] = date.fromisoformat(str(r.get("scheduled_date")))
        except ValueError:
            sched = None
        row: Dict[str, Any] = {k: r.get(k) for k in ("visit_id", "participant_id", "site_id", "visit_number",
                                                     "visit_type", "status", "ecg_id")}
        row.update(scheduled_date=sched, device_dt=dev, entry_dt=ent,
                   device_raw=r.get("device_timestamp"), entry_raw=r.get("entry_timestamp"),
                   otp_verified=_num(r.get("otp_verified")), otp_exception_reason=r.get("otp_exception_reason"))
        for m in MEASURES:
            row[m] = _num(r.get(m))
        row["lag_hours"] = (ent - dev).total_seconds() / 3600 if ent and dev else None
        row["entry_hour"] = ent.hour if ent else None            # local hour in the timestamp's own offset
        row["window_offset_days"] = (dev.date() - sched).days if dev and sched else None
        rows.append(row)
    return pd.DataFrame(rows)
