from __future__ import annotations

import pytest
from integ_helpers import fabricate_site, honest_trial

from app.integrity.config import IntegrityConfig
from app.integrity.engine import IntegrityEngine


@pytest.fixture(scope="module")
def honest():
    return honest_trial()


def rules(res, site=None):
    return {f.rule_id for f in res["findings"] if site is None or f.site_id == site}


def test_honest_sites_raise_no_site_level_findings(honest):
    v, p = honest
    res = IntegrityEngine().scan_trial(v, p)
    assert not [f for f in res["findings"] if f.entity_type == "site" and f.severity in ("medium", "high")]
    assert res["summary"]["byCategory"]["technical_violation"] == 0


def test_digit_preference_and_low_variance_detected(honest):
    v, p = honest
    v2, p2 = fabricate_site(v, p, "SITE-B")
    res = IntegrityEngine().scan_trial(v2, p2)
    r = rules(res, "SITE-B")
    assert {"site.bp_digit_preference", "site.low_bp_variance"} <= r
    assert not [f for f in res["findings"] if f.site_id in ("SITE-A", "SITE-D") and f.severity != "low"]


def test_excess_missing_otp_detected_with_enough_cases(honest):
    v, p = honest
    v2, _ = fabricate_site(v, p, "SITE-C", round_bp=False, flat_bp=False, no_otp=15)
    assert "site.missing_otp_rate" in rules(IntegrityEngine().scan_trial(v2, p), "SITE-C")


def test_few_missing_otp_not_flagged_at_site_level(honest):
    v, p = honest
    v2, _ = fabricate_site(v, p, "SITE-C", round_bp=False, flat_bp=False, no_otp=2)
    assert "site.missing_otp_rate" not in rules(IntegrityEngine().scan_trial(v2, p), "SITE-C")


def test_high_retention_alone_is_low_severity_only(honest):
    v, p = honest
    p2 = [dict(x, dropped_out=False) if x["site_id"] == "SITE-A" else x for x in p]
    res = IntegrityEngine().scan_trial(v, p2)
    f = [x for x in res["findings"] if x.site_id == "SITE-A" and x.entity_type == "site"]
    assert [x.rule_id for x in f] == ["site.high_retention"] and f[0].severity == "low"


def test_multiple_site_signals_escalate_to_high(honest):
    v, p = honest
    v2, p2 = fabricate_site(v, p, "SITE-B", no_otp=15)
    f = [x for x in IntegrityEngine().scan_trial(v2, p2)["findings"] if x.rule_id == "site.multiple_integrity_signals"]
    assert len(f) == 1 and f[0].site_id == "SITE-B" and f[0].severity == "high" and f[0].category == "suspicious_pattern"


def test_small_sites_are_reported_as_insufficient_not_tested():
    v, p = honest_trial(sites=("SITE-A", "SITE-B", "SITE-C"), per_site=8)
    v2, p2 = fabricate_site(v, p, "SITE-B")
    res = IntegrityEngine().scan_trial(v2, p2)
    assert {f.rule_id for f in res["findings"] if f.entity_type == "site"} == {"site.insufficient_data"}
    assert all(f.severity == "low" and f.category == "data_quality" for f in res["findings"] if f.entity_type == "site")


def test_single_site_has_no_comparison_group(honest):
    v, p = honest_trial(sites=("SITE-A",), per_site=40)
    res = IntegrityEngine().scan_trial(v, p)
    assert res["siteStatistics"][0]["tests"] == {}


def test_retention_derived_from_final_visit_when_participants_not_supplied(honest):
    v, p = honest
    res = IntegrityEngine().scan_trial(v, None)
    for row in res["siteStatistics"]:
        assert row["n_retention_known"] == row["n_participants"]


def test_thresholds_configurable(honest):
    from dataclasses import replace
    from app.integrity.config import SiteStatsConfig
    v, p = honest
    v2, p2 = fabricate_site(v, p, "SITE-B")
    cfg = IntegrityConfig(site=SiteStatsConfig(min_participants=500))
    assert rules(IntegrityEngine(cfg).scan_trial(v2, p2)) == {"site.insufficient_data"}
