import dataclasses

import pytest

from app.config import default_config
from app.data_generation import validation


def test_all_checks_pass_on_generated_data(ds, cfg):
    results = validation.run_all_checks(ds, cfg)
    assert len(results) > 40
    validation.raise_on_failure(results)


def test_summary_contents(summary):
    for key in ["random_seed", "generated_at", "training_participants", "demo_participants", "sites",
                "scheduled_visits", "completed_visits", "missed_visits", "ecg", "training_dropout_distribution",
                "site_statistics"]:
        assert key in summary
    assert summary["random_seed"] == 42 and summary["scheduled_visits"] == 2400
    assert summary["completed_visits"] + summary["missed_visits"] == 2400
    assert summary["ecg"]["images"] == 30
    stats = summary["site_statistics"]["SITE-C"]
    assert {"participant_retention_rate", "otp_verification_rate", "measurements"} <= set(stats)


def _fails(ds, cfg, name_fragment):
    results = validation.run_all_checks(ds, cfg)
    return [c for c in results if not c.passed and name_fragment in c.name]


def test_detects_duplicate_ids(ds, cfg):
    bad = dataclasses.replace(ds, visits=ds.visits.copy())
    bad.visits.loc[1, "visit_id"] = bad.visits.loc[0, "visit_id"]
    assert _fails(bad, cfg, "unique visit ids")


def test_detects_orphan_visit(ds, cfg):
    bad = dataclasses.replace(ds, visits=ds.visits.copy())
    bad.visits.loc[0, "participant_id"] = "P-Z-999"
    assert _fails(bad, cfg, "visit -> participant")


def test_detects_removed_site_c_fraud(ds, cfg):
    bad = dataclasses.replace(ds, visits=ds.visits.copy())
    bad.visits["otp_verified"] = bad.visits["otp_verified"].where(bad.visits["otp_verified"].isna(), 1)
    assert _fails(bad, cfg, "without OTP")


def test_detects_fraud_injected_at_honest_site(ds, cfg):
    bad = dataclasses.replace(ds, visits=ds.visits.copy())
    mask = (bad.visits["site_id"] == "SITE-A") & (bad.visits["status"] == "completed")
    bad.visits.loc[mask, "systolic_bp"] = 120
    assert _fails(bad, cfg, "SITE-A")


def test_detects_missing_ecg_file(ds, cfg, tmp_path):
    bad = dataclasses.replace(ds, ecg_dir=tmp_path)
    assert _fails(bad, cfg, "ECG files exist")


def test_failure_raises_loudly(ds, cfg):
    bad = dataclasses.replace(ds, participants=ds.participants.copy())
    bad.participants.loc[0, "daily_wage_worker"] = 7
    with pytest.raises(validation.DataValidationError):
        validation.raise_on_failure(validation.run_all_checks(bad, cfg))


def test_reproducibility_detects_differences(tmp_path):
    (tmp_path / "a").mkdir(); (tmp_path / "b").mkdir()
    (tmp_path / "a" / "x.csv").write_text("1\n"); (tmp_path / "b" / "x.csv").write_text("2\n")
    assert validation.compare_output_dirs(tmp_path / "a", tmp_path / "b")
