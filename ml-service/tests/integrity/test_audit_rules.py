from __future__ import annotations

from app.integrity.audit_rules import audit_findings
from app.integrity.config import AuditRuleConfig

CFG = AuditRuleConfig()


def req(**kw):
    base = {"windowStart": "2026-10-25T12:00:00Z", "windowEnd": "2026-11-01T12:00:00Z", "events": [], "reimbursements": [],
            "openVisits": [], "chain": {"valid": True, "eventsChecked": 10, "errorCount": 0, "firstError": None}}
    base.update(kw)
    return base


def ev(seq, action="otp.verify_failed", entity="visit-1", actor="u1", **meta):
    return {"id": f"e{seq}", "seq": seq, "actorId": actor, "action": action, "entityType": "visit", "entityId": entity,
            "createdAt": f"2026-10-30T10:{seq % 60:02d}:00Z", "metadata": meta}


def claim(i, **kw):
    c = {"id": f"c{i}", "patientId": "p1", "visitId": "v1", "category": "travel", "amountCents": 7500, "status": "pending",
         "requestedBy": "u2", "reviewedBy": None, "createdAt": f"2026-10-30T10:0{i}:00Z"}
    c.update(kw)
    return c


def ids(fs):
    return {f.rule_id for f in fs}


def test_clean_request_has_no_findings():
    assert audit_findings(req(events=[ev(1, "otp.issued"), ev(2, "otp.verified")]), CFG) == []


def test_broken_chain_is_a_critical_technical_violation():
    c = {"valid": False, "eventsChecked": 10, "errorCount": 1, "firstError": {"type": "hash_mismatch", "seq": 7, "message": "hash differs"}}
    (f,) = audit_findings(req(chain=c), CFG)
    assert f.rule_id == "ml.chain_broken" and f.severity == "critical" and f.category == "technical_violation"
    assert f.details["verifiedBy"] == "backend" and f.dedupe_key == "seq-7"


def test_sequence_gap_detected_as_possible_deletion():
    fs = audit_findings(req(events=[ev(1, "x"), ev(2, "x"), ev(5, "x")]), CFG)
    assert ids(fs) == {"ml.audit_seq_gap"} and fs[0].details["gaps"] == [{"after": 2, "next": 5}]


def test_otp_failure_burst_needs_the_threshold():
    assert "ml.otp_failure_burst" in ids(audit_findings(req(events=[ev(i) for i in range(1, 6)]), CFG))
    assert "ml.otp_failure_burst" not in ids(audit_findings(req(events=[ev(i) for i in range(1, 5)]), CFG))


def test_self_approval():
    e = ev(1, "reimbursement.approved", entity="c1", actor="u9", requestedBy="u9")
    assert ids(audit_findings(req(events=[e]), CFG)) == {"ml.self_approval"}
    e2 = ev(1, "reimbursement.approved", entity="c1", actor="u9", requestedBy="u1")
    assert audit_findings(req(events=[e2]), CFG) == []


def test_duplicate_claims_ignore_rejected_ones():
    assert ids(audit_findings(req(reimbursements=[claim(1), claim(2)]), CFG)) == {"ml.duplicate_reimbursement"}
    assert audit_findings(req(reimbursements=[claim(1), claim(2, status="rejected")]), CFG) == []


def test_rapid_claim_burst():
    cs = [claim(i, visitId=f"v{i}") for i in range(1, 6)]
    assert "ml.rapid_claim_submission" in ids(audit_findings(req(reimbursements=cs), CFG))


def test_overdue_visits_one_is_data_quality_many_is_a_pattern():
    ov = lambda i, p: {"id": f"v{i}", "patientId": p, "status": "scheduled", "scheduledAt": "2026-10-01T00:00:00Z", "verifiedAt": None}  # noqa: E731
    one = audit_findings(req(openVisits=[ov(1, "pA")]), CFG)
    assert [(f.rule_id, f.severity, f.category) for f in one] == [("ml.unverified_visit_overdue", "low", "data_quality")]
    many = audit_findings(req(openVisits=[ov(i, "pA") for i in range(3)]), CFG)
    assert ids(many) == {"ml.patient_unverified_visits"}


def test_actor_outlier_requires_enough_actors_and_events():
    events = [ev(i, "x", actor="busy") for i in range(1, 121)] + [ev(200 + i, "x", actor=f"u{i % 6}") for i in range(30)]
    assert "ml.actor_activity_outlier" in ids(audit_findings(req(events=events), CFG))
    few = [ev(i, "x", actor="busy") for i in range(1, 30)]
    assert "ml.actor_activity_outlier" not in ids(audit_findings(req(events=few), CFG))


def test_contract_shape_of_findings():
    c = {"valid": False, "eventsChecked": 1, "errorCount": 1, "firstError": None}
    d = audit_findings(req(chain=c), CFG)[0].to_contract()
    assert set(d) <= {"ruleId", "entityType", "entityId", "severity", "score", "message", "details", "dedupeKey"}
    assert d["details"]["category"] == "technical_violation" and "recommendedReviewAction" in d["details"]
