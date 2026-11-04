import pandas as pd

from app.config import default_config
from app.data_generation import validation
from app.data_generation.generate_all import run_pipeline
from app.data_generation.utils import parse_ist


def test_eight_scheduled_visits_per_participant(ds):
    assert (ds.visits.groupby("participant_id").size() == 8).all()
    assert len(ds.visits) == 2400


def test_foreign_keys_and_no_orphans(ds):
    assert ds.visits["participant_id"].isin(ds.participants["participant_id"]).all()
    assert ds.reimbursements["visit_id"].isin(ds.visits["visit_id"]).all()
    assert ds.ecg_metadata["visit_id"].isin(ds.visits["visit_id"]).all()
    site_of = ds.participants.set_index("participant_id")["site_id"]
    assert (ds.visits["participant_id"].map(site_of) == ds.visits["site_id"]).all()


def test_reimbursement_is_350_inr_per_verified_visit(ds):
    assert (ds.reimbursements["amount_inr"] == 350).all()
    ok = ds.visits[(ds.visits["status"] == "completed") & (ds.visits["otp_verified"] == 1)]
    assert len(ds.reimbursements) == len(ok)


def test_site_c_missing_otp_records(ds):
    c = ds.visits[(ds.visits["site_id"] == "SITE-C") & (ds.visits["status"] == "completed")]
    assert (c["otp_verified"] == 0).sum() >= 9


def test_site_c_batch_entry_timestamps_late_night(ds):
    u = ds.visits[(ds.visits["site_id"] == "SITE-C") & (ds.visits["otp_verified"] == 0)]
    entries = sorted(u["entry_timestamp"].map(parse_ist))
    assert all(t.hour >= 23 or t.hour < 4 for t in entries)
    within_10min = [sum(1 for x in entries if 0 <= (x - t).total_seconds() <= 600) for t in entries]
    assert max(within_10min) >= 5
    # Entered well after the visit actually happened (back-filled).
    dev = u["device_timestamp"].map(parse_ist)
    assert ((u["entry_timestamp"].map(parse_ist) - dev).dt.total_seconds() > 86400).all()


def test_site_c_digit_preference_and_low_variance(ds):
    done = ds.visits[ds.visits["status"] == "completed"]
    c, others = done[done["site_id"] == "SITE-C"], done[done["site_id"] != "SITE-C"]
    assert (c["systolic_bp"] % 5 == 0).mean() > 0.7 and (c["diastolic_bp"] % 5 == 0).mean() > 0.7
    assert (others["systolic_bp"] % 5 == 0).mean() < 0.35
    assert c["systolic_bp"].std() < 0.5 * others["systolic_bp"].std()


def test_site_c_retention_is_suspiciously_perfect(ds):
    rate = ds.participants.groupby("site_id")["dropped_out"].mean()
    assert rate["SITE-C"] == 0
    assert rate.drop("SITE-C").min() > 0.05


def test_honest_sites_have_natural_variability(ds):
    done = ds.visits[(ds.visits["status"] == "completed") & (ds.visits["site_id"] != "SITE-C")]
    for sid, g in done.groupby("site_id"):
        assert g["systolic_bp"].std() > 9, sid
        assert (g["systolic_bp"] % 5 == 0).mean() < 0.35, sid
        assert (g["otp_verified"] == 0).sum() < 9, sid
        assert g["glucose_mg_dl"].std() > 20, sid
        entry_hours = g["entry_timestamp"].map(lambda s: parse_ist(s).hour)
        assert entry_hours.between(8, 21).all(), sid
    # sites differ from one another rather than being clones
    assert done.groupby("site_id")["systolic_bp"].std().nunique() == 4


def test_no_fraud_leaks_when_disabled(tmp_path):
    import dataclasses
    from app.config import FraudConfig
    cfg = dataclasses.replace(default_config(tmp_path), fraud=FraudConfig(enabled=False), generate_ecg=False)
    run_pipeline(cfg, check_reproducibility=False)
    d = validation.load_dataset(tmp_path)
    c = d.visits[(d.visits["site_id"] == "SITE-C") & (d.visits["status"] == "completed")]
    assert (c["otp_verified"] == 0).sum() < 9 and c["systolic_bp"].std() > 9
    assert d.participants[d.participants["site_id"] == "SITE-C"]["dropped_out"].mean() > 0


def test_reproducible_with_seed_42(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    run_pipeline(default_config(a), validate=False)
    run_pipeline(default_config(b), validate=False)
    assert validation.compare_output_dirs(a, b) == []
    assert pd.read_csv(a / "demo" / "visits.csv").equals(pd.read_csv(b / "demo" / "visits.csv"))
