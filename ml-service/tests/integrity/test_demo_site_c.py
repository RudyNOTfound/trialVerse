"""Phase 3 demo trial: Site C's injected patterns are found, honest sites stay quiet."""
from __future__ import annotations

import pytest

from app.integrity.demo import run_demo


@pytest.fixture(scope="module")
def res(cfg, summary):
    return run_demo(cfg.output_dir)


def by_rule(res, rule):
    return [f for f in res["findings"] if f.rule_id == rule]


def test_site_c_statistical_signals(res):
    for rule in ("site.bp_digit_preference", "site.low_bp_variance", "site.missing_otp_rate", "site.late_night_entries",
                 "site.delayed_entries", "site.high_retention", "site.anomaly_enrichment"):
        (f,) = by_rule(res, rule)
        assert f.site_id == "SITE-C", rule
    assert by_rule(res, "site.high_retention")[0].severity == "low"                 # never decisive on its own
    assert by_rule(res, "site.multiple_integrity_signals")[0].severity == "high"


def test_site_c_has_three_rapid_entry_clusters_of_six(res):
    cl = by_rule(res, "site.rapid_entry_cluster")
    assert len(cl) == 3 and all(len(f.details["visitIds"]) == 6 for f in cl)


def test_all_18_unverified_late_night_visits_found_and_nothing_else_flagged_as_multi_signal(res):
    ev = res["evaluation"]
    assert ev["injected_unverified_late_night_visits"] == 18 and ev["of_which_flagged_multi_signal"] == 18
    assert ev["multi_signal_visits_not_in_ground_truth"] == []
    assert ev["siteC_visits_with_multi_signal_finding"] == 18 < ev["siteC_visits_total"] == 480       # not every Site C visit


def test_reused_ecgs_found_with_ids_and_distances(res):
    dup = by_rule(res, "ecg.duplicate_image")
    assert len(dup) == 6 and all(len(f.details["participantIds"]) == 4 and f.details["maxHammingDistance"] == 0 for f in dup)
    ev = res["evaluation"]
    assert ev["of_which_in_duplicate_clusters"] == ev["injected_reused_ecg_visits"] and ev["ecg_visits_not_in_ground_truth"] == []


def test_honest_sites_are_comparatively_normal(res):
    assert res["evaluation"]["honest_site_multi_signal_visits"] == []
    honest = [f for f in res["findings"] if f.site_id in ("SITE-A", "SITE-B", "SITE-D", "SITE-E")]
    assert honest and all(f.severity == "low" and f.category == "data_quality" for f in honest)


def test_no_finding_declares_fraud(res):
    text = " ".join(f.message.lower() for f in res["findings"])
    assert "is fraudulent" not in text and "fraudulent site" not in text
