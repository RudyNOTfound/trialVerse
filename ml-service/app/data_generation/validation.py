"""Data-quality validation. Pure checks over generated tables; no generation logic lives here."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import pandas as pd

from app.config import TrialConfig
from app.data_generation.utils import parse_ist, sha256_file


class DataValidationError(RuntimeError):
    """Raised when a critical validation check fails."""


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""
    skipped: bool = False

    def __post_init__(self) -> None:
        self.passed = bool(self.passed)  # numpy bools are not JSON serialisable


@dataclass
class Dataset:
    """All generated tables in one place (as loaded from disk or built in memory)."""

    training: pd.DataFrame
    participants: pd.DataFrame
    visits: pd.DataFrame
    sites: pd.DataFrame
    reimbursements: pd.DataFrame
    ecg_metadata: pd.DataFrame
    ecg_dir: Path


def load_dataset(output_dir: Path) -> Dataset:
    """Read the generated CSVs back from disk."""
    d = Path(output_dir)
    return Dataset(
        training=pd.read_csv(d / "training" / "dropout_training.csv"),
        participants=pd.read_csv(d / "demo" / "participants.csv"),
        visits=pd.read_csv(d / "demo" / "visits.csv"),
        sites=pd.read_csv(d / "demo" / "sites.csv"),
        reimbursements=pd.read_csv(d / "demo" / "reimbursements.csv"),
        ecg_metadata=pd.read_csv(d / "demo" / "ecg_metadata.csv"),
        ecg_dir=d / "ecgs",
    )


def _ends_05(s: pd.Series) -> float:
    return float((s.dropna().astype(int) % 5 == 0).mean())


def _late_night(ts: str, start: int, end: int) -> bool:
    h = parse_ist(ts).hour
    return h >= start or h < end


def _unverified_entries(visits: pd.DataFrame, site_id: str) -> pd.DataFrame:
    u = visits[(visits["site_id"] == site_id) & (visits["status"] == "completed") & (visits["otp_verified"] == 0)].copy()
    u["_entry"] = u["entry_timestamp"].map(parse_ist)
    return u.sort_values("_entry")


def _max_burst(entries: pd.Series, window_minutes: int = 10) -> int:
    """Largest number of entries falling inside any sliding window of `window_minutes`."""
    t = sorted(entries)
    best = 0
    for i in range(len(t)):
        best = max(best, sum(1 for x in t[i:] if (x - t[i]).total_seconds() <= window_minutes * 60))
    return best


def structural_checks(ds: Dataset, cfg: TrialConfig) -> List[CheckResult]:
    """Keys, relationships, schedules, ranges, booleans and ECG file references."""
    p, v, s, r, e, t = ds.participants, ds.visits, ds.sites, ds.reimbursements, ds.ecg_metadata, ds.training
    out: List[CheckResult] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        out.append(CheckResult(name, bool(ok), detail))

    add("counts: training participants", len(t) == cfg.n_training_participants, f"{len(t)}")
    add("counts: demo participants", len(p) == cfg.n_demo_participants, f"{len(p)}")
    add("counts: sites", s["site_id"].nunique() == len(cfg.sites), f"{s['site_id'].nunique()}")
    add("unique participant ids", p["participant_id"].is_unique and t["participant_id"].is_unique)
    add("unique visit ids", v["visit_id"].is_unique)
    add("valid site ids", set(p["site_id"]) <= set(s["site_id"]) and set(v["site_id"]) <= set(s["site_id"])
        and set(t["site_id"]) <= set(s["site_id"]))
    add("visit -> participant exists", v["participant_id"].isin(p["participant_id"]).all())
    site_of = p.set_index("participant_id")["site_id"]
    add("visit site matches participant site", (v["participant_id"].map(site_of) == v["site_id"]).all())
    add("eight visits per participant", (v.groupby("participant_id").size() == cfg.scheduled_visits).all()
        and v["participant_id"].nunique() == len(p))
    add("visit numbers 1..N", (v.groupby("participant_id")["visit_number"].apply(
        lambda x: sorted(x) == list(range(1, cfg.scheduled_visits + 1)))).all())
    add("reimbursement -> visit/participant exists",
        r["visit_id"].isin(v["visit_id"]).all() and r["participant_id"].isin(p["participant_id"]).all())
    add("reimbursements only for verified completed visits",
        len(r) == len(v[(v["status"] == "completed") & (v["otp_verified"] == 1)]))
    add("reimbursement amount", (r["amount_inr"] == cfg.reimbursement_per_visit_inr).all())

    # Date ranges
    enrol = pd.to_datetime(p["enrollment_date"])
    sched = pd.to_datetime(v["scheduled_date"])
    add("enrollment dates in window", (enrol >= pd.Timestamp(cfg.enrollment_start)).all()
        and (enrol <= pd.Timestamp(cfg.enrollment_start) + pd.Timedelta(days=cfg.enrollment_span_days)).all())
    add("scheduled dates before as-of date", (sched <= pd.Timestamp(cfg.as_of_date)).all())
    done = v[v["status"] == "completed"]
    dev = done["device_timestamp"].map(parse_ist)
    ent = done["entry_timestamp"].map(parse_ist)
    add("entry timestamp not before device timestamp", (ent >= dev).all())
    add("missed visits carry no measurements",
        v[v["status"] == "missed"][["device_timestamp", "systolic_bp", "glucose_mg_dl", "otp_verified"]].isna().all().all())

    # Numerical ranges
    add("age range", t["age"].dropna().between(18, 90).all() and p["age"].between(18, 90).all())
    add("distance range", t["distance_km"].between(0, 200).all() and p["distance_km"].between(0, 200).all())
    add("reimbursement delay range", t["reimbursement_delay_days"].dropna().between(0, 60).all())
    add("visits_missed range", t["visits_missed"].between(0, cfg.scheduled_visits).all())
    add("bp/hr/weight/glucose ranges",
        done["systolic_bp"].between(80, 220).all() and done["diastolic_bp"].between(40, 130).all()
        and (done["systolic_bp"] > done["diastolic_bp"]).all() and done["heart_rate"].between(35, 140).all()
        and done["weight_kg"].between(30, 200).all() and done["glucose_mg_dl"].between(40, 500).all())

    # Booleans
    bool_cols = ["daily_wage_worker", "side_effects_reported", "phone_changed", "dropped_out"]
    add("boolean fields are 0/1", all(set(t[c].unique()) <= {0, 1} for c in bool_cols)
        and all(set(p[c].unique()) <= {0, 1} for c in bool_cols)
        and set(done["otp_verified"].dropna().unique()) <= {0, 1} and done["otp_verified"].notna().all())

    # Training label sanity
    rate = float(t["dropped_out"].mean())
    add("training class balance 15-45%", 0.15 <= rate <= 0.45, f"dropout rate {rate:.3f}")
    feats = ["age", "distance_km", "daily_wage_worker", "missed_reminders", "reimbursement_delay_days",
             "side_effects_reported", "phone_changed", "visits_missed"]
    corr = t[feats + ["dropped_out"]].corr()["dropped_out"].drop("dropped_out").abs()
    add("no single feature leaks the target (|r| < 0.6)", corr.max() < 0.6, f"max |r| {corr.max():.2f}")
    add("training label not deterministic",
        all(0 < t[t[c] == val]["dropped_out"].mean() < 1 for c in ["daily_wage_worker", "phone_changed"] for val in (0, 1)))
    add("training missingness only where expected",
        t.drop(columns=["age", "reimbursement_delay_days"]).notna().all().all()
        and 0 < t["age"].isna().mean() < 0.05 and 0 < t["reimbursement_delay_days"].isna().mean() < 0.08)

    # ECG references
    ref = v[v["ecg_id"].notna()]
    add("visit ECG references are in ecg_metadata", set(ref["visit_id"]) == set(e["visit_id"]))
    if len(e):
        files_ok = all((ds.ecg_dir / Path(f).name).exists() for f in e["image_file"].unique())
        add("ECG files exist", files_ok)
        add("ECG metadata -> participant/visit/site consistent",
            e["visit_id"].isin(v["visit_id"]).all()
            and (e["participant_id"].values == v.set_index("visit_id").loc[e["visit_id"], "participant_id"].values).all()
            and (e["site_id"].values == v.set_index("visit_id").loc[e["visit_id"], "site_id"].values).all())
    return out


def fraud_checks(ds: Dataset, cfg: TrialConfig) -> List[CheckResult]:
    """Site C shows every injected anomaly; the other sites show none of them."""
    v, p, e = ds.visits, ds.participants, ds.ecg_metadata
    out: List[CheckResult] = []
    f = cfg.fraud
    if not f.enabled:
        return [CheckResult("fraud injection disabled", True, "no fraud patterns expected anywhere")]
    done = v[v["status"] == "completed"]
    fraud = done[done["site_id"] == f.site_id]
    honest = done[done["site_id"] != f.site_id]
    start, end = f.late_night_hours

    def add(name: str, ok: bool, detail: str = "") -> None:
        out.append(CheckResult(name, bool(ok), detail))

    # --- Site C: all patterns present
    ret = 1 - p[p["site_id"] == f.site_id]["dropped_out"].mean()
    add("site C retention ~100%", ret >= 0.98, f"{ret:.3f}")
    add("site C BP digit preference (0/5 >= 70%)", min(_ends_05(fraud["systolic_bp"]), _ends_05(fraud["diastolic_bp"])) >= 0.70,
        f"sbp {_ends_05(fraud['systolic_bp']):.2f} dbp {_ends_05(fraud['diastolic_bp']):.2f}")
    h_sd = honest["systolic_bp"].std()
    add("site C low BP variance (< 50% of honest sd)", fraud["systolic_bp"].std() < 0.5 * h_sd,
        f"site C sd {fraud['systolic_bp'].std():.1f} vs honest {h_sd:.1f}")
    unv = _unverified_entries(v, f.site_id)
    add("site C >= 9 visits without OTP", len(unv) >= 9, f"{len(unv)}")
    if len(unv):
        add("site C unverified entries are late-night", unv["entry_timestamp"].map(lambda s: _late_night(s, start, end)).all())
        add("site C unverified entries are batched (>= 5 within 10 min)", _max_burst(unv["_entry"]) >= 5,
            f"largest burst {_max_burst(unv['_entry'])}")
        add("site C unverified entries span several participants", unv["participant_id"].nunique() >= 4)
    if len(e):
        c = e[e["site_id"] == f.site_id]
        per_image = c.groupby("ecg_id")["participant_id"].nunique()
        add("site C ECG images reused across >= 4 participants", (per_image >= 4).sum() >= 1 and per_image.max() >= 4,
            f"max participants per image {int(per_image.max())}")
    else:
        out.append(CheckResult("site C duplicate ECGs", True, "ECG generation unavailable", skipped=True))

    # --- Honest sites: none of the injected patterns
    for sid in cfg.honest_site_ids:
        h = done[done["site_id"] == sid]
        ret_h = 1 - p[p["site_id"] == sid]["dropped_out"].mean()
        add(f"{sid} retention is not ~100%", ret_h < 0.95, f"{ret_h:.3f}")
        add(f"{sid} BP not digit-preferenced", max(_ends_05(h["systolic_bp"]), _ends_05(h["diastolic_bp"])) < 0.40,
            f"sbp {_ends_05(h['systolic_bp']):.2f}")
        add(f"{sid} BP has natural variance", h["systolic_bp"].std() > 9, f"sd {h['systolic_bp'].std():.1f}")
        u = _unverified_entries(v, sid)
        add(f"{sid} < 9 unverified visits", len(u) < 9, f"{len(u)}")
        add(f"{sid} no late-night or batched entries",
            (not len(u)) or (not u["entry_timestamp"].map(lambda s: _late_night(s, start, end)).any()
                             and _max_burst(u["_entry"]) < 3))
        if len(e):
            per_image = e[e["site_id"] == sid].groupby("ecg_id")["participant_id"].nunique()
            add(f"{sid} ECG images not reused", (per_image.empty) or per_image.max() == 1)
    if len(e):
        shared = e.groupby("ecg_id")["site_id"].nunique()
        add("no ECG image shared across sites", shared.max() == 1)
    return out


def ramesh_checks(ds: Dataset, cfg: TrialConfig) -> List[CheckResult]:
    """Ramesh's scripted profile is present and consistent with the visit records."""
    r = cfg.ramesh
    row = ds.participants[ds.participants["participant_name"] == r.name]
    if len(row) != 1:
        return [CheckResult("Ramesh exists exactly once", False, f"{len(row)} rows")]
    row = row.iloc[0]
    miss = ds.visits[(ds.visits["participant_id"] == row["participant_id"]) & (ds.visits["status"] == "missed")]
    site_city = ds.sites.set_index("site_id").loc[row["site_id"], "city"]
    ok = (site_city == "Roorkee" and row["distance_km"] == r.distance_km and row["missed_reminders"] == r.missed_reminders
          and row["reimbursement_delay_days"] == r.reimbursement_delay_days and len(miss) >= 1
          and row["visits_missed"] == len(miss))
    return [CheckResult("Ramesh profile (Roorkee, 40 km, 2 reminders, 12 d delay, >=1 missed)", ok)]


