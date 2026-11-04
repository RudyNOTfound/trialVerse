from __future__ import annotations

import pandas as pd
from integ_helpers import fabricate_site, honest_trial

from app.integrity.anomaly import FEATURES, anomaly_scan, build_participant_features
from app.integrity.config import AnomalyConfig
from app.integrity.trial_data import prepare_visits


def test_too_few_observations_are_skipped_not_fitted():
    v, _ = honest_trial(sites=("A", "B", "C", "D", "E"), per_site=3)         # 15 participants
    out, summary = anomaly_scan(prepare_visits(v), AnomalyConfig())
    assert out == {} and summary["status"] == "skipped" and "min_rows" in summary["reason"]


def test_identifiers_are_not_features():
    assert not any("id" in f.split("_") or "site" in f for f in FEATURES)
    v, _ = honest_trial()
    X = build_participant_features(prepare_visits(v))
    assert list(X.columns) == list(FEATURES) and X.isna().sum().sum() == 0


def test_scores_are_reproducible():
    v, p = honest_trial()
    v, _ = fabricate_site(v, p, "SITE-B")
    a = anomaly_scan(prepare_visits(v), AnomalyConfig())
    b = anomaly_scan(prepare_visits(v), AnomalyConfig())
    assert a[0] == b[0] and a[1] == b[1]


def test_fabricated_site_scores_higher_on_average_and_honest_sites_are_not_enriched():
    # Small toy trial: the forest is only a weak signal here (the Phase 3 demo test checks significance).
    v, p = honest_trial()
    v, _ = fabricate_site(v, p, "SITE-B")
    _, s = anomaly_scan(prepare_visits(v), AnomalyConfig())
    by = {x["site_id"]: x for x in s["per_site"]}
    assert by["SITE-B"]["mean_anomaly_score"] > by["SITE-B"]["other_sites_mean_anomaly_score"]
    assert not any(by[k]["enriched"] for k in ("SITE-A", "SITE-C", "SITE-D"))


def test_honest_data_has_no_enriched_site():
    v, _ = honest_trial(seed=3)
    _, s = anomaly_scan(prepare_visits(v), AnomalyConfig())
    assert not any(x["enriched"] for x in s["per_site"])


def test_anomaly_is_labelled_as_signal_in_findings(cfg, summary):
    from app.integrity.demo import run_demo
    f = [x for x in run_demo(cfg.output_dir)["findings"] if x.rule_id == "site.anomaly_enrichment"]
    assert len(f) == 1 and f[0].site_id == "SITE-C" and "not proof of fraud" in f[0].message and f[0].severity == "medium"
