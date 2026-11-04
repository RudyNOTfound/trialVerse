"""The vectorised ECG clustering must equal a naive all-pairs implementation (it replaced a 2M-iteration Python loop)."""
from __future__ import annotations

import itertools

import imagehash
import numpy as np
import pytest
from PIL import Image

from app.integrity.config import EcgConfig
from app.integrity.ecg_dupes import PhashCache, detect_ecg_duplicates


def _img(path, seed, flips=0):
    rng = np.random.default_rng(seed)
    a = np.kron(rng.integers(0, 255, (12, 12)).astype("uint8"), np.ones((8, 8), dtype="uint8"))
    for k in range(flips):
        a[8 * k:8 * k + 8, :8] = 255 - a[8 * k:8 * k + 8, :8]
    Image.fromarray(a).save(path)


def naive(recs, root, cfg):
    hs = [(r, imagehash.phash(Image.open(root / r["image_file"]).convert("L"), hash_size=cfg.hash_size)) for r in recs]
    parent = list(range(len(hs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    pairs = []
    for i, j in itertools.combinations(range(len(hs)), 2):
        d = int(hs[i][1] - hs[j][1])
        if d <= cfg.near_max_distance:
            pairs.append((i, j, d))
            parent[find(i)] = find(j)
    groups = {}
    for i in range(len(hs)):
        groups.setdefault(find(i), []).append(i)
    out = []
    for m in groups.values():
        if len(m) < 2:
            continue
        gp = sorted(((i, j, d) for i, j, d in pairs if i in set(m) and j in set(m)), key=lambda x: (x[2], x[0], x[1]))
        out.append((sorted(recs[i]["ecg_id"] for i in m), max(d for _, _, d in gp),
                    [(recs[i]["ecg_id"], recs[j]["ecg_id"], d) for i, j, d in gp[:cfg.max_pairs_reported]]))
    return out


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_vectorised_clusters_equal_the_naive_version(tmp_path, seed):
    rng = np.random.default_rng(seed)
    recs = []
    for i in range(60):
        base = int(rng.integers(0, 20))                          # many records share a base image => clusters of varied size
        _img(tmp_path / f"{i}.png", base, flips=int(rng.integers(0, 2)) if i % 3 == 0 else 0)
        recs.append({"ecg_id": f"R{i:02d}", "visit_id": f"v{i}", "participant_id": f"p{i % 17}", "site_id": f"S{i % 3}", "image_file": f"{i}.png"})
    cfg = EcgConfig(cache_size=128)
    findings, stats = detect_ecg_duplicates(recs, tmp_path, cfg, PhashCache(128))
    got = [(sorted(f.details["ecgIds"]), f.details["maxHammingDistance"], [(p["a"], p["b"], p["distance"]) for p in f.details["pairs"]])
           for f in findings if f.rule_id == "ecg.duplicate_image"]
    want = naive(recs, tmp_path, cfg)
    assert want, "the fixture must contain duplicate clusters"
    assert sorted(got) == sorted(want)
    assert stats["duplicate_clusters"] == len(want) and stats["ecgs_checked"] == 60


def test_all_identical_worst_case_is_one_cluster_with_bounded_pair_report(tmp_path):
    _img(tmp_path / "a.png", 1)
    recs = [{"ecg_id": f"R{i}", "visit_id": f"v{i}", "participant_id": f"p{i}", "site_id": "S", "image_file": "a.png"} for i in range(300)]
    f, _ = detect_ecg_duplicates(recs, tmp_path, EcgConfig(), PhashCache(8))
    (d,) = f
    assert len(d.details["ecgIds"]) == 300 and len(d.details["pairs"]) == EcgConfig().max_pairs_reported and d.severity == "high"
