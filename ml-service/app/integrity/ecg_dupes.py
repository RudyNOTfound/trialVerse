"""Perceptual-hash duplicate detection for ECG images. A bad file produces a finding, never a crash."""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import imagehash
import numpy as np
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .config import EcgConfig
from .findings import Finding


class PhashCache:
    """Small LRU keyed by (path, mtime, size) so unchanged files are never decoded twice."""

    def __init__(self, size: int):
        self.size, self._d = size, OrderedDict()  # type: ignore[var-annotated]
        self.hits = self.misses = 0

    def get(self, path: Path, hash_size: int) -> "imagehash.ImageHash":
        st = path.stat()
        key = (str(path), st.st_mtime_ns, st.st_size, hash_size)
        if key in self._d:
            self._d.move_to_end(key)
            self.hits += 1
            return self._d[key]
        self.misses += 1
        with Image.open(path) as im:
            h = imagehash.phash(im.convert("L"), hash_size=hash_size)
        self._d[key] = h
        if len(self._d) > self.size:
            self._d.popitem(last=False)
        return h


def _resolve(root: Path, rel: str) -> Optional[Path]:
    p = (root / rel).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


def detect_ecg_duplicates(ecgs: List[Dict[str, Any]], root: Path, cfg: EcgConfig,
                          cache: PhashCache) -> Tuple[List[Finding], Dict[str, Any]]:
    findings: List[Finding] = []
    hashed: List[Tuple[Dict[str, Any], "imagehash.ImageHash"]] = []
    for e in ecgs:
        eid = str(e.get("ecg_id") or e.get("visit_id") or "unknown")
        rel = e.get("image_file")
        problem = None
        h = None
        if not rel:
            problem = "no image_file given"
        else:
            path = _resolve(root, str(rel))
            if path is None:
                problem = "path escapes the configured ECG directory"
            elif not path.is_file():
                problem = "file not found"
            else:
                try:
                    h = cache.get(path, cfg.hash_size)
                except Exception as exc:  # corrupt / not an image
                    problem = f"file is not a readable image ({type(exc).__name__})"
        if h is None:
            findings.append(Finding(
                "ecg.file_unavailable", "ecg", eid, "medium", "data_quality",
                f"ECG {eid} could not be checked for duplication: {problem}.",
                "Obtain the original ECG file; the duplicate check could not cover this record.",
                {"visitId": e.get("visit_id"), "participantId": e.get("participant_id"), "problem": problem},
                dedupe_key=f"{eid}:{problem}", site_id=e.get("site_id")))
        else:
            hashed.append((e, h))

    n = len(hashed)
    groups: Dict[int, List[int]] = {}
    pair_i = pair_j = pair_d = np.empty(0, dtype=np.int64)
    labels = np.arange(n)
    if n >= 2:
        # All-pairs Hamming distance as two matrix products (exact for 0/1 bits): d = A.(1-B) + (1-A).B
        bits = np.stack([h.hash.flatten() for _, h in hashed]).astype(np.float32)
        inv = 1.0 - bits
        dist = bits @ inv.T + inv @ bits.T
        close = np.triu(dist <= cfg.near_max_distance, 1)
        pair_i, pair_j = np.nonzero(close)
        pair_d = dist[pair_i, pair_j].astype(np.int64)
        if len(pair_i):
            _, labels = connected_components(coo_matrix((np.ones(len(pair_i), dtype=np.int8), (pair_i, pair_j)), shape=(n, n)), directed=False)
    for i in range(n):                                   # groups in order of their lowest member index (as before)
        groups.setdefault(int(labels[i]), []).append(i)

    for members in groups.values():
        if len(members) < 2:
            continue
        in_group = labels[pair_i] == labels[members[0]]
        gi, gj, gd = pair_i[in_group], pair_j[in_group], pair_d[in_group]
        order = np.lexsort((gj, gi, gd))                 # by distance, then member indices: deterministic
        gp = [(int(a), int(b), int(c)) for a, b, c in zip(gi[order][: cfg.max_pairs_reported], gj[order][: cfg.max_pairs_reported], gd[order][: cfg.max_pairs_reported])]
        worst = int(gd.max())
        recs = [hashed[i][0] for i in members]
        cross_participant = len({r.get("participant_id") for r in recs}) > 1
        identical = worst <= cfg.identical_max_distance
        sev = "high" if (identical and cross_participant) else "medium" if (identical or cross_participant) else "low"
        sites = sorted({str(r.get("site_id")) for r in recs})
        sig = hashlib.sha1("|".join(sorted(str(r.get("ecg_id")) for r in recs)).encode()).hexdigest()[:12]
        rec_of = {i: hashed[i][0] for i in members}
        findings.append(Finding(
            "ecg.duplicate_image", "ecg_cluster", f"ecg-cluster-{sig}", sev, "suspicious_pattern",
            f"{len(recs)} ECG images are {'identical' if identical else 'near-identical'} (pHash Hamming distance up to {worst}, "
            f"threshold {cfg.near_max_distance}) across {len({r.get('participant_id') for r in recs})} participant(s). "
            "Independent recordings of different people should not match.",
            "Compare the original device exports and recording metadata for these visits.",
            {"visitIds": [r.get("visit_id") for r in recs], "participantIds": sorted({str(r.get("participant_id")) for r in recs}),
             "ecgIds": [r.get("ecg_id") for r in recs], "siteIds": sites, "maxHammingDistance": worst,
             "hashBits": cfg.hash_size ** 2, "crossParticipant": cross_participant,
             "pairs": [{"a": rec_of[i].get("ecg_id"), "b": rec_of[j].get("ecg_id"), "distance": d} for i, j, d in gp]},
            score=1 - worst / (cfg.hash_size ** 2), dedupe_key=sig, site_id=sites[0] if len(sites) == 1 else None))
    stats = {"ecgs_checked": n, "ecgs_unreadable": len(ecgs) - n, "duplicate_clusters": sum(1 for m in groups.values() if len(m) > 1),
             "cache_hits": cache.hits, "cache_misses": cache.misses}
    return findings, stats
