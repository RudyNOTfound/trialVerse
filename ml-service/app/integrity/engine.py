"""IntegrityEngine: wires the checks together for the two entry points (contract scan, trial scan)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from .anomaly import anomaly_scan
from .contract_adapter import merge_findings, relabel, to_internal
from .audit_rules import audit_findings
from .config import IntegrityConfig
from .ecg_dupes import PhashCache, detect_ecg_duplicates
from .findings import Finding, sort_findings
from .site_stats import derive_retention, site_statistics
from .trial_data import prepare_visits
from .visit_rules import SIGNAL_TEXT, rapid_entry_clusters, visit_findings, visit_signals

log = logging.getLogger("trialguard.integrity")


class IntegrityEngine:
    def __init__(self, cfg: Optional[IntegrityConfig] = None):
        self.cfg = cfg or IntegrityConfig()
        self._cache = PhashCache(self.cfg.ecg.cache_size)

    @property
    def name(self) -> str:
        return self.cfg.model_name

    @property
    def version(self) -> str:
        return self.cfg.model_version

    def self_check(self) -> Dict[str, Any]:
        """Cheap readiness probe: the engine's dependencies import and the ECG root is reachable."""
        import imagehash, sklearn  # noqa: F401, E401
        return {"ecg_root": str(self.cfg.ecg_root), "ecg_root_exists": Path(self.cfg.ecg_root).is_dir()}

    # -- contract surface -----------------------------------------------------------------------------
    def scan_contract(self, request: Dict[str, Any]) -> List[Finding]:
        """Findings for a backend `IntegrityScanRequest` (already validated)."""
        return sort_findings(audit_findings(request, self.cfg.audit))[: self.cfg.max_findings]

    def scan_request(self, request: Dict[str, Any], trial: Any = None) -> Dict[str, Any]:
        """Full v1.1 scan: audit rules always; when `trialData` (a validated `TrialData`) is supplied, also the visit rules,
        site statistics, ECG duplicates and the anomaly signal. Hash-chain verification is NOT done here (backend-owned);
        only the backend's own verdict is reported."""
        audit = self.scan_contract(request)            # audit-only path (v1.0 behaviour), reused unchanged
        if trial is None:
            return {"findings": merge_findings(audit)[: self.cfg.max_findings], "trial": None}
        visits, participants, ecgs, codes = to_internal(trial)
        res = self.scan_trial(visits, participants, ecgs or None, _cap=False)
        relabel(res["findings"], codes)
        merged = merge_findings(audit, res["findings"])
        return {"findings": merged[: self.cfg.max_findings], "trial": res["summary"], "truncated": max(0, len(merged) - self.cfg.max_findings)}

    # -- trial-data surface (non-contract) --------------------------------------------------------------
    def scan_trial(self, visits: List[Dict[str, Any]], participants: Optional[List[Dict[str, Any]]] = None,
                   ecgs: Optional[List[Dict[str, Any]]] = None, _cap: bool = True) -> Dict[str, Any]:
        cfg = self.cfg
        df = prepare_visits(visits)
        findings: List[Finding] = []
        if df.empty:
            return {"findings": [], "siteStatistics": [], "summary": {"visits": 0}, "anomaly": {"status": "skipped", "reason": "no visits"},
                    "ecg": {}}

        signals = visit_signals(df, cfg.visit)
        bursts = rapid_entry_clusters(df, cfg.visit)
        for b in bursts:
            for vid in b["visit_ids"]:
                signals.setdefault(vid, {})["rapid_entry"] = {"cluster_start": b["start"], "cluster_end": b["end"],
                                                              "entries": len(b["visit_ids"]), "span_minutes": b["span_minutes"]}
            findings.append(Finding(
                "site.rapid_entry_cluster", "site", b["site_id"], "medium", "suspicious_pattern",
                f"{len(b['visit_ids'])} visits at {b['site_id']} were entered within {b['span_minutes']:g} minutes "
                f"({b['start']} to {b['end']}).",
                "Ask who entered these records and compare with visit dates in source documents.",
                {"visitIds": b["visit_ids"], "start": b["start"], "end": b["end"], "spanMinutes": b["span_minutes"]},
                dedupe_key=b["start"], site_id=b["site_id"]))

        _, anomaly_summary = anomaly_scan(df, cfg.anomaly)
        findings += visit_findings(df, signals, cfg.visit)
        for ps in anomaly_summary.get("per_site", []):
            if ps["enriched"]:
                findings.append(Finding(
                    "site.anomaly_enrichment", "site", ps["site_id"], "medium", "suspicious_pattern",
                    f"Participant recording profiles at {ps['site_id']} score higher on the unsupervised anomaly model than at the other "
                    f"sites (mean {ps['mean_anomaly_score']:.2f} vs {ps['other_sites_mean_anomaly_score']:.2f}, p={ps['p_value']:.1e}). "
                    "This is an anomaly signal, not proof of fraud.",
                    "Use alongside the site-level statistics; do not act on this score alone.",
                    {k: v for k, v in ps.items() if k != "enriched"}, score=ps["mean_anomaly_score"], dedupe_key=ps["site_id"], site_id=ps["site_id"]))

        retention = derive_retention(df, participants)
        table, site_f = site_statistics(df, retention, bursts, cfg.site, cfg.visit)
        findings += site_f

        ecg_stats: Dict[str, Any] = {}
        if ecgs:
            ef, ecg_stats = detect_ecg_duplicates(ecgs, Path(cfg.ecg_root), cfg.ecg, self._cache)
            findings += ef

        findings = sort_findings(findings)
        truncated = max(0, len(findings) - cfg.max_findings)
        if truncated:
            log.warning("findings truncated", extra={"event": "findings_truncated", "dropped": truncated})
        return {"findings": findings[: cfg.max_findings] if _cap else findings, "siteStatistics": table, "anomaly": anomaly_summary, "ecg": ecg_stats,
                "summary": {"visits": int(len(df)), "completedVisits": int((df.status == "completed").sum()),
                            "sites": sorted(set(df.site_id)), "findings": len(findings), "truncated": truncated,
                            "bySeverity": {s: sum(1 for f in findings if f.severity == s) for s in ("critical", "high", "medium", "low")},
                            "byCategory": {c: sum(1 for f in findings if f.category == c)
                                           for c in ("technical_violation", "suspicious_pattern", "data_quality")}}}
