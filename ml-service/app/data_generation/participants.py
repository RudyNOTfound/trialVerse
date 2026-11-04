"""Participant-level generation: the dropout training set, the 300-person demo cohort and the sites table."""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

from app.config import DropoutCoefficients, SiteProfile, TrialConfig
from app.data_generation.utils import make_rng, sigmoid

TRAINING_COLUMNS = [
    "participant_id", "site_id", "age", "distance_km", "daily_wage_worker", "scheduled_visits",
    "missed_reminders", "reimbursement_delay_days", "side_effects_reported", "phone_changed",
    "visits_missed", "dropped_out",
]

FIRST_NAMES_M = ["Arjun", "Vikram", "Suresh", "Mahesh", "Anil", "Rajesh", "Deepak", "Sanjay", "Manoj", "Prakash",
                 "Harish", "Naveen", "Kiran", "Rohit", "Amit", "Sunil", "Ravi", "Girish", "Dinesh", "Mohan"]
FIRST_NAMES_F = ["Sunita", "Anita", "Meena", "Lakshmi", "Kavita", "Pooja", "Savita", "Geeta", "Radha", "Nandini",
                 "Shobha", "Usha", "Padma", "Rekha", "Jyoti", "Asha", "Sarita", "Vandana", "Latha", "Divya"]
LAST_NAMES = ["Sharma", "Patil", "Nair", "Iyer", "Singh", "Gupta", "Joshi", "Kulkarni", "Reddy", "Menon",
              "Pillai", "Yadav", "Mishra", "Chauhan", "Rawat", "Bisht", "Deshmukh", "Pandey", "Thomas", "Das",
              "Khan", "Shukla", "Naidu", "Bhatt", "Kapoor"]


def dropout_logit(df: pd.DataFrame, coef: DropoutCoefficients, offset: "np.ndarray | float" = 0.0) -> np.ndarray:
    """Linear predictor z of the dropout model; missing numerics are imputed at their reference value."""
    dist = (df["distance_km"] - coef.distance_center_km) / coef.distance_scale_km
    delay = ((df["reimbursement_delay_days"].fillna(coef.reimbursement_center_days)
              - coef.reimbursement_center_days) / coef.reimbursement_scale_days)
    return (coef.intercept + offset
            + coef.distance * dist
            + coef.daily_wage * df["daily_wage_worker"]
            + coef.missed_reminders * df["missed_reminders"]
            + coef.reimbursement_delay * delay
            + coef.side_effects * df["side_effects_reported"]
            + coef.phone_changed * df["phone_changed"]
            + coef.visits_missed * df["visits_missed"]).to_numpy(dtype=float)


def dropout_probability(df: pd.DataFrame, coef: DropoutCoefficients, offset: "np.ndarray | float" = 0.0) -> np.ndarray:
    """P(dropout) = sigmoid(z)."""
    return sigmoid(dropout_logit(df, coef, offset))


def sample_features(rng: np.random.Generator, n: int, profile: SiteProfile, scheduled_visits: int) -> pd.DataFrame:
    """Draw correlated participant risk features for one site (no label)."""
    age = np.clip(rng.normal(profile.age_mean, profile.age_sd, n), 25, 80).round()
    distance = np.clip(rng.lognormal(np.log(profile.distance_median_km), 0.8, n), 1.0, 120.0).round(1)
    # Daily-wage workers skew towards longer travel.
    p_wage = np.clip(profile.daily_wage_rate + 0.002 * (distance - profile.distance_median_km), 0.05, 0.85)
    wage = (rng.random(n) < p_wage).astype(int)
    reminders = np.clip(rng.poisson(0.6 + 0.5 * wage + 0.01 * distance), 0, 8)
    delay = np.clip(rng.gamma(3.0, 2.0, n) + 1.5 * wage, 0, 45).round()
    side_effects = (rng.random(n) < 0.25).astype(int)
    phone_changed = (rng.random(n) < 0.08 + 0.04 * wage).astype(int)
    p_miss = np.clip(0.04 + 0.03 * reminders + 0.0015 * distance + 0.03 * side_effects, 0.0, 0.5)
    missed = rng.binomial(scheduled_visits - 2, p_miss)  # sporadic misses before any dropout
    return pd.DataFrame({
        "age": age, "distance_km": distance, "daily_wage_worker": wage,
        "scheduled_visits": scheduled_visits, "missed_reminders": reminders,
        "reimbursement_delay_days": delay, "side_effects_reported": side_effects,
        "phone_changed": phone_changed, "visits_missed": missed,
    })


def generate_training_data(cfg: TrialConfig) -> pd.DataFrame:
    """Dropout training set. Labels are Bernoulli draws from the logistic model (see README).

    All sites use the same label process (including the fraud site) so a model trained here
    does not learn fraud-site artefacts. Site offsets are not part of the observed features.
    """
    rng = make_rng(cfg.seed, "training")
    n = cfg.n_training_participants
    site_idx = rng.integers(0, len(cfg.sites), n)
    parts = []
    for i, profile in enumerate(cfg.sites):
        idx = np.flatnonzero(site_idx == i)
        feats = sample_features(rng, len(idx), profile, cfg.scheduled_visits)
        feats.index = idx
        feats["site_id"] = profile.site_id
        feats["_offset"] = profile.dropout_offset
        parts.append(feats)
    df = pd.concat(parts).sort_index()
    p = dropout_probability(df, cfg.dropout, df["_offset"].to_numpy())
    df["dropped_out"] = (rng.random(n) < p).astype(int)
    df = df.drop(columns="_offset")
    df.insert(0, "participant_id", [f"T-{i + 1:05d}" for i in range(n)])
    # Realistic missingness: age sometimes not captured; no reimbursement claim yet -> no delay value.
    df.loc[rng.random(n) < 0.01, "age"] = np.nan
    df.loc[rng.random(n) < 0.03, "reimbursement_delay_days"] = np.nan
    return df[TRAINING_COLUMNS].reset_index(drop=True)


