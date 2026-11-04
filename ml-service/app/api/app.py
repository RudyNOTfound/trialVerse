"""FastAPI app factory. Model artifacts are loaded once at startup; nothing is trained at serve time."""
from __future__ import annotations

import asyncio
import hmac
import logging
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, Optional

from fastapi import Depends, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.integrity.config import IntegrityConfig
from app.integrity.engine import IntegrityEngine
from app.retention.artifacts import BACKGROUND_FILE, METADATA_FILE, PIPELINE_FILE, ArtifactError
from app.retention.config import RetentionConfig
from app.retention.predict import RetentionPredictor
from app.retention.schemas import InvalidInputError, ParticipantFeatures

from . import risk_adapter
from .errors import ApiError, error_response, install_error_handlers
from .logging_setup import configure_logging
from .schemas import (IntegrityRequest, IntegrityResponse, RiskRequest, RiskResponse,
                      TrialScanRequest)
from .settings import CONTRACT_VERSION, Settings

log = logging.getLogger("trialguard.api")


class State:
    """Mutable service state. `predict_lock` serialises SHAP/sklearn calls (not documented as thread-safe)."""

    def __init__(self) -> None:
        self.predictor: Optional[RetentionPredictor] = None
        self.retention_error: Optional[str] = None
        self.engine: Optional[IntegrityEngine] = None
        self.engine_error: Optional[str] = None
        self.predict_lock = threading.Lock()


