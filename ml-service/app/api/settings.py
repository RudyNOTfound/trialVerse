"""Service settings, read from the environment (all optional)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.config import ML_SERVICE_ROOT

SERVICE_NAME = "trialguard-ml-service"
SERVICE_VERSION = "0.6.0"
CONTRACT_VERSION = "1.1"            # Phase 6 contract; must share a MAJOR version with src/ml/contracts.ts


@dataclass(frozen=True)
class Settings:
    api_key: Optional[str] = None                      # ML_API_KEY: when set, /v1/* requires "Authorization: Bearer <key>"
    model_dir: Path = ML_SERVICE_ROOT / "models" / "retention"   # ML_MODEL_DIR
    ecg_dir: Path = ML_SERVICE_ROOT / "generated_data"           # ML_ECG_DIR (image_file paths are relative to it)
    max_body_bytes: int = 25 * 1024 * 1024             # ML_MAX_BODY_BYTES (measured: a full 20,000-visit trialData payload is ~8.5 MB; 25 MiB leaves >2.5x headroom)
    request_timeout_s: float = 10.0                    # ML_REQUEST_TIMEOUT_S (keep below the backend's ML_TIMEOUT_MS)
    log_level: str = "INFO"                            # ML_LOG_LEVEL
    service_name: str = SERVICE_NAME
    service_version: str = SERVICE_VERSION

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ
        d = cls()
        return cls(
            api_key=e.get("ML_API_KEY") or None,
            model_dir=Path(e["ML_MODEL_DIR"]) if e.get("ML_MODEL_DIR") else d.model_dir,
            ecg_dir=Path(e["ML_ECG_DIR"]) if e.get("ML_ECG_DIR") else d.ecg_dir,
            max_body_bytes=int(e.get("ML_MAX_BODY_BYTES", d.max_body_bytes)),
            request_timeout_s=float(e.get("ML_REQUEST_TIMEOUT_S", d.request_timeout_s)),
            log_level=e.get("ML_LOG_LEVEL", d.log_level).upper())
