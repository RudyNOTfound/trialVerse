import dataclasses

import numpy as np

from app.config import default_config
from app.data_generation import participants


def test_training_participant_count_and_columns(ds):
    assert len(ds.training) == 2000
    assert list(ds.training.columns) == participants.TRAINING_COLUMNS


def test_training_labels_are_noisy_and_not_extreme(ds):
    rate = ds.training["dropped_out"].mean()
    assert 0.15 < rate < 0.45
    # Bernoulli noise: even the highest-risk decile does not always drop out, the lowest sometimes does.
    cfg = default_config()
    p = participants.dropout_probability(ds.training, cfg.dropout)
    top = ds.training[p >= np.quantile(p, 0.9)]["dropped_out"].mean()
    bottom = ds.training[p <= np.quantile(p, 0.1)]["dropped_out"].mean()
    assert bottom < rate < top < 1.0 and bottom > 0.0


def test_training_has_realistic_missing_values_only_where_expected(ds):
    na = ds.training.isna().sum()
    assert na["age"] > 0 and na["reimbursement_delay_days"] > 0
    assert na.drop(["age", "reimbursement_delay_days"]).sum() == 0


def test_demo_participant_count_and_five_sites(ds):
    assert len(ds.participants) == 300
    assert ds.participants["site_id"].nunique() == 5 == len(ds.sites)


def test_ramesh_profile(ds):
    r = ds.participants[ds.participants["participant_name"] == "Ramesh Verma"]
    assert len(r) == 1
    r = r.iloc[0]
    assert r["distance_km"] == 40 and r["missed_reminders"] == 2 and r["reimbursement_delay_days"] == 12
    assert ds.sites.set_index("site_id").loc[r["site_id"], "city"] == "Roorkee"
    assert r["visits_missed"] >= 1
    missed = ds.visits[(ds.visits["participant_id"] == r["participant_id"]) & (ds.visits["status"] == "missed")]
    assert len(missed) >= 1


def test_ramesh_has_high_model_risk_without_hardcoded_score(ds):
    import numpy as np
    cfg = default_config()
    p = participants.dropout_probability(ds.participants, cfg.dropout)
    ramesh_p = p[(ds.participants["participant_name"] == "Ramesh Verma").to_numpy()][0]
    assert ramesh_p > 0.5
    assert ramesh_p > np.quantile(p, 0.85)  # top-15% risk in the demo cohort
    assert not any("risk" in c or "score" in c for c in ds.participants.columns)


def test_demo_visits_missed_does_not_encode_dropout(ds):
    p = ds.participants
    # Dropouts miss all later visits, yet the feature counts only pre-dropout misses.
    assert (ds.visits[ds.visits["status"] == "missed"].groupby("participant_id").size()
            .reindex(p["participant_id"]).fillna(0).values >= p["visits_missed"].values).all()
    assert p["visits_missed"].max() <= 6


def test_same_seed_same_training_data():
    cfg = default_config()
    a, b = participants.generate_training_data(cfg), participants.generate_training_data(cfg)
    assert a.equals(b)
    c = participants.generate_training_data(dataclasses.replace(cfg, seed=7))
    assert not a.equals(c)
