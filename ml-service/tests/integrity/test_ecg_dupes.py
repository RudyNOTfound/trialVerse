from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.integrity.config import EcgConfig
from app.integrity.ecg_dupes import PhashCache, detect_ecg_duplicates


def _img(path, seed, tweak=0):
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, (96, 96)).astype("uint8")
    base = np.kron(base[::8, ::8], np.ones((8, 8), dtype="uint8"))        # blocky => stable pHash
    if tweak:
        base[:2, :2] = 255 - base[:2, :2]                                 # tiny local change
    Image.fromarray(base).save(path)


@pytest.fixture()
def files(tmp_path):
    _img(tmp_path / "a.png", 1)
    (tmp_path / "a_copy.png").write_bytes((tmp_path / "a.png").read_bytes())
    _img(tmp_path / "a_near.png", 1, tweak=1)
    _img(tmp_path / "b.png", 2)
    _img(tmp_path / "c.png", 3)
    (tmp_path / "corrupt.png").write_bytes(b"not an image")
    return tmp_path


def rec(i, f, pid=None):
    return {"ecg_id": f"e{i}", "visit_id": f"v{i}", "participant_id": pid or f"p{i}", "site_id": "S", "image_file": f}


def run(files, recs, **cfg):
    return detect_ecg_duplicates(recs, files, EcgConfig(**cfg), PhashCache(32))


def test_identical_images_across_participants_are_high(files):
    f, st = run(files, [rec(1, "a.png"), rec(2, "a_copy.png"), rec(3, "b.png")])
    dup = [x for x in f if x.rule_id == "ecg.duplicate_image"]
    assert len(dup) == 1 and dup[0].severity == "high"
    d = dup[0].details
    assert sorted(d["visitIds"]) == ["v1", "v2"] and d["participantIds"] == ["p1", "p2"] and d["maxHammingDistance"] == 0
    assert d["pairs"] == [{"a": "e1", "b": "e2", "distance": 0}] and st["duplicate_clusters"] == 1


def test_distinct_images_are_not_flagged(files):
    f, _ = run(files, [rec(1, "a.png"), rec(2, "b.png"), rec(3, "c.png")])
    assert f == []


def test_near_duplicate_respects_threshold(files):
    near = run(files, [rec(1, "a.png"), rec(2, "a_near.png")], near_max_distance=8)[0]
    assert len(near) == 1 and near[0].details["maxHammingDistance"] >= 0
    strict = run(files, [rec(1, "a.png"), rec(2, "a_near.png")], near_max_distance=0, identical_max_distance=0)[0]
    assert len(strict) == (0 if near[0].details["maxHammingDistance"] > 0 else 1)


def test_same_participant_reuse_is_lower_severity(files):
    f, _ = run(files, [rec(1, "a.png", "same"), rec(2, "a_copy.png", "same")])
    assert f[0].severity == "medium"


def test_missing_corrupt_and_escaping_paths_become_findings_not_crashes(files):
    f, st = run(files, [rec(1, "a.png"), rec(2, "nope.png"), rec(3, "corrupt.png"), rec(4, "../../etc/passwd"), rec(5, None)])
    bad = [x for x in f if x.rule_id == "ecg.file_unavailable"]
    assert len(bad) == 4 and all(x.category == "data_quality" for x in bad)
    assert st["ecgs_unreadable"] == 4 and st["ecgs_checked"] == 1
    assert any("not found" in x.details["problem"] for x in bad) and any("escapes" in x.details["problem"] for x in bad)


def test_cache_avoids_reloading(files):
    cache = PhashCache(8)
    recs = [rec(1, "a.png"), rec(2, "b.png")]
    detect_ecg_duplicates(recs, files, EcgConfig(), cache)
    detect_ecg_duplicates(recs, files, EcgConfig(), cache)
    assert cache.misses == 2 and cache.hits == 2