def build_sites_table(cfg: TrialConfig, participants: pd.DataFrame) -> pd.DataFrame:
    """sites.csv: one row per site with a participant count."""
    counts = participants.groupby("site_id").size()
    return pd.DataFrame([{
        "site_id": s.site_id, "site_code": s.site_id.split("-")[-1], "name": s.name, "city": s.city,
        "state": s.state, "country": "India", "trial_id": cfg.trial_id,
        "n_participants": int(counts.get(s.site_id, 0)),
    } for s in cfg.sites])


def generate_demo_participants(cfg: TrialConfig) -> pd.DataFrame:
    """The 300-person demo cohort with enrollment dates, dropout labels and the special participant Ramesh.

    As returned, `visits_missed` is the count of sporadic (pre-dropout) misses the visit generator
    must realise; `generate_all` overwrites it with the final total from visits.csv. `dropout_visit`
    is the first visit number lost to dropout (0 for non-dropouts).
    """
    rng = make_rng(cfg.seed, "demo_participants")
    ramesh = cfg.ramesh
    rows = []
    for site_id, n in cfg.participants_per_site().items():
        profile = cfg.site(site_id)
        is_fraud = cfg.fraud.enabled and site_id == cfg.fraud.site_id
        has_ramesh = site_id == ramesh.site_id
        feats = sample_features(rng, n, profile, cfg.scheduled_visits)
        feats["site_id"] = site_id
        sex = np.where(rng.random(n) < 0.48, "female", "male")
        feats["sex"] = sex
        feats["_offset"] = profile.dropout_offset
        if has_ramesh:  # participant 0 of the site is overwritten with the scripted profile
            feats.loc[0, ["age", "distance_km", "missed_reminders", "reimbursement_delay_days",
                          "daily_wage_worker", "side_effects_reported", "phone_changed", "visits_missed", "sex"]] = [
                ramesh.age, ramesh.distance_km, ramesh.missed_reminders, ramesh.reimbursement_delay_days,
                ramesh.daily_wage_worker, ramesh.side_effects_reported, ramesh.phone_changed,
                len(ramesh.missed_visit_numbers), ramesh.sex]
        p = dropout_probability(feats, cfg.dropout, feats["_offset"].to_numpy())
        dropped = (rng.random(n) < p).astype(int)
        if is_fraud:
            dropped[:] = 0
            feats["visits_missed"] = 0
        if has_ramesh:
            dropped[0] = 0  # still active in the demo snapshot; the model must flag him as high risk
        feats["dropped_out"] = dropped
        # A dropout leaves between 2 and (scheduled-1) completed visits; always at least visit 1.
        feats["dropout_visit"] = np.where(
            dropped == 1, rng.integers(3, cfg.scheduled_visits + 1, n), 0)
        feats["_first"] = [rng.choice(FIRST_NAMES_F if s == "female" else FIRST_NAMES_M) for s in sex]
        feats["_last"] = rng.choice(LAST_NAMES, n)
        feats["enrollment_offset"] = rng.integers(0, cfg.enrollment_span_days + 1, n)
        if has_ramesh:
            feats.loc[0, "enrollment_offset"] = 0
        rows.append(feats)
    df = pd.concat(rows, ignore_index=True)
    df["participant_name"] = df["_first"] + " " + df["_last"]
    df["enrollment_date"] = [(cfg.enrollment_start + timedelta(days=int(d))).isoformat() for d in df["enrollment_offset"]]
    # Stable ids per site: P-A-001 ...
    df["participant_id"] = [f"P-{s.split('-')[-1]}-{k:03d}" for s, k in
                            zip(df["site_id"], df.groupby("site_id").cumcount() + 1)]
    ramesh_mask = (df["site_id"] == ramesh.site_id) & (df.groupby("site_id").cumcount() == 0)
    df.loc[ramesh_mask, "participant_name"] = ramesh.name
    df["status"] = np.where(df["dropped_out"] == 1, "dropped_out", "completed")
    for c in ["age", "daily_wage_worker", "missed_reminders", "reimbursement_delay_days", "side_effects_reported",
              "phone_changed", "visits_missed", "dropout_visit", "scheduled_visits"]:
        df[c] = df[c].astype(int)
    out = df[["participant_id", "participant_name", "site_id", "sex", "age", "enrollment_date", "distance_km",
              "daily_wage_worker", "scheduled_visits", "missed_reminders", "reimbursement_delay_days",
              "side_effects_reported", "phone_changed", "visits_missed", "dropped_out", "dropout_visit", "status"]].copy()
    return out
