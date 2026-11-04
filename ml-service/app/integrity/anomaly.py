"""Unsupervised anomaly signal: Isolation Forest over *participant-level* recording profiles.

Why participants and not sites or single visits: five sites are far too few observations to fit anything, and a
single visit hides the distributional oddities (rounded or too-uniform readings) that matter. Each participant
with enough completed visits becomes one feature vector summarising how their data were recorded. Participant
and site identifiers are never features; site is only used afterwards, to ask whether a site's participants
score higher than everyone else's (one-sided Mann-Whitney U on the raw anomaly scores).

Why not count outliers per site: a coordinated site (say 20% of all participants, all with unnaturally uniform
readings) forms its own dense cluster, so few of its members are individually "isolated"; but the cluster still sits
away from the bulk, so its scores shift upward as a group. Comparing score distributions catches that;
thresholding at `contamination` does not.

`contamination` is an assumption about the share of unusual profiles, not a measured fraud rate. The forest uses
a fixed `random_state`, so scores are reproducible. The output is an anomaly signal, not proof of fraud.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import IsolationForest

from .config import AnomalyConfig

FEATURES = ("sbp_sd", "dbp_sd", "heart_rate_sd", "glucose_sd", "sbp_share_ending_0_or_5", "dbp_share_ending_0_or_5",
            "sbp_range")
MIN_VISITS_PER_PARTICIPANT = 4


def build_participant_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df[df.status == "completed"]
    rows = {}
    for pid, g in d.groupby("participant_id"):
        if g.systolic_bp.notna().sum() < MIN_VISITS_PER_PARTICIPANT:
            continue
        rows[pid] = {
            "sbp_sd": g.systolic_bp.std(), "dbp_sd": g.diastolic_bp.std(), "heart_rate_sd": g.heart_rate.std(),
            "glucose_sd": g.glucose_mg_dl.std(), "sbp_share_ending_0_or_5": (g.systolic_bp.dropna() % 5 == 0).mean(),
            "dbp_share_ending_0_or_5": (g.diastolic_bp.dropna() % 5 == 0).mean(),
            "sbp_range": g.systolic_bp.max() - g.systolic_bp.min()}
    X = pd.DataFrame.from_dict(rows, orient="index", columns=list(FEATURES))
    return X.fillna(X.median(numeric_only=True)).fillna(0.0)


def anomaly_scan(df: pd.DataFrame, cfg: AnomalyConfig) -> Tuple[Dict[str, float], Dict[str, Any]]:
    """Returns ({participant_id: anomaly_score 0..1} for the anomalous set, summary with per-site enrichment)."""
    X = build_participant_features(df)
    if len(X) < cfg.min_rows:
        return {}, {"status": "skipped", "reason": f"{len(X)} participant profiles < min_rows={cfg.min_rows}; "
                                                   "an Isolation Forest on so few observations is not meaningful"}
    iso = IsolationForest(n_estimators=cfg.n_estimators, contamination=cfg.contamination,
                          random_state=cfg.random_state).fit(X.to_numpy())
    raw = -iso.score_samples(X.to_numpy())                                    # higher = more anomalous
    pct = pd.Series(raw, index=X.index).rank(pct=True)                        # 0..1 percentile rank
    flagged = pd.Series(iso.predict(X.to_numpy()) == -1, index=X.index)
    site_of = df.drop_duplicates("participant_id").set_index("participant_id").site_id.reindex(X.index)
    out = {str(p): float(pct[p]) for p in X.index[flagged]}
    n_flag, n = int(flagged.sum()), len(X)
    per_site: List[Dict[str, Any]] = []
    scores = pd.Series(raw, index=X.index)
    for s_ in sorted(set(site_of.dropna())):
        m = (site_of == s_).to_numpy()
        ns = int(m.sum())
        if ns < 2 or ns == n:
            continue
        p = float(stats.mannwhitneyu(scores[m], scores[~m], alternative="greater").pvalue)
        per_site.append({"site_id": s_, "participants": ns, "mean_anomaly_score": float(scores[m].mean()),
                         "other_sites_mean_anomaly_score": float(scores[~m].mean()), "p_value": p,
                         "flagged": int(flagged[m].sum()), "participant_ids": sorted(str(p_) for p_ in X.index[flagged & m]),
                         "enriched": bool(ns >= cfg.site_min_participants and p < cfg.site_enrichment_alpha)})
    return out, {"status": "ok", "rows": n, "flagged": n_flag, "contamination": cfg.contamination,
                 "features": list(FEATURES), "per_site": per_site}