def expected_visits_missed(visits: pd.DataFrame, participants: pd.DataFrame) -> pd.Series:
    """Missed visits per participant that occurred before dropout (all misses for non-dropouts)."""
    m = visits[visits["status"] == "missed"].merge(
        participants[["participant_id", "dropout_visit"]], on="participant_id")
    m = m[(m["dropout_visit"] == 0) | (m["visit_number"] < m["dropout_visit"])]
    return participants["participant_id"].map(m.groupby("participant_id").size()).fillna(0).astype(int)


def consistency_checks(ds: Dataset) -> List[CheckResult]:
    """Participant `visits_missed` equals pre-dropout missed rows in visits.csv; dropouts miss every later visit."""
    v, p = ds.visits, ds.participants
    ok = (expected_visits_missed(v, p).values == p["visits_missed"].values).all()
    drop = p[p["dropout_visit"] > 0].merge(v, on="participant_id", suffixes=("", "_v"))
    after = drop[drop["visit_number"] >= drop["dropout_visit"]]
    return [CheckResult("participant visits_missed matches visits.csv", ok),
            CheckResult("dropouts miss every visit from dropout_visit on", (after["status_v"] == "missed").all()),
            CheckResult("dropped_out flag agrees with dropout_visit", ((p["dropout_visit"] > 0) == (p["dropped_out"] == 1)).all())]


