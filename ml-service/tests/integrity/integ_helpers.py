"""Builders for small integrity fixtures (imported as `integ_helpers` via conftest sys.path handling)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import numpy as np

IST = timezone(timedelta(hours=5, minutes=30))


def visit(i: int = 1, site: str = "SITE-X", pid: Optional[str] = None, n: int = 1, **kw: Any) -> Dict[str, Any]:
    """One honest completed visit, entered 30 minutes after the visit at midday. Override fields via kwargs."""
    d = date(2026, 3, 1) + timedelta(days=i % 60)
    dev = datetime(d.year, d.month, d.day, 11, 0, tzinfo=IST)
    base = {"visit_id": f"V-{site}-{i:05d}", "participant_id": pid or f"P-{site}-{i:05d}", "site_id": site, "visit_number": n,
            "visit_type": "week-4", "scheduled_date": d.isoformat(), "status": "completed",
            "device_timestamp": dev.isoformat(), "entry_timestamp": (dev + timedelta(minutes=30)).isoformat(),
            "otp_verified": 1, "systolic_bp": 124, "diastolic_bp": 82, "heart_rate": 72, "weight_kg": 70.0, "glucose_mg_dl": 110,
            "ecg_id": None}
    base.update(kw)
    return base


def honest_trial(sites=("SITE-A", "SITE-B", "SITE-C", "SITE-D"), per_site: int = 30, visits_each: int = 6, seed: int = 0):
    """Plausible multi-site trial: noisy BP with uniform last digits, mid-day entries, small entry lags,
    ~25% dropout at the final visit. Returns (visits, participants)."""
    rng = np.random.default_rng(seed)
    visits: List[Dict[str, Any]] = []
    parts: List[Dict[str, Any]] = []
    k = 0
    for s in sites:
        for p in range(per_site):
            pid = f"P-{s}-{p:03d}"
            dropped = bool(rng.random() < 0.25)
            parts.append({"participant_id": pid, "site_id": s, "dropped_out": dropped})
            base_sbp = rng.normal(130, 12)
            for n in range(1, visits_each + 1):
                k += 1
                d = date(2026, 1, 1) + timedelta(days=int(rng.integers(0, 150)) + 7 * n)
                hour, minute = int(rng.integers(9, 17)), int(rng.integers(0, 60))
                dev = datetime(d.year, d.month, d.day, hour, minute, tzinfo=IST)
                lag = timedelta(minutes=int(rng.integers(5, 180)))
                if dropped and n > visits_each - 2:
                    visits.append({"visit_id": f"V-{s}-{k:06d}", "participant_id": pid, "site_id": s, "visit_number": n,
                                   "visit_type": "x", "scheduled_date": d.isoformat(), "status": "missed", "device_timestamp": None,
                                   "entry_timestamp": None, "otp_verified": None, "systolic_bp": None, "diastolic_bp": None,
                                   "heart_rate": None, "weight_kg": None, "glucose_mg_dl": None, "ecg_id": None})
                    continue
                sbp = int(round(base_sbp + rng.normal(0, 9)))
                visits.append(visit(k, s, pid, n, scheduled_date=d.isoformat(), device_timestamp=dev.isoformat(),
                                    entry_timestamp=(dev + lag).isoformat(), systolic_bp=sbp,
                                    diastolic_bp=int(round(sbp * 0.62 + rng.normal(0, 5))), heart_rate=int(rng.normal(72, 9)),
                                    weight_kg=round(float(rng.normal(75, 10)), 1), glucose_mg_dl=int(rng.normal(120, 30)),
                                    visit_id=f"V-{s}-{k:06d}"))
    return visits, parts


def fabricate_site(visits, parts, site: str, *, round_bp=True, flat_bp=True, no_otp: int = 0):
    """Return copies of visits/parts where `site` shows fabrication-like patterns."""
    out = []
    n_otp = 0
    for v in visits:
        v = dict(v)
        if v["site_id"] == site and v["status"] == "completed":
            if flat_bp:
                v["systolic_bp"] = 120 + 5 * (int(v["visit_id"][-3:]) % 2)
                v["diastolic_bp"] = 80
            if round_bp:
                v["systolic_bp"] = int(5 * round(v["systolic_bp"] / 5))
                v["diastolic_bp"] = int(5 * round(v["diastolic_bp"] / 5))
            if n_otp < no_otp:
                v["otp_verified"] = 0
                n_otp += 1
        out.append(v)
    return out, [dict(p, dropped_out=False) if p["site_id"] == site else dict(p) for p in parts]
