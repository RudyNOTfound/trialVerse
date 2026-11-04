"""Pydantic models for the backend contract (src/ml/contracts.ts). Unknown request fields are ignored, as the
contract requires; response models are what the backend's zod schemas accept."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

from app.integrity.contract_adapter import is_valid_iana

FeatureValue = Union[bool, int, float, str, None]


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore")


class RiskRequest(_In):
    contractVersion: str
    requestId: str = Field(min_length=1, max_length=200)
    entityType: Literal["patient", "visit", "reimbursement"]
    entityId: str = Field(min_length=1, max_length=200)
    featureSchemaVersion: str
    features: Dict[str, FeatureValue]
    requestedAt: str


class RiskFactor(BaseModel):
    name: str
    contribution: float
    detail: Optional[str] = None


class RiskResponse(BaseModel):
    contractVersion: str
    requestId: str
    modelName: str
    modelVersion: str
    score: float = Field(ge=0, le=100)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    factors: List[RiskFactor] = Field(default_factory=list, max_length=50)
    explanation: str = Field(max_length=2000)
    # Additive, ignored by the current backend (contract rule: the app ignores unknown response fields).
    retentionRiskLevel: Optional[str] = None
    recommendedActions: List[Dict[str, Any]] = Field(default_factory=list)


class AuditEvent(_In):
    id: str
    seq: int
    actorId: Optional[str] = None
    action: str
    entityType: str
    entityId: str
    createdAt: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Reimbursement(_In):
    id: str
    patientId: str
    visitId: str
    category: str
    amountCents: int
    status: str
    requestedBy: str
    reviewedBy: Optional[str] = None
    createdAt: str


class OpenVisit(_In):
    id: str
    patientId: str
    status: str
    scheduledAt: str
    verifiedAt: Optional[str] = None


class ChainFirstError(_In):
    type: str
    seq: Optional[int] = None
    message: str


class Chain(_In):
    valid: bool
    eventsChecked: int
    errorCount: int
    firstError: Optional[ChainFirstError] = None


class IntegrityRequest(_In):
    contractVersion: str
    requestId: str = Field(min_length=1, max_length=200)
    windowStart: str
    windowEnd: str
    events: List[AuditEvent] = Field(default_factory=list, max_length=5000)
    reimbursements: List[Reimbursement] = Field(default_factory=list, max_length=2000)    # contract 01 §5 (backend sends <= 2000)
    openVisits: List[OpenVisit] = Field(default_factory=list, max_length=2000)
    chain: Chain
    trialData: Optional["TrialData"] = None          # v1.1; absent => audit rules only (today's behaviour, never a fabricated scan)


class IntegrityResponse(BaseModel):
    contractVersion: str
    requestId: str
    modelName: str
    modelVersion: str
    findings: List[Dict[str, Any]] = Field(max_length=1000)


# --- contract v1.1: IntegrityScanRequest.trialData (spec 01 §4) ---------------------------------------------
VisitStatus = Literal["scheduled", "otp_pending", "verified", "completed", "missed", "cancelled"]
OtpExceptionReason = Literal["device_offline", "participant_unreachable", "otp_delivery_failed", "coordinator_override", "other"]
_Id = Field(min_length=1, max_length=100)
_Num = Field(default=None, strict=True, allow_inf_nan=False)       # numbers only: strings, booleans, NaN/Infinity => 422


def _iso(v: Any, *, need_offset: bool, field: str) -> Any:
    """ISO-8601 or 422. An offset-less value is allowed only where it becomes a data-quality finding (never guessed)."""
    if v is None:
        return v
    if not isinstance(v, str):
        raise ValueError(f"{field} must be an ISO-8601 string")
    try:
        dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{field} is not an ISO-8601 timestamp")
    if need_offset and dt.tzinfo is None:
        raise ValueError(f"{field} must carry 'Z' or a UTC offset")
    return v


class Scope(_In):
    trialId: str = _Id
    asOf: str

    @field_validator("asOf")
    @classmethod
    def _as_of(cls, v: str) -> str:
        return _iso(v, need_offset=True, field="asOf")


class SiteRef(_In):
    siteId: str = _Id
    siteCode: str = Field(min_length=1, max_length=64)
    timezone: str                                              # required, never defaulted (decision D2)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        if not is_valid_iana(v):
            raise ValueError("timezone must be a canonical IANA name such as 'Asia/Kolkata' (no offsets or abbreviations)")
        return v


class ParticipantRef(_In):
    participantId: str = _Id
    siteId: str = _Id
    droppedOut: StrictBool                                     # required; never derived from visits on this path (D6)


class ContractVisit(_In):
    visitId: str = _Id
    participantId: str = _Id
    siteId: str = _Id
    visitNumber: StrictInt = Field(ge=1, le=100)
    visitType: Optional[str] = Field(default=None, max_length=60)
    status: VisitStatus
    scheduledAt: str
    performedAt: Optional[str] = None
    enteredAt: Optional[str] = None
    otpVerified: Optional[StrictBool] = None
    otpExceptionReason: Optional[OtpExceptionReason] = None
    systolicBp: Optional[float] = _Num
    diastolicBp: Optional[float] = _Num
    heartRate: Optional[float] = _Num
    weightKg: Optional[float] = _Num
    glucoseMgDl: Optional[float] = _Num
    ecgRecordId: Optional[str] = Field(default=None, min_length=1, max_length=100)

    @field_validator("scheduledAt")
    @classmethod
    def _sched(cls, v: str) -> str:
        return _iso(v, need_offset=True, field="scheduledAt")

    @field_validator("performedAt", "enteredAt")
    @classmethod
    def _ts(cls, v: Optional[str], info: Any) -> Optional[str]:
        return _iso(v, need_offset=False, field=info.field_name)     # offset-less => `visit.invalid_timestamp` finding

    @model_validator(mode="after")
    def _exception_reason(self) -> "ContractVisit":
        if self.otpExceptionReason is not None and self.otpVerified is not False:
            raise ValueError("otpExceptionReason is only allowed when otpVerified is false")
        return self


class ContractEcg(_In):
    ecgRecordId: str = _Id
    visitId: str = _Id
    participantId: str = _Id
    siteId: str = _Id
    imageRef: str = Field(max_length=500)         # relative to ML_ECG_DIR; '' / traversal / missing file => ecg.file_unavailable


class TrialData(_In):
    scope: Scope
    sites: List[SiteRef] = Field(max_length=200)
    participants: List[ParticipantRef] = Field(max_length=5000)
    visits: List[ContractVisit] = Field(max_length=20000)
    ecgs: Optional[List[ContractEcg]] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _references(self) -> "TrialData":
        """Referential integrity: every id must resolve and be unique, otherwise the request is malformed (422)."""
        def unique(items: List[str], what: str) -> set:
            seen: set = set()
            for i in items:
                if i in seen:
                    raise ValueError(f"duplicate {what}: {i}")
                seen.add(i)
            return seen
        sites = unique([s.siteId for s in self.sites], "siteId")
        parts = unique([p.participantId for p in self.participants], "participantId")
        unique([v.visitId for v in self.visits], "visitId")
        for p in self.participants:
            if p.siteId not in sites:
                raise ValueError(f"participant {p.participantId} references unknown siteId {p.siteId}")
        by_visit = {v.visitId: v for v in self.visits}
        for v in self.visits:
            if v.siteId not in sites:
                raise ValueError(f"visit {v.visitId} references unknown siteId {v.siteId}")
            if v.participantId not in parts:
                raise ValueError(f"visit {v.visitId} references unknown participantId {v.participantId}")
        ecgs = self.ecgs or []                       # an omitted list is an empty list: a visit's ecgRecordId must still resolve
        records = {e.ecgRecordId for e in ecgs}
        unique([e.ecgRecordId for e in ecgs], "ecgRecordId")
        for e in ecgs:
            v = by_visit.get(e.visitId)
            if v is None or e.siteId not in sites or e.participantId not in parts:
                raise ValueError(f"ECG {e.ecgRecordId} references an unknown visit, participant or site")
            if v.siteId != e.siteId or v.participantId != e.participantId:
                raise ValueError(f"ECG {e.ecgRecordId} disagrees with visit {e.visitId} on site or participant")
        for v in self.visits:
            if v.ecgRecordId is not None and v.ecgRecordId not in records:
                raise ValueError(f"visit {v.visitId} references ecgRecordId {v.ecgRecordId} that is not in ecgs[]")
        return self


IntegrityRequest.model_rebuild()


# --- non-contract: trial-data scan ---------------------------------------------------------------------
class TrialVisit(_In):
    visit_id: str
    participant_id: str
    site_id: str
    visit_number: int
    visit_type: Optional[str] = None
    scheduled_date: str
    status: Literal["completed", "missed", "scheduled", "cancelled"]
    device_timestamp: Optional[str] = None
    entry_timestamp: Optional[str] = None
    otp_verified: Optional[int] = None
    systolic_bp: Optional[float] = None
    diastolic_bp: Optional[float] = None
    heart_rate: Optional[float] = None
    weight_kg: Optional[float] = None
    glucose_mg_dl: Optional[float] = None
    ecg_id: Optional[str] = None


class TrialParticipant(_In):
    participant_id: str
    site_id: Optional[str] = None
    dropped_out: bool


class TrialEcg(_In):
    ecg_id: str
    visit_id: Optional[str] = None
    participant_id: Optional[str] = None
    site_id: Optional[str] = None
    image_file: Optional[str] = None


class TrialScanRequest(_In):
    requestId: Optional[str] = Field(default=None, max_length=200)
    visits: List[TrialVisit] = Field(min_length=1, max_length=20000)
    participants: Optional[List[TrialParticipant]] = Field(default=None, max_length=5000)
    ecgs: Optional[List[TrialEcg]] = Field(default=None, max_length=2000)
