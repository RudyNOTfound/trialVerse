from __future__ import annotations

from integ_helpers import visit

from app.integrity.config import VisitRuleConfig
from app.integrity.trial_data import prepare_visits
from app.integrity.visit_rules import rapid_entry_clusters, visit_findings, visit_signals

CFG = VisitRuleConfig()


def sig(*vs):
    df = prepare_visits(vs)
    return df, visit_signals(df, CFG)


def test_honest_visit_has_no_signals():
    _, s = sig(visit(1))
    assert s == {}


def test_missing_otp_detected_and_is_only_a_low_warning():
    df, s = sig(visit(1, otp_verified=0))
    assert list(s["V-SITE-X-00001"]) == ["missing_otp"]
    f = visit_findings(df, s, CFG)
    assert len(f) == 1 and f[0].severity == "low" and f[0].category == "data_quality"      # one weak rule never escalates


def test_late_entry_detected():
    v = visit(1, entry_timestamp="2026-03-05T11:30:00+05:30", device_timestamp="2026-03-02T11:00:00+05:30")
    _, s = sig(v)
    assert "late_entry" in s[v["visit_id"]] and s[v["visit_id"]]["late_entry"]["hours_after_visit"] > 24


def test_entry_just_inside_threshold_not_flagged():
    _, s = sig(visit(1, entry_timestamp="2026-03-02T10:30:00+05:30", device_timestamp="2026-03-01T11:00:00+05:30"))
    assert s == {}


def test_visit_outside_scheduled_window():
    v = visit(1, scheduled_date="2026-03-01", device_timestamp="2026-03-20T11:00:00+05:30", entry_timestamp="2026-03-20T11:30:00+05:30")
    _, s = sig(v)
    assert s[v["visit_id"]]["outside_window"]["days_from_schedule"] == 19


def test_night_entry_uses_the_timestamps_own_offset():
    _, s = sig(visit(1, entry_timestamp="2026-03-01T01:10:00+05:30", device_timestamp="2026-03-01T00:30:00+05:30"))
    assert "night_entry" in next(iter(s.values()))
    _, s2 = sig(visit(2, entry_timestamp="2026-03-01T13:10:00+05:30", device_timestamp="2026-03-01T12:30:00+05:30"))
    assert s2 == {}


def test_implausible_measurements():
    _, s = sig(visit(1, systolic_bp=300), visit(2, heart_rate=5), visit(3, systolic_bp=80, diastolic_bp=95))
    kinds = {k: v["implausible_measurement"] for k, v in s.items()}
    assert "systolic_bp" in kinds["V-SITE-X-00001"] and "heart_rate" in kinds["V-SITE-X-00002"]
    assert "systolic_not_above_diastolic" in kinds["V-SITE-X-00003"]


def test_invalid_timestamps():
    _, s = sig(visit(1, entry_timestamp="not-a-date"), visit(2, device_timestamp="2026-03-01T11:00:00"),
               visit(3, entry_timestamp="2026-03-01T09:00:00+05:30", device_timestamp="2026-03-01T11:00:00+05:30"))
    assert all("invalid_timestamp" in v for v in s.values()) and len(s) == 3


def test_missing_mandatory_fields_on_completed_visit_only():
    df, s = sig(visit(1, systolic_bp=None, otp_verified=None), visit(2, status="missed", systolic_bp=None, device_timestamp=None,
                                                                     entry_timestamp=None, otp_verified=None))
    assert set(s) == {"V-SITE-X-00001"}
    assert {"systolic_bp", "otp_verified"} <= set(s["V-SITE-X-00001"]["missing_mandatory"]["fields"])


def test_rapid_entry_cluster_needs_enough_entries_inside_the_window():
    tight = [visit(i, entry_timestamp=f"2026-03-02T01:{10 + i:02d}:00+05:30") for i in range(1, 7)]
    spread = [visit(i + 20, entry_timestamp=f"2026-03-0{i}T13:00:00+05:30", device_timestamp=f"2026-03-0{i}T12:00:00+05:30") for i in range(1, 7)]
    assert len(rapid_entry_clusters(prepare_visits(tight), CFG)) == 1
    assert rapid_entry_clusters(prepare_visits(spread), CFG) == []
    assert rapid_entry_clusters(prepare_visits(tight[:4]), CFG) == []


def test_multiple_signals_escalate_and_data_quality_alone_does_not():
    bad = visit(1, otp_verified=0, entry_timestamp="2026-03-06T01:10:00+05:30", device_timestamp="2026-03-01T11:00:00+05:30")
    df, s = sig(bad)
    f = visit_findings(df, s, CFG)
    assert len(f) == 1 and f[0].rule_id == "visit.multiple_integrity_signals" and f[0].severity == "high"
    assert f[0].category == "suspicious_pattern"
    df2, s2 = sig(visit(2, systolic_bp=300, heart_rate=5))          # two data-quality problems only
    assert all(x.severity != "high" and x.category == "data_quality" for x in visit_findings(df2, s2, CFG))


def test_thresholds_are_configurable():
    v = visit(1, entry_timestamp="2026-03-01T20:00:00+05:30", device_timestamp="2026-03-01T11:00:00+05:30")   # 9 h late
    df = prepare_visits([v])
    assert visit_signals(df, CFG) == {}
    assert "late_entry" in visit_signals(df, VisitRuleConfig(late_entry_hours=6))[v["visit_id"]]
