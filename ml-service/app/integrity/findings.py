"""Internal finding type. `to_contract()` yields exactly the backend's `integrityFindingSchema` shape."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

SEVERITIES = ("low", "medium", "high", "critical")
# technical_violation: verifiable breach (e.g. broken hash chain). suspicious_pattern: needs human review.
# data_quality: ordinary warning, not evidence of misconduct.
CATEGORIES = ("technical_violation", "suspicious_pattern", "data_quality")


@dataclass
class Finding:
    rule_id: str
    entity_type: str
    entity_id: str
    severity: str
    category: str
    message: str
    review_action: str
    details: Dict[str, Any] = field(default_factory=dict)
    score: Optional[float] = None
    dedupe_key: Optional[str] = None
    site_id: Optional[str] = None

    def __post_init__(self) -> None:
        assert self.severity in SEVERITIES and self.category in CATEGORIES

    def to_contract(self) -> Dict[str, Any]:
        d = dict(self.details)
        d.update(category=self.category, recommendedReviewAction=self.review_action)
        if self.site_id:
            d["siteId"] = self.site_id
        out: Dict[str, Any] = {"ruleId": self.rule_id, "entityType": self.entity_type, "entityId": self.entity_id,
                               "severity": self.severity, "message": self.message[:1000], "details": d}
        if self.score is not None:
            out["score"] = round(min(1.0, max(0.0, float(self.score))), 4)
        if self.dedupe_key:
            out["dedupeKey"] = self.dedupe_key[:200]
        return out

    def to_native(self) -> Dict[str, Any]:
        """Richer shape for the non-contract trial-scan endpoint and the demo report."""
        return {"ruleId": self.rule_id, "category": self.category, "severity": self.severity,
                "entityType": self.entity_type, "entityId": self.entity_id, "siteId": self.site_id,
                "explanation": self.message, "evidence": self.details,
                "score": None if self.score is None else round(float(self.score), 4),
                "recommendedReviewAction": self.review_action, "dedupeKey": self.dedupe_key}


_RANK = {s: i for i, s in enumerate(SEVERITIES)}


def sort_findings(fs: List[Finding]) -> List[Finding]:
    return sorted(fs, key=lambda f: (-_RANK[f.severity], -(f.score or 0.0), f.rule_id, f.entity_id))
