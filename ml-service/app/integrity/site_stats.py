"""Site-level statistical comparison. Each site is tested against the pooled *other* sites, one-sided,
and only when both sides have enough observations."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats

from .config import SiteStatsConfig, VisitRuleConfig
from .findings import Finding
from .visit_rules import _is_night


def derive_retention(df: pd.DataFrame, participants: Optional[List[Dict[str, Any]]]) -> Dict[str, bool]:
    """participant_id -> retained. Uses supplied `dropped_out` flags; otherwise a participant is retained
    when their final scheduled visit (highest visit_number in the data) was completed."""
    if participants:
        return {p["participant_id"]: not bool(p.get("dropped_out")) for p in participants if p.get("participant_id")}
    last = df.visit_number.max()
    fin = df[df.visit_number == last]
    return {pid: bool((g.status == "completed").any()) for pid, g in fin.groupby("participant_id")}


def _binom_greater(k: int, n: int, p: float) -> float:
    return float(stats.binomtest(int(k), int(n), min(max(p, 1e-9), 1 - 1e-9), alternative="greater").pvalue) if n else 1.0


def _fisher_greater(k: int, n: int, k_rest: int, n_rest: int) -> float:
    if n == 0 or n_rest == 0:
        return 1.0
    return float(stats.fisher_exact([[k, n - k], [k_rest, n_rest - k_rest]], alternative="greater")[1])


def _site_row(site: str, g: pd.DataFrame, retention: Dict[str, bool], vcfg: VisitRuleConfig) -> Dict[str, Any]:
    done = g[g.status == "completed"]
    pids = sorted(set(g.participant_id))
    ret = [retention[p] for p in pids if p in retention]
    night = int(sum(_is_night(h, vcfg) for h in done.entry_hour))
    return {"site_id": site, "n_participants": len(pids), "n_completed_visits": len(done),
            "n_retained": int(sum(ret)), "n_retention_known": len(ret),
            "sbp_n": int(done.systolic_bp.notna().sum()), "sbp_sd": done.systolic_bp.std(ddof=1),
            "dbp_sd": done.diastolic_bp.std(ddof=1),
            "sbp_end05": int((done.systolic_bp.dropna() % 5 == 0).sum()), "dbp_end05": int((done.diastolic_bp.dropna() % 5 == 0).sum()),
            "dbp_n": int(done.diastolic_bp.notna().sum()),
            "no_otp": int((done.otp_verified == 0).sum()), "otp_known": int(done.otp_verified.notna().sum()),
            "night_entries": night, "late_entries": int((done.lag_hours > vcfg.late_entry_hours).sum()),
            "entries": int(done.entry_dt.notna().sum())}


def site_statistics(df: pd.DataFrame, retention: Dict[str, bool], bursts: List[Dict[str, Any]],
                    cfg: SiteStatsConfig, vcfg: VisitRuleConfig) -> Tuple[List[Dict[str, Any]], List[Finding]]:
    rows = {s: _site_row(s, g, retention, vcfg) for s, g in df.groupby("site_id")}
    burst_by_site: Dict[str, int] = {}
    for b in bursts:
        burst_by_site[b["site_id"]] = burst_by_site.get(b["site_id"], 0) + 1
    findings: List[Finding] = []
    table: List[Dict[str, Any]] = []
    for site, r in rows.items():
        r["rapid_entry_clusters"] = burst_by_site.get(site, 0)
        r["sufficient_data"] = r["n_participants"] >= cfg.min_participants and r["n_completed_visits"] >= cfg.min_visits
        r["tests"], r["signals"] = {}, []
        table.append(r)
        if not r["sufficient_data"]:
            findings.append(Finding(
                "site.insufficient_data", "site", site, "low", "data_quality",
                f"Site {site} has {r['n_participants']} participants and {r['n_completed_visits']} completed visits, below the "
                f"minimum ({cfg.min_participants} / {cfg.min_visits}); no statistical comparison was made.",
                "Re-run once more data has accumulated.", {"nParticipants": r["n_participants"],
                "nCompletedVisits": r["n_completed_visits"]}, dedupe_key=f"{site}:{r['n_participants']}", site_id=site))
    elig = [r for r in table if r["sufficient_data"]]
    # Per-site completed BP arrays, computed once: pooling "all other sites" must not re-filter the frame per site pair
    # (that was O(sites^2) DataFrame scans -- ~80 s at 200 eligible sites).
    done_by_site = {s: g[g.status == "completed"] for s, g in df.groupby("site_id")}
    bp = {(s, c): g[f"{'systolic' if c == 'sbp' else 'diastolic'}_bp"].dropna().to_numpy() for s, g in done_by_site.items() for c in ("sbp", "dbp")}
    for r in elig:
        site = r["site_id"]
        rest = [o for o in elig if o is not r]
        agg = lambda k: int(sum(o[k] for o in rest))  # noqa: E731
        n_rest_v = agg("n_completed_visits")
        if n_rest_v < cfg.min_visits or agg("n_participants") < cfg.min_participants:
            continue                                   # nothing to compare against
        t: Dict[str, Any] = r["tests"]

        # 1. Retention far above the other sites (weak on its own: genuine sites can retain well).
        if r["n_retention_known"] and agg("n_retention_known"):
            rate, rest_rate = r["n_retained"] / r["n_retention_known"], agg("n_retained") / agg("n_retention_known")
            p = _binom_greater(r["n_retained"], r["n_retention_known"], rest_rate)
            t["retention"] = {"site_rate": rate, "other_sites_rate": rest_rate, "p_value": p}
            if p < cfg.alpha and rate - rest_rate >= cfg.retention_min_excess:
                r["signals"].append("high_retention")
                findings.append(Finding(
                    "site.high_retention", "site", site, "low", "suspicious_pattern",
                    f"Site {site} retained {rate:.0%} of participants versus {rest_rate:.0%} at the other sites (p={p:.1e}). "
                    "High retention alone is not evidence of fraud; it is only meaningful alongside other signals.",
                    "Compare with the other signals for this site before acting.", t["retention"], score=1 - p ** 0.05 if p > 0 else 1.0,
                    dedupe_key=site, site_id=site))

        # 2. Systolic / diastolic digit preference (values ending in 0 or 5).
        for col, kk, nn in (("sbp", "sbp_end05", "sbp_n"), ("dbp", "dbp_end05", "dbp_n")):
            if r[nn] >= cfg.min_visits:
                share = r[kk] / r[nn]
                p = _binom_greater(r[kk], r[nn], cfg.digit_pref_expected)
                t[f"{col}_digit_preference"] = {"share_ending_0_or_5": share, "expected": cfg.digit_pref_expected, "n": r[nn], "p_value": p}
                if col == "sbp" and p < cfg.alpha and share - cfg.digit_pref_expected >= cfg.digit_pref_min_excess:
                    r["signals"].append("digit_preference")
                    findings.append(Finding(
                        "site.bp_digit_preference", "site", site, "medium", "suspicious_pattern",
                        f"{share:.0%} of systolic BP readings at {site} end in 0 or 5 (about {cfg.digit_pref_expected:.0%} expected "
                        f"if last digits were uniform; n={r[nn]}, p={p:.1e}). This suggests rounded or invented values.",
                        "Request source documents or device logs for a sample of readings.",
                        {**t["sbp_digit_preference"], "diastolicShareEnding0Or5": r["dbp_end05"] / r["dbp_n"] if r["dbp_n"] else None},
                        score=min(1.0, share), dedupe_key=site, site_id=site))

        # 3. Abnormally low variance (variance-ratio F test against the other sites).
        for col in ("sbp", "dbp"):
            rest_vals = np.concatenate([bp[(o["site_id"], col)] for o in rest])
            if r[f"{col}_n"] >= cfg.min_visits and len(rest_vals) >= cfg.min_visits:
                var_s, var_r = float(r[f"{col}_sd"]) ** 2, float(np.var(rest_vals, ddof=1))
                ratio = var_s / var_r if var_r > 0 else float("nan")
                p = float(stats.f.cdf(ratio, r[f"{col}_n"] - 1, len(rest_vals) - 1)) if var_r > 0 else 1.0
                t[f"{col}_variance"] = {"site_sd": var_s ** 0.5, "other_sites_sd": var_r ** 0.5, "variance_ratio": ratio, "p_value": p}
                if col == "sbp" and p < cfg.alpha and ratio <= cfg.variance_ratio_max:
                    r["signals"].append("low_variance")
                    findings.append(Finding(
                        "site.low_bp_variance", "site", site, "medium", "suspicious_pattern",
                        f"Systolic BP at {site} has SD {var_s ** 0.5:.1f} versus {var_r ** 0.5:.1f} at the other sites "
                        f"(variance ratio {ratio:.2f}, p={p:.1e}). Real patient data are rarely this uniform.",
                        "Check whether readings were copied, templated or entered without measurement.",
                        t["sbp_variance"], score=1 - ratio, dedupe_key=site, site_id=site))

        # 4-6. Rate comparisons (Fisher exact, one-sided).
        for key, num, den, min_n, rule, label in (
                ("no_otp", "no_otp", "otp_known", cfg.otp_min_count, "site.missing_otp_rate", "completed visits without OTP verification"),
                ("night", "night_entries", "entries", cfg.night_min_count, "site.late_night_entries", "entries made late at night"),
                ("late", "late_entries", "entries", cfg.late_entry_min_count, "site.delayed_entries", "entries made >24 h after the visit")):
            k, n, kr, nr = r[num], r[den], agg(num), agg(den)
            if n == 0 or nr == 0:
                continue
            p = _fisher_greater(k, n, kr, nr)
            t[key] = {"count": k, "n": n, "site_rate": k / n, "other_sites_rate": kr / nr, "p_value": p}
            if k >= min_n and p < cfg.alpha and k / n > kr / nr:
                sig = {"no_otp": "missing_otp", "night": "late_night_entries", "late": "delayed_entries"}[key]
                r["signals"].append(sig)
                findings.append(Finding(
                    rule, "site", site, "medium", "suspicious_pattern",
                    f"{site} has {k} {label} ({k / n:.1%} of {n}) versus {kr / nr:.1%} at the other sites (p={p:.1e}).",
                    "Review the affected visits and the site's data-entry practices.", t[key],
                    score=1 - p ** 0.05 if p > 0 else 1.0, dedupe_key=site, site_id=site))

        # 7. Rapid-entry clusters (detected per visit batch; see visit_rules.rapid_entry_clusters).
        if r["rapid_entry_clusters"]:
            r["signals"].append("rapid_entry_clusters")
        n_sig = len(r["signals"])
        if n_sig >= 2:
            sev = "high" if n_sig >= cfg.min_signals_for_site_review else "medium"
            findings.append(Finding(
                "site.multiple_integrity_signals", "site", site, sev, "suspicious_pattern",
                f"Site {site} shows {n_sig} independent integrity signals ({', '.join(r['signals'])}). Together they are unusual "
                "relative to the other sites and warrant a human review; they do not prove misconduct.",
                "Prioritise this site for a monitoring visit or source-data verification.",
                {"signals": r["signals"], "signalCount": n_sig}, score=min(1.0, n_sig / 6), dedupe_key=site, site_id=site))
    return table, findings
