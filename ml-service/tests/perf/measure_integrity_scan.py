"""Measure POST /v1/integrity/predict at the documented caps (spec 01 §4: 20,000 visits / 5,000 participants / 2,000 ECGs / 200 sites).

Not part of the pytest suite (slow). One scenario per process so peak RSS is meaningful:

    cd ml-service && python tests/perf/measure_integrity_scan.py --scenario A
    scenarios: A 5 sites, no ECG | B 200 small sites | C = A + 2000 distinct ECGs | D = A + 2000 identical ECGs (worst case) | E 200 sites all eligible for comparison

Prints one JSON line. Synthetic data only.
"""
from __future__ import annotations

import argparse
import json
import resource
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve()
sys.path[:0] = [str(HERE.parents[2]), str(HERE.parents[1] / "integrity"), str(HERE.parents[1] / "service")]

from fastapi.testclient import TestClient  # noqa: E402
from golden_requests import from_internal, integrity_request  # noqa: E402
from integ_helpers import honest_trial  # noqa: E402

from app.api.app import create_app  # noqa: E402
from app.api.settings import Settings  # noqa: E402


def png(path: Path, seed: int) -> None:
    rng = np.random.default_rng(seed)
    Image.fromarray(np.kron(rng.integers(0, 255, (12, 12)).astype("uint8"), np.ones((4, 4), dtype="uint8"))).save(path)


def build(scenario: str, tmp: Path):
    if scenario == "B":
        sites = tuple(f"SITE-{i:03d}" for i in range(200))
        v, p = honest_trial(sites=sites, per_site=12, visits_each=8)          # 200 x 12 x 8 = 19,200 (every site below the comparison minimum)
    elif scenario == "E":
        sites = tuple(f"SITE-{i:03d}" for i in range(200))
        v, p = honest_trial(sites=sites, per_site=22, visits_each=4)          # 200 sites that are ALL eligible for comparative tests
    else:
        v, p = honest_trial(sites=("SITE-A", "SITE-B", "SITE-C", "SITE-D", "SITE-E"), per_site=500, visits_each=8)   # 20,000
    trial = from_internal(v, p)
    if scenario in ("C", "D"):
        done = [x for x in v if x["status"] == "completed"][:2000]
        ecgs = []
        for i, x in enumerate(done):
            name = f"e{i if scenario == 'C' else 0}.png"
            if scenario == "C" or i == 0:
                png(tmp / name, i)
            ecgs.append({"ecgRecordId": f"R{i}", "visitId": x["visit_id"], "participantId": x["participant_id"], "siteId": x["site_id"], "imageRef": name})
        trial["ecgs"] = ecgs
        by = {e["visitId"]: e["ecgRecordId"] for e in ecgs}
        for tv in trial["visits"]:
            tv["ecgRecordId"] = by.get(tv["visitId"])
    return trial


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="A", choices=list("ABCDE"))
    ap.add_argument("--timeout", type=float, default=900.0)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        trial = build(a.scenario, tmp)
        body = json.dumps(integrity_request(trial)).encode()
        out = {"scenario": a.scenario, "visits": len(trial["visits"]), "participants": len(trial["participants"]), "sites": len(trial["sites"]),
               "ecgs": len(trial.get("ecgs") or []), "bodyMB": round(len(body) / 2**20, 2)}
        model_dir = HERE.parents[2] / "models" / "retention"
        settings = Settings(model_dir=model_dir, ecg_dir=tmp, request_timeout_s=a.timeout, max_body_bytes=64 * 2**20)
        with TestClient(create_app(settings)) as c:
            rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            t0 = time.perf_counter()
            r = c.post("/v1/integrity/predict", content=body, headers={"content-type": "application/json"})
            dt = time.perf_counter() - t0
            rss1 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # a second identical call shows warm-cache behaviour (ECG hash cache)
            t1 = time.perf_counter()
            c.post("/v1/integrity/predict", content=body, headers={"content-type": "application/json"})
            dt2 = time.perf_counter() - t1
        div = 2**20 if sys.platform == "darwin" else 2**10                      # macOS reports bytes, Linux KiB
        js = r.json() if r.status_code == 200 else r.json()
        out.update(status=r.status_code, seconds=round(dt, 2), secondsWarm=round(dt2, 2), peakRssMB=round(rss1 / div),
                   rssBeforeRequestMB=round(rss0 / div), findings=len(js.get("findings", [])) if r.status_code == 200 else None,
                   responseKB=round(len(r.content) / 1024, 1))
        print(json.dumps(out))


if __name__ == "__main__":
    main()
