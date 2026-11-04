"""Run the integrity engine over the Phase 3 demo trial and write a readable report.

    cd ml-service && python -m app.integrity.demo            # -> reports/integrity/integrity_demo.{md,json}

Reads generated_data/ (Phase 3); never modifies it. Output is deterministic.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd

from app.config import ML_SERVICE_ROOT

from .config import IntegrityConfig
from .engine import IntegrityEngine


def _records(path: Path) -> List[Dict[str, Any]]:
    df = pd.read_csv(path)
    return df.astype(object).where(df.notna(), None).to_dict("records")


def load_demo(data_dir: Path) -> Dict[str, Any]:
    d = Path(data_dir)
    return {"visits": _records(d / "demo" / "visits.csv"), "participants": _records(d / "demo" / "participants.csv"),
            "ecgs": _records(d / "demo" / "ecg_metadata.csv"),
            "truth": pd.read_csv(d / "metadata" / "fraud_ground_truth.csv")}


def run_demo(data_dir: Path) -> Dict[str, Any]:
    data = load_demo(data_dir)
    eng = IntegrityEngine(IntegrityConfig(ecg_root=Path(data_dir)))
    res = eng.scan_trial(data["visits"], data["participants"], data["ecgs"])
    res["truth"] = data["truth"]
    res["evaluation"] = evaluate(res["findings"], data["truth"], data["visits"])
    return res


def evaluate(findings, truth: pd.DataFrame, visits) -> Dict[str, Any]:
    flagged_visits = {f.entity_id for f in findings if f.rule_id == "visit.multiple_integrity_signals"}
    ecg_visits = {v for f in findings if f.rule_id == "ecg.duplicate_image" for v in f.details["visitIds"]}
    t_batch = set(truth[truth.anomaly_type == "unverified_batch_late_night_entry"].visit_id)
    t_ecg = set(truth[truth.anomaly_type == "reused_ecg_image"].visit_id)
    site_of = {v["visit_id"]: v["site_id"] for v in visits}
    c_visits = sum(1 for s in site_of.values() if s == "SITE-C")
    site_level = Counter(f.site_id for f in findings if f.entity_type == "site" and f.severity in ("medium", "high"))
    honest_multi = sorted(v for v in flagged_visits if site_of.get(v) != "SITE-C")
    return {
        "injected_unverified_late_night_visits": len(t_batch), "of_which_flagged_multi_signal": len(t_batch & flagged_visits),
        "multi_signal_visits_not_in_ground_truth": sorted(flagged_visits - t_batch),
        "injected_reused_ecg_visits": len(t_ecg), "of_which_in_duplicate_clusters": len(t_ecg & ecg_visits),
        "ecg_visits_not_in_ground_truth": sorted(ecg_visits - t_ecg),
        "siteC_visits_total": c_visits, "siteC_visits_with_multi_signal_finding": len(flagged_visits & {v for v, s in site_of.items() if s == "SITE-C"}),
        "honest_site_multi_signal_visits": honest_multi,
        "site_level_medium_or_high_findings_by_site": dict(site_level),
        "honest_site_single_signal_warnings": sum(1 for f in findings if f.rule_id.startswith("visit.") and f.rule_id != "visit.multiple_integrity_signals"
                                                  and f.site_id != "SITE-C"),
    }


def _fmt(v: Any) -> str:
    return "—" if v is None or (isinstance(v, float) and pd.isna(v)) else (f"{v:.3g}" if isinstance(v, float) else str(v))


def render(res: Dict[str, Any]) -> str:
    ev, s = res["evaluation"], res["summary"]
    L = ["# Integrity engine demonstration (GLU-301, synthetic)", "",
         "Synthetic Phase 3 data, fully fictional. Findings are review prompts; none of them establishes fraud. "
         "This prototype is not validated for real clinical-trial monitoring.", "",
         f"Visits scanned: {s['visits']} ({s['completedVisits']} completed) across {len(s['sites'])} sites. "
         f"Findings: {s['findings']} — by severity {s['bySeverity']}, by category {s['byCategory']}.", "",
         "## Site-level statistics", "",
         "| Site | Participants | Completed visits | Retained | SBP SD | SBP ending 0/5 | Completed w/o OTP | Late-night entries | Entries >24 h late | Rapid-entry clusters | Signals |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in res["siteStatistics"]:
        L.append(f"| {r['site_id']} | {r['n_participants']} | {r['n_completed_visits']} | {r['n_retained']}/{r['n_retention_known']} | "
                 f"{_fmt(r['sbp_sd'])} | {r['sbp_end05'] / r['sbp_n']:.0%} | {r['no_otp']} | {r['night_entries']} | {r['late_entries']} | "
                 f"{r['rapid_entry_clusters']} | {', '.join(r['signals']) or '—'} |")
    L += ["", "Comparative tests (each site vs the pooled other sites, one-sided; p-values):", "",
          "| Site | Retention | SBP digit pref. | SBP variance ratio | Missing OTP | Late night | Delayed entry |", "|---|---|---|---|---|---|---|"]
    for r in res["siteStatistics"]:
        t = r["tests"]
        g = lambda k, f="p_value": _fmt(t[k][f]) if k in t else "n/a"  # noqa: E731
        L.append(f"| {r['site_id']} | {g('retention')} | {g('sbp_digit_preference')} | {g('sbp_variance')} (ratio {g('sbp_variance', 'variance_ratio')}) | "
                 f"{g('no_otp')} | {g('night')} | {g('late')} |")
    an = res["anomaly"]
    if an.get("status") == "ok":
        L += ["", f"Isolation Forest over {an['rows']} participant recording profiles (features: {', '.join(an['features'])}; "
              f"contamination assumption {an['contamination']}). Site score comparison (Mann-Whitney U vs other sites):", "",
              "| Site | Mean anomaly score | Others | p | Participants in anomalous set |", "|---|---|---|---|---|"]
        L += [f"| {p['site_id']} | {p['mean_anomaly_score']:.3f} | {p['other_sites_mean_anomaly_score']:.3f} | {p['p_value']:.2g} | {p['flagged']} |"
              for p in an["per_site"]]
    L += ["", "## Findings", ""]
    order = ["technical_violation", "suspicious_pattern", "data_quality"]
    for cat in order:
        fs = [f for f in res["findings"] if f.category == cat and f.rule_id != "visit.multiple_integrity_signals"]
        L.append(f"### {cat.replace('_', ' ').title()} ({len(fs) + sum(1 for f in res['findings'] if f.category == cat and f.rule_id == 'visit.multiple_integrity_signals')})")
        L.append("")
        for f in fs:
            L.append(f"- **{f.severity.upper()}** `{f.rule_id}` — {f.entity_type} `{f.entity_id}`: {f.message}")
        if cat == "suspicious_pattern":
            mv = [f for f in res["findings"] if f.rule_id == "visit.multiple_integrity_signals"]
            if mv:
                sites = Counter(f.site_id for f in mv)
                L.append(f"- **{mv[0].severity.upper()}** `visit.multiple_integrity_signals` — {len(mv)} visits ({dict(sites)}), "
                         f"e.g. `{mv[0].entity_id}` with signals {mv[0].details['signals']}. Full list in the JSON report.")
        L.append("")
    L += ["## Duplicate ECG clusters", "", "| Cluster | Visits | Participants | Max Hamming distance (of 64 bits) |", "|---|---|---|---|"]
    for f in res["findings"]:
        if f.rule_id == "ecg.duplicate_image":
            d = f.details
            L.append(f"| `{f.entity_id}` | {', '.join(d['visitIds'])} | {', '.join(d['participantIds'])} | {d['maxHammingDistance']} |")
    L += ["", f"ECG images checked: {res['ecg'].get('ecgs_checked')}; unreadable: {res['ecg'].get('ecgs_unreadable')}.", "",
          "## Check against the Phase 3 ground truth", "",
          f"- Injected unverified late-night visits: {ev['injected_unverified_late_night_visits']}; flagged as multi-signal visits: "
          f"{ev['of_which_flagged_multi_signal']}.",
          f"- Multi-signal visits not in the ground truth: {ev['multi_signal_visits_not_in_ground_truth'] or 'none'}.",
          f"- Injected reused-ECG visits: {ev['injected_reused_ecg_visits']}; inside duplicate clusters: {ev['of_which_in_duplicate_clusters']}; "
          f"ECG-cluster visits not in ground truth: {ev['ecg_visits_not_in_ground_truth'] or 'none'}.",
          f"- Site C visits: {ev['siteC_visits_total']}; with a multi-signal finding: {ev['siteC_visits_with_multi_signal_finding']} "
          "(the engine does not flag every Site C visit).",
          f"- Honest-site multi-signal visits: {ev['honest_site_multi_signal_visits'] or 'none'}; site-level medium/high findings by site: "
          f"{ev['site_level_medium_or_high_findings_by_site']}.",
          f"- Honest-site single-signal data-quality warnings (e.g. missing OTP): {ev['honest_site_single_signal_warnings']} — kept at LOW "
          "because one weak rule is not evidence of misconduct.", "",
          "## Limitations observed", "",
          "- Ground truth is injected by the same author as the detectors, so detection here is a sanity check, not a performance estimate.",
          "- Site C's patterns are strong by construction. Subtler real-world fabrication would be harder to see.",
          "- Honest sites still trigger a few LOW missing-OTP warnings (about 0.6% of their visits); any real deployment must expect such noise.",
          "- The visit-level Isolation Forest was dropped: coordinated fabrication forms a dense cluster, so few members are individually "
          "isolated. The participant-profile forest only separates Site C as a group (mean score), and only through features that overlap the "
          "variance and digit-preference statistics, so it is a corroborating signal rather than independent evidence.",
          "- Retention is derived from the supplied `dropped_out` flags; high retention alone is shown as LOW severity.",
          "- Hash-chain verification is not repeated here: the backend contract carries only the backend's own chain verdict.", ""]
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=ML_SERVICE_ROOT / "generated_data")
    ap.add_argument("--out-dir", type=Path, default=ML_SERVICE_ROOT / "reports" / "integrity")
    a = ap.parse_args(argv)
    if not (a.data_dir / "demo" / "visits.csv").exists():
        print(f"{a.data_dir}/demo/visits.csv not found. Generate first: python -m app.data_generation.generate_all")
        return 1
    res = run_demo(a.data_dir)
    a.out_dir.mkdir(parents=True, exist_ok=True)
    (a.out_dir / "integrity_demo.md").write_text(render(res))
    (a.out_dir / "integrity_demo.json").write_text(json.dumps(
        {"summary": res["summary"], "siteStatistics": res["siteStatistics"], "anomaly": res["anomaly"], "ecg": res["ecg"],
         "evaluation": res["evaluation"], "findings": [f.to_native() for f in res["findings"]]}, indent=2, sort_keys=True, default=str) + "\n")
    print(f"wrote {a.out_dir}/integrity_demo.md  ({res['summary']['findings']} findings)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
