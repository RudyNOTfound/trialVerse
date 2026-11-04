"""Checks on the backend's `IntegrityScanRequest` (audit events, reimbursements, open visits, chain summary).

Hash-chain boundary: the contract carries only the backend's own chain verdict (`chain`), not each event's
`prevHash`/`hash`, so cryptographic re-verification stays in the TypeScript backend (`src/modules/audit/chain.ts`).
Python reports that verdict and independently checks what the payload does expose: `seq` continuity.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from typing import Any, Dict, List

import numpy as np

from .config import AuditRuleConfig
from .findings import Finding
from .trial_data import parse_ts


def _ts(s: Any) -> float:
    d = parse_ts(s)
    return d.timestamp() if d else float("nan")


def audit_findings(req: Dict[str, Any], cfg: AuditRuleConfig) -> List[Finding]:
    out: List[Finding] = []
    events: List[Dict[str, Any]] = req.get("events", [])
    claims: List[Dict[str, Any]] = req.get("reimbursements", [])
    window = req.get("windowStart", "")[:10]

    chain = req.get("chain") or {}
    if chain and (not chain.get("valid", True) or chain.get("errorCount", 0) > 0):
        fe = chain.get("firstError") or {}
        out.append(Finding(
            "ml.chain_broken", "audit_chain", "main", "critical", "technical_violation",
            f"The backend reports a broken audit hash chain ({chain.get('errorCount', 0)} error(s)): {fe.get('message', 'no detail')}. "
            "This is a verified technical violation, not a statistical signal.",
            "Treat the audit log as tampered until the break is explained; investigate the first failing sequence number.",
            {"firstError": fe, "eventsChecked": chain.get("eventsChecked"), "errorCount": chain.get("errorCount"),
             "verifiedBy": "backend"}, dedupe_key=f"seq-{fe.get('seq')}"))

    seqs = [e["seq"] for e in events]
    gaps = [(a, b) for a, b in zip(seqs, seqs[1:]) if b != a + 1]
    if gaps:
        out.append(Finding(
            "ml.audit_seq_gap", "audit_chain", "main", "high", "technical_violation",
            f"Audit event sequence numbers are not contiguous inside the scan window ({len(gaps)} gap(s), first after seq {gaps[0][0]}). "
            "Events may have been deleted.",
            "Compare against the database audit table and the chain verdict.",
            {"gaps": [{"after": a, "next": b} for a, b in gaps[:20]], "gapCount": len(gaps)}, dedupe_key=f"{gaps[0][0]}-{gaps[0][1]}"))

    # OTP brute force: many failed attempts on one visit.
    fails: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for e in events:
        if e["action"] == "otp.verify_failed" and e["entityType"] == "visit":
            fails[e["entityId"]].append(e)
    for vid, evs in fails.items():
        if len(evs) >= cfg.otp_failure_burst:
            out.append(Finding(
                "ml.otp_failure_burst", "visit", vid, "high", "suspicious_pattern",
                f"{len(evs)} failed OTP attempts on one visit in the window (threshold {cfg.otp_failure_burst}). May indicate code guessing.",
                "Contact the participant through a trusted channel and confirm they attended.",
                {"failedAttempts": len(evs), "firstSeq": evs[0]["seq"], "lastSeq": evs[-1]["seq"]},
                score=min(1.0, len(evs) / (2 * cfg.otp_failure_burst)), dedupe_key=f"seq-{evs[-1]['seq']}"))

    # Same person approving their own claim: a policy violation visible directly in the events.
    for e in events:
        if e["action"] == "reimbursement.approved" and e.get("actorId") and e.get("metadata", {}).get("requestedBy") == e["actorId"]:
            out.append(Finding(
                "ml.self_approval", "reimbursement", e["entityId"], "critical", "technical_violation",
                "A reimbursement was approved by the same user who requested it.",
                "Reverse the approval and have a different reviewer assess the claim.",
                {"actorId": e["actorId"], "seq": e["seq"]}, dedupe_key=f"seq-{e['seq']}"))

    # Duplicate pending/approved claims (same visit + category + amount).
    groups: Dict[Any, List[Dict[str, Any]]] = defaultdict(list)
    for c in claims:
        if c["status"] in ("pending", "approved"):
            groups[(c["visitId"], c["category"], c["amountCents"])].append(c)
    for (vid, cat, amt), cs in groups.items():
        if len(cs) > 1:
            cs = sorted(cs, key=lambda c: c["createdAt"])
            out.append(Finding(
                "ml.duplicate_reimbursement", "reimbursement", cs[-1]["id"], "high", "suspicious_pattern",
                f"{len(cs)} active claims for the same visit, category ({cat}) and amount ({amt} cents).",
                "Pay at most one of the claims; ask the requester which is intended.",
                {"claimIds": [c["id"] for c in cs], "visitId": vid, "category": cat, "amountCents": amt},
                score=min(1.0, len(cs) / 3), dedupe_key=cs[-1]["id"]))

    # Burst of claims by one requester.
    by_req: Dict[str, List[float]] = defaultdict(list)
    for c in claims:
        by_req[c["requestedBy"]].append(_ts(c["createdAt"]))
    for who, ts in by_req.items():
        ts = sorted(t for t in ts if not np.isnan(t))
        for i in range(len(ts) - cfg.claim_burst_count + 1):
            if ts[i + cfg.claim_burst_count - 1] - ts[i] <= cfg.claim_burst_minutes * 60:
                out.append(Finding(
                    "ml.rapid_claim_submission", "user", who, "medium", "suspicious_pattern",
                    f"{cfg.claim_burst_count}+ reimbursement claims submitted within {cfg.claim_burst_minutes:g} minutes by one user.",
                    "Check the claims for template copying or batch entry.",
                    {"claimsInBurst": cfg.claim_burst_count, "windowMinutes": cfg.claim_burst_minutes},
                    dedupe_key=datetime.utcfromtimestamp(ts[i]).strftime("%Y-%m-%dT%H")))
                break

    # Visits unverified long after their schedule: one is a data-quality warning, many per patient is a pattern.
    per_patient = Counter(v["patientId"] for v in req.get("openVisits", []))
    for v in req.get("openVisits", []):
        if per_patient[v["patientId"]] < cfg.overdue_visits_per_patient:
            out.append(Finding(
                "ml.unverified_visit_overdue", "visit", v["id"], "low", "data_quality",
                "Visit is past its scheduled time and still has no OTP verification.",
                "Follow up with the site; mark as missed if the visit did not take place.",
                {"scheduledAt": v["scheduledAt"], "status": v["status"]}, dedupe_key=v["id"]))
    for pid, n in per_patient.items():
        if n >= cfg.overdue_visits_per_patient:
            out.append(Finding(
                "ml.patient_unverified_visits", "patient", pid, "medium", "suspicious_pattern",
                f"{n} visits for one patient remain unverified past their schedule.",
                "Contact the patient or site to establish whether the visits occurred.",
                {"unverifiedVisits": n}, score=min(1.0, n / (2 * cfg.overdue_visits_per_patient)), dedupe_key=f"{window}-{n}"))

    # Actor activity outlier: robust z-score of events per actor (needs enough actors and events).
    counts = Counter(e["actorId"] for e in events if e.get("actorId"))
    if len(counts) >= cfg.actor_min_actors and sum(counts.values()) >= cfg.actor_min_events:
        vals = np.array(list(counts.values()), dtype=float)
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) or 1.0
        total = vals.sum()
        for actor, n in counts.items():
            z = 0.6745 * (n - med) / mad
            if z >= cfg.actor_robust_z and n / total >= cfg.actor_min_share:
                out.append(Finding(
                    "ml.actor_activity_outlier", "user", actor, "medium", "suspicious_pattern",
                    f"This user generated {n} of {int(total)} audit events ({n / total:.0%}), far above the median actor "
                    f"(robust z={z:.1f}). Heavy activity can be legitimate (e.g. a coordinator).",
                    "Confirm the activity matches the user's role.",
                    {"events": n, "share": round(n / total, 3), "medianEvents": med, "robustZ": round(z, 2)},
                    score=min(1.0, z / 10), dedupe_key=window))
    return out
