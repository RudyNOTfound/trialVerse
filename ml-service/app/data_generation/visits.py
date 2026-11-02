"""Visit-level generation: schedules, outcomes, measurements, OTP status, timestamps, fraud and reimbursements."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import List, Tuple

import numpy as np
import pandas as pd

from app.config import TrialConfig
from app.data_generation.utils import iso_ist, make_rng, parse_ist

VISIT_TYPES = ["baseline", "week-4", "week-8", "week-12", "week-16", "week-20", "week-24", "end-of-study"]

VISIT_COLUMNS = [
    "visit_id", "participant_id", "site_id", "visit_number", "visit_type", "scheduled_date", "status",
    "device_timestamp", "entry_timestamp", "otp_verified", "systolic_bp", "diastolic_bp", "heart_rate",
    "weight_kg", "glucose_mg_dl", "ecg_id", "ecg_file",
]


def plan_outcomes(scheduled: int, dropout_visit: int, sporadic_missed: int, forced_missed: Tuple[int, ...],
                  rng: np.random.Generator) -> List[bool]:
    """Return completed? per visit number 1..scheduled.

    Visit 1 (baseline) is always attended. A dropout loses every visit from `dropout_visit` on;
    sporadic misses are scattered over the visits before that point.
    """
    completed = [True] * scheduled
    last_before = (dropout_visit - 1) if dropout_visit else scheduled
    if dropout_visit:
        for v in range(dropout_visit, scheduled + 1):
            completed[v - 1] = False
    if forced_missed:
        for v in forced_missed:
            completed[v - 1] = False
    else:
        candidates = np.arange(2, last_before + 1)
        k = int(min(sporadic_missed, len(candidates)))
        if k:
            for v in rng.choice(candidates, size=k, replace=False):
                completed[int(v) - 1] = False
    return completed


def _bp(base: float, within_sd: float, round5_rate: float, rng: np.random.Generator, lo: int, hi: int) -> int:
    value = base + rng.normal(0, within_sd)
    if round5_rate and rng.random() < round5_rate:
        value = 5 * round(value / 5)
    return int(np.clip(round(value), lo, hi))


def generate_visits(cfg: TrialConfig, participants: pd.DataFrame) -> pd.DataFrame:
    """One row per participant x scheduled visit, with measurements for attended visits only.

    Fraud-site-specific *measurement* behaviour (digit preference, low variance) is applied here through
    the site profile; OTP / timing fraud is applied afterwards by `inject_otp_batch_fraud`.
    """
    rng = make_rng(cfg.seed, "visits")
    rows = []
    for p in participants.itertuples(index=False):
        profile = cfg.site_profile_for_visits(p.site_id)
        is_fraud = cfg.fraud.enabled and p.site_id == cfg.fraud.site_id
        round5 = cfg.fraud.bp_round_to_5_rate if is_fraud else 0.0
        forced = cfg.ramesh.missed_visit_numbers if p.participant_name == cfg.ramesh.name else ()
        completed = plan_outcomes(p.scheduled_visits, int(p.dropout_visit), int(p.visits_missed), forced, rng)
        sbp0 = rng.normal(profile.sbp_mean, profile.sbp_between_sd)
        dbp0 = rng.normal(profile.dbp_mean, profile.dbp_between_sd)
        hr0 = rng.normal(profile.hr_mean, profile.hr_sd)
        weight0 = rng.normal(72 if p.sex == "female" else 80, 11)
        glucose0 = rng.normal(170, 30)
        enrolled = date.fromisoformat(p.enrollment_date)
        for v in range(1, p.scheduled_visits + 1):
            sched = enrolled + timedelta(days=cfg.visit_interval_days * (v - 1))
            row = {
                "visit_id": f"V-{p.participant_id[2:]}-{v:02d}", "participant_id": p.participant_id,
                "site_id": p.site_id, "visit_number": v, "visit_type": VISIT_TYPES[(v - 1) % len(VISIT_TYPES)],
                "scheduled_date": sched.isoformat(), "status": "completed" if completed[v - 1] else "missed",
            }
            if completed[v - 1]:
                jitter = 0 if v == 1 else int(np.clip(round(rng.normal(0, profile.visit_jitter_sd_days)), -3, 5))
                when = datetime.combine(sched + timedelta(days=jitter), time(int(rng.integers(9, 16)), int(rng.integers(0, 60))))
                delay_min = float(np.clip(rng.lognormal(np.log(30), 0.8), 5, 300))
                verified = 1 if rng.random() >= cfg.honest_otp_unverified_rate else 0
                if is_fraud:
                    verified = 1  # unverified visits at the fraud site are injected explicitly, in batches
                trend = v - 1
                sbp = _bp(sbp0, profile.sbp_within_sd, round5, rng, 90, 200)
                dbp = min(_bp(dbp0, profile.dbp_within_sd, round5, rng, 50, 120), sbp - 20)  # keep pulse pressure >= 20
                row.update({
                    "device_timestamp": iso_ist(when),
                    "entry_timestamp": iso_ist(when + timedelta(minutes=round(delay_min))),
                    "otp_verified": verified,
                    "systolic_bp": sbp,
                    "diastolic_bp": dbp,
                    "heart_rate": int(np.clip(round(hr0 + rng.normal(0, 4)), 45, 120)),
                    "weight_kg": round(float(weight0 - 0.15 * trend + rng.normal(0, 0.7)), 1),
                    "glucose_mg_dl": int(np.clip(round(glucose0 - 2.5 * trend + rng.normal(0, 14)), 70, 400)),
                })
            rows.append(row)
    df = pd.DataFrame(rows)
    for c in VISIT_COLUMNS:
        if c not in df.columns:
            df[c] = pd.NA
    df["otp_verified"] = df["otp_verified"].astype("Int64")
    return df[VISIT_COLUMNS]


def inject_otp_batch_fraud(cfg: TrialConfig, visits: pd.DataFrame) -> pd.DataFrame:
    """Site C pattern: completed visits without OTP verification, back-entered in late-night bursts.

    Mutates `visits` in place and returns ground-truth rows (visit_id, site_id, anomaly_type, detail).
    """
    f = cfg.fraud
    cols = ["visit_id", "site_id", "anomaly_type", "detail"]
    if not f.enabled or f.unverified_visits <= 0:
        return pd.DataFrame(columns=cols)
    rng = make_rng(cfg.seed, "fraud_otp")
    site_mask = (visits["site_id"] == f.site_id) & (visits["status"] == "completed")
    pool = visits[site_mask].copy()
    pool["_day"] = pool["device_timestamp"].map(lambda s: parse_ist(s).date())
    first, last = pool["_day"].min(), pool["_day"].max()
    span = (last - first).days
    base, extra = divmod(f.unverified_visits, f.batch_count)
    fractions = np.linspace(0.45, 0.9, f.batch_count) if f.batch_count > 1 else np.array([0.7])
    used: set = set()
    truth = []
    for b in range(f.batch_count):
        size = base + (1 if b < extra else 0)
        batch_day = first + timedelta(days=int(span * fractions[b]))
        # Back-entry: visits that happened 1-21 days before the burst, falling back to any earlier visit.
        eligible = pool[(pool["_day"] < batch_day) & (~pool["visit_id"].isin(used))]
        recent = eligible[eligible["_day"] >= batch_day - timedelta(days=21)]
        src = recent if len(recent) >= size else eligible
        chosen = rng.choice(src["visit_id"].to_numpy(), size=size, replace=False)
        t = datetime.combine(batch_day + timedelta(days=1), time(0)) + timedelta(
            minutes=int(rng.integers(f.batch_start_window_minutes[0], f.batch_start_window_minutes[1] + 1)))
        for vid in chosen:
            used.add(vid)
            i = visits.index[visits["visit_id"] == vid][0]
            visits.at[i, "otp_verified"] = 0
            visits.at[i, "entry_timestamp"] = iso_ist(t)
            truth.append({"visit_id": vid, "site_id": f.site_id, "anomaly_type": "unverified_batch_late_night_entry",
                          "detail": f"batch_{b + 1}"})
            t += timedelta(minutes=int(rng.integers(f.batch_gap_minutes[0], f.batch_gap_minutes[1] + 1)),
                           seconds=int(rng.integers(0, 60)))
    return pd.DataFrame(truth, columns=cols)


def generate_reimbursements(cfg: TrialConfig, visits: pd.DataFrame, participants: pd.DataFrame) -> pd.DataFrame:
    """One INR claim per OTP-verified completed visit; payment lag centres on the participant's typical delay."""
    rng = make_rng(cfg.seed, "reimbursements")
    delay_by_p = participants.set_index("participant_id")["reimbursement_delay_days"].to_dict()
    ok = visits[(visits["status"] == "completed") & (visits["otp_verified"] == 1)]
    rows = []
    for n, v in enumerate(ok.itertuples(index=False), start=1):
        claim = parse_ist(v.entry_timestamp).date()
        lag = int(max(1, round(delay_by_p[v.participant_id] + rng.integers(-2, 3))))
        paid = claim + timedelta(days=lag)
        is_paid = paid <= cfg.as_of_date
        rows.append({
            "reimbursement_id": f"R-{n:05d}", "participant_id": v.participant_id, "visit_id": v.visit_id,
            "site_id": v.site_id, "amount_inr": cfg.reimbursement_per_visit_inr, "currency": "INR",
            "claim_date": claim.isoformat(), "paid_date": paid.isoformat() if is_paid else "",
            "delay_days": lag, "status": "paid" if is_paid else "pending",
        })
    return pd.DataFrame(rows)
