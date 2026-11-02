"""T16 / X1: Python responses are parsed by the backend's *own* zod schemas (src/ml/contracts.ts, read-only).

Needs Node and the repo's node_modules (tsx). Without them these tests are SKIPPED -- never silently passed.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrity"))

from svc_helpers import CONTRACT_FEATURES, risk_body
from golden_requests import from_internal, integrity_request

REPO = Path(__file__).resolve().parents[3]
TSX = REPO / "node_modules" / ".bin" / "tsx"
SCRIPT = Path(__file__).resolve().parents[1] / "parity" / "zod_check.ts"

pytestmark = pytest.mark.skipif(not (shutil.which("node") and TSX.exists() and (REPO / "src" / "ml" / "contracts.ts").exists()),
                                reason="node/tsx or src/ml/contracts.ts not available: zod parity not checked")


def zod(payload):
    p = subprocess.run([str(TSX), str(SCRIPT)], input=json.dumps(payload), capture_output=True, text=True, cwd=REPO, timeout=120)
    assert p.returncode == 0, p.stderr[-2000:]
    return json.loads(p.stdout)


def test_the_parity_check_can_fail(client):
    """Negative control: a response with `confidence: null` (the classic Python/zod mismatch) is rejected by zod."""
    good = client.post("/v1/risk/predict", json=risk_body()).json()
    res = zod({"risk": [good, dict(good, confidence=None), dict(good, score=101), dict(good, factors=[{"name": "x"}])]})
    assert res["risk"][0] == "ok" and all(r != "ok" for r in res["risk"][1:])


def test_risk_responses_parse_with_the_backend_schema(client):
    bodies = [risk_body(), risk_body(dict(CONTRACT_FEATURES, age=None)), risk_body(dict(CONTRACT_FEATURES, distance_km=400, missed_reminders=9))]
    resp = [client.post("/v1/risk/predict", json=b).json() for b in bodies]
    res = zod({"risk": resp})
    assert res["risk"] == ["ok"] * 3 and all(res["majorsMatch"])
    assert all("confidence" not in r for r in resp)


def test_integrity_responses_parse_with_the_backend_schema(client):
    from integ_helpers import fabricate_site, honest_trial, visit
    v, p = honest_trial()
    v2, p2 = fabricate_site(v, p, "SITE-B")
    v2.append(visit(99999, "SITE-B", "P-SITE-B-000", 7, otp_verified=0, systolic_bp=300, device_timestamp="2026-03-02T11:00:00+05:30",
                    entry_timestamp="2026-03-02T23:50:00+05:30"))
    body = integrity_request(from_internal(v2, p2), chain={"valid": False, "eventsChecked": 3, "errorCount": 1,
                                                            "firstError": {"type": "hash_mismatch", "seq": 2, "message": "bad"}})
    r = client.post("/v1/integrity/predict", json=body)
    assert r.status_code == 200 and len(r.json()["findings"]) >= 3
    empty = dict(body)
    empty.pop("trialData")
    r2 = client.post("/v1/integrity/predict", json=empty)
    res = zod({"integrity": [r.json(), r2.json()]})
    assert res["integrity"] == ["ok", "ok"] and all(res["majorsMatch"])
