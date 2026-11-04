"""One JSON object per log line. Request bodies and participant data are never logged."""
from __future__ import annotations

import json
import logging
import sys

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"), "level": record.levelname,
               "logger": record.name, "msg": record.getMessage()}
        out.update({k: v for k, v in record.__dict__.items() if k not in _RESERVED})
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger("trialguard")
    root.setLevel(level)
    if not any(getattr(h, "_trialguard", False) for h in root.handlers):
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(JsonFormatter())
        h._trialguard = True  # type: ignore[attr-defined]
        root.addHandler(h)
    root.propagate = False