def _load(state: State, settings: Settings) -> None:
    try:
        state.predictor = RetentionPredictor.load(settings.model_dir, RetentionConfig(model_dir=settings.model_dir))
        state.predictor._get_explainer()          # build the SHAP explainer now, not on the first request
        state.retention_error = None
    except (ArtifactError, Exception) as exc:      # the service stays up and reports not-ready; it never serves guesses
        state.predictor, state.retention_error = None, f"{type(exc).__name__}: {exc}"
        log.error("retention model failed to load", extra={"event": "model_load_failed", "error": state.retention_error})
    try:
        state.engine = IntegrityEngine(IntegrityConfig(ecg_root=settings.ecg_dir))
        state.engine.self_check()
        state.engine_error = None
    except Exception as exc:
        state.engine, state.engine_error = None, f"{type(exc).__name__}: {exc}"
        log.error("integrity engine unavailable", extra={"event": "engine_init_failed", "error": state.engine_error})


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    configure_logging(settings.log_level)
    state = State()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await run_in_threadpool(_load, state, settings)
        log.info("service started", extra={"event": "startup", "retentionLoaded": state.predictor is not None,
                                           "integrityAvailable": state.engine is not None})
        yield
        state.predictor = None                     # drop model references on shutdown
        state.engine = None
        log.info("service stopped", extra={"event": "shutdown"})

    app = FastAPI(title="TrialGuard ML service", version=settings.service_version, lifespan=lifespan)
    app.state.svc = state
    app.state.settings = settings
    install_error_handlers(app)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = (request.headers.get("x-request-id") or "").strip()[:200] or str(uuid.uuid4())
        request.state.request_id = rid
        start = time.perf_counter()
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > settings.max_body_bytes:
            resp = error_response(request, 413, "payload_too_large", f"Body exceeds {settings.max_body_bytes} bytes")
        else:
            resp = await call_next(request)
        resp.headers["x-request-id"] = rid
        log.info("request", extra={"event": "request", "requestId": rid, "method": request.method, "path": request.url.path,
                                   "status": resp.status_code, "durationMs": round((time.perf_counter() - start) * 1000, 1)})
        return resp

    def require_auth(request: Request) -> None:
        if settings.api_key:
            given = request.headers.get("authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {settings.api_key}".encode()):
                raise ApiError(401, "unauthorized", "Missing or invalid bearer token")

    async def run_bounded(fn: Callable[[], Any]) -> Any:
        """Run blocking inference off the event loop with a deadline. Timed-out work finishes in the background
        (a thread cannot be killed), but its result is discarded."""
        try:
            return await asyncio.wait_for(run_in_threadpool(fn), timeout=settings.request_timeout_s)
        except asyncio.TimeoutError:
            raise ApiError(504, "timeout", f"Inference exceeded {settings.request_timeout_s:g}s")

    def check_contract(version: str) -> None:
        if version.split(".")[0] != CONTRACT_VERSION.split(".")[0]:
            raise ApiError(400, "unsupported_contract_version", f"contractVersion '{version}' unsupported; expected {CONTRACT_VERSION}")

    def need_predictor() -> RetentionPredictor:
        if state.predictor is None:
            raise ApiError(503, "model_unavailable", "Retention model is not loaded", {"reason": state.retention_error})
        return state.predictor

    def need_engine() -> IntegrityEngine:
        if state.engine is None:
            raise ApiError(503, "engine_unavailable", "Integrity engine is not available", {"reason": state.engine_error})
        return state.engine

    def predict_locked(features: Any):
        pred = need_predictor()
        with state.predict_lock:
            return pred.predict(features)

    # ---------------------------------------------------------------- ops
    @app.get("/health")
    def health() -> Dict[str, Any]:
        return {"status": "ok", "service": settings.service_name, "version": settings.service_version}

    @app.get("/ready")
    def ready():
        md = settings.model_dir
        files = {n: (md / n).is_file() for n in (PIPELINE_FILE, METADATA_FILE, BACKGROUND_FILE)}
        comp = {
            "retention_model": {"loaded": state.predictor is not None, "modelVersion": getattr(state.predictor, "model_version", None),
                                "error": state.retention_error,
                                "knownSiteCategories": sorted(state.predictor.known_sites) if state.predictor is not None else []},
            "integrity_engine": {"available": state.engine is not None, "error": state.engine_error,
                                 "ecg_dir_exists": bool(state.engine and settings.ecg_dir.is_dir())},
            "artifacts": {"directory": str(md), "files": files, "all_present": all(files.values())},
        }
        ok = comp["retention_model"]["loaded"] and comp["integrity_engine"]["available"] and comp["artifacts"]["all_present"]
        return JSONResponse({"status": "ready" if ok else "not_ready", "ready": ok, "contractVersion": CONTRACT_VERSION,
                             "components": comp}, status_code=200 if ok else 503)

    # ---------------------------------------------------------------- contract endpoints
    @app.post("/v1/risk/predict", response_model=RiskResponse, response_model_exclude_none=True, dependencies=[Depends(require_auth)])
    async def risk_predict(req: RiskRequest) -> RiskResponse:
        check_contract(req.contractVersion)
        if req.entityType != "patient":
            raise ApiError(422, "unsupported_entity_type", "The risk model scores participants (entityType 'patient') only",
                           {"entityType": req.entityType})
        missing = risk_adapter.missing_required(req.features)       # includes scheduled_visits: no silent default (D12)
        if missing:
            raise ApiError(422, "unsupported_feature_schema",
                           "Request lacks the participant features the retention model needs; refusing to score on defaults",
                           {"missingFeatures": missing, "featureSchemaVersion": req.featureSchemaVersion})
        known = sorted(need_predictor().known_sites)
        if req.features.get("site_id") not in set(known):
            # Never score without a site effect on the contract route (D1); the native route keeps its tolerant behaviour.
            raise ApiError(422, "unknown_site_category", "site_id is not one of the model's known site categories; refusing to score without a site effect",
                           {"siteId": req.features.get("site_id") if isinstance(req.features.get("site_id"), str) else None,
                            "knownSiteCategories": known})
        try:
            pred = await run_bounded(lambda: predict_locked(risk_adapter.to_retention_input(req.features, req.entityId)))
        except Exception as exc:
            if isinstance(exc, InvalidInputError):
                raise ApiError(422, "invalid_features", str(exc))
            raise
        pm = state.predictor.metadata  # type: ignore[union-attr]
        return RiskResponse(
            contractVersion=CONTRACT_VERSION, requestId=req.requestId, modelName=pm["model_name"], modelVersion=pred.model_version,
            score=pred.risk_score, factors=risk_adapter.factors_for_contract(pred), explanation=risk_adapter.explanation_text(pred),
            retentionRiskLevel=pred.risk_level, recommendedActions=[a.model_dump() for a in pred.recommended_actions])

    @app.post("/v1/integrity/predict", response_model=IntegrityResponse, response_model_exclude_none=True, dependencies=[Depends(require_auth)])
    async def integrity_predict(req: IntegrityRequest) -> IntegrityResponse:
        check_contract(req.contractVersion)
        eng = need_engine()
        # `trialData` is handed over as the validated model (not re-dumped); the audit part keeps its v1.0 dict form.
        res = await run_bounded(lambda: eng.scan_request(req.model_dump(exclude={"trialData"}), req.trialData))
        return IntegrityResponse(contractVersion=CONTRACT_VERSION, requestId=req.requestId, modelName=eng.name,
                                 modelVersion=eng.version, findings=[f.to_contract() for f in res["findings"]])

    # ---------------------------------------------------------------- non-contract endpoints (trial data)
    @app.post("/v1/retention/predict", dependencies=[Depends(require_auth)])
    async def retention_predict(request: Request, body: ParticipantFeatures) -> Dict[str, Any]:
        pred = await run_bounded(lambda: predict_locked(body))
        return {"requestId": request.state.request_id, **pred.to_dict()}

    @app.post("/v1/integrity/trial-scan", dependencies=[Depends(require_auth)])
    async def trial_scan(request: Request, body: TrialScanRequest) -> Dict[str, Any]:
        eng = need_engine()
        visits = [v.model_dump() for v in body.visits]
        parts = [p.model_dump() for p in body.participants] if body.participants else None
        ecgs = [e.model_dump() for e in body.ecgs] if body.ecgs else None
        res = await run_bounded(lambda: eng.scan_trial(visits, parts, ecgs))
        return {"requestId": body.requestId or request.state.request_id, "engine": {"name": eng.name, "version": eng.version},
                "summary": res["summary"], "siteStatistics": res["siteStatistics"], "anomaly": res["anomaly"], "ecg": res["ecg"],
                "findings": [f.to_native() for f in res["findings"]]}

    return app