def run_all_checks(ds: Dataset, cfg: TrialConfig) -> List[CheckResult]:
    """Every dataset check (excluding reproducibility, which needs a second pipeline run)."""
    return structural_checks(ds, cfg) + consistency_checks(ds) + fraud_checks(ds, cfg) + ramesh_checks(ds, cfg)


def raise_on_failure(results: List[CheckResult]) -> None:
    """Fail loudly listing every failed check."""
    failed = [c for c in results if not c.passed]
    if failed:
        raise DataValidationError("Critical validation failures:\n" + "\n".join(
            f"  - {c.name}: {c.detail}" for c in failed))


def compare_output_dirs(a: Path, b: Path) -> List[str]:
    """Differences between two generated trees: CSVs and PNGs byte-for-byte, summary JSON ignoring timestamps."""
    diffs: List[str] = []
    files_a = sorted(p.relative_to(a) for p in a.rglob("*") if p.suffix in {".csv", ".png"})
    files_b = sorted(p.relative_to(b) for p in b.rglob("*") if p.suffix in {".csv", ".png"})
    if files_a != files_b:
        diffs.append(f"file sets differ: {set(files_a) ^ set(files_b)}")
    for rel in set(files_a) & set(files_b):
        if sha256_file(a / rel) != sha256_file(b / rel):
            diffs.append(f"content differs: {rel}")

    def summary(d: Path) -> Optional[dict]:
        f = d / "metadata" / "generation_summary.json"
        if not f.exists():
            return None
        s = json.loads(f.read_text())
        s.pop("generated_at", None)
        s.pop("validation", None)
        return s

    if summary(a) != summary(b):
        diffs.append("generation_summary.json differs (ignoring timestamp)")
    return diffs
