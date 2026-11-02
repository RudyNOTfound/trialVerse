"""Consistent JSON errors: {"error": {"code", "message", "requestId", "details"?}}. Never HTTP 200 for a failure."""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("trialguard.api")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def error_response(request: Request, status: int, code: str, message: str, details: Any = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "requestId": getattr(request.state, "request_id", None)}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(body, status_code=status)


def _validation_details(exc: RequestValidationError) -> Any:
    return [{"field": ".".join(str(p) for p in e["loc"] if p != "body"), "message": e["msg"]} for e in exc.errors()[:20]]


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(request: Request, exc: ApiError) -> JSONResponse:
        return error_response(request, exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(request, 422, "invalid_request", "Request body failed validation", _validation_details(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return error_response(request, exc.status_code, "http_error", str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error", exc_info=exc, extra={"event": "unhandled_error", "requestId": getattr(request.state, "request_id", None),
                                                          "path": request.url.path})
        return error_response(request, 500, "internal_error", "Internal error while processing the request")
