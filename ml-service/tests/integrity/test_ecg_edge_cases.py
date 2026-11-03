"""ECG pipeline edge cases: featureless images, unreadable files, exact copies and correct attribution.

An image that cannot be compared must produce the data-quality finding `ecg.file_unavailable` -- never a duplicate/fraud-style
finding. Real tracings (pixel std 35-91 in the Phase 3 data) must still be clustered exactly as before.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.integrity.config import EcgConfig
from app.integrity.ecg_dupes import PhashCache, detect_ecg_duplicates

REPO_ECG_DIR = Path(__file__).resolve().parents[2] / "generated_data" / "ecgs"


def tracing(path: Path, seed: int) -> None:
    rng = np.random.default_rng(seed)
    Image.fromarray(rng.integers(0, 255, (200, 400), dtype=np.uint8)).save(path)


def rec(i, name, pid=None, site="S"):
    return {"ecg_id": f"e{i}", "visit_id": f"v{i}", "participant_id": pid or f"p{i}", "site_id": site, "image_file": name}


def run(root, recs, **cfg):
    return detect_ecg_duplicates(recs, root, EcgConfig(**cfg), PhashCache(32))


def by_rule(findings, rule):
    return [f for f in findings if f.rule_id == rule]


@pytest.fixture()
def blanks(tmp_path):
    Image.new("L", (400, 200), 255).save(tmp_path / "white.png")
    Image.new("L", (400, 200), 0).save(tmp_path / "black.png")
    Image.new("L", (400, 200), 128).save(tmp_path / "gray.png")
    Image.new("RGBA", (400, 200), (255, 255, 255, 0)).save(tmp_path / "transparent.png")
    Image.new("L", (1, 1), 0).save(tmp_path / "pixel.png")
    return tmp_path


# ---- featureless images are not "duplicates" ----------------------------------------------------------------------------
def test_different_blank_images_from_different_participants_are_not_a_duplicate_cluster(blanks):
    names = ["white", "black", "gray", "transparent", "pixel"]
    f, st = run(blanks, [rec(i, f"{n}.png") for i, n in enumerate(names)])
    assert by_rule(f, "ecg.duplicate_image") == []
    un = by_rule(f, "ecg.file_unavailable")
    assert len(un) == len(names) and st["duplicate_clusters"] == 0 and st["ecgs_unreadable"] == len(names)
    for x in un:
        assert x.category == "data_quality" and x.severity == "medium"
        assert "no usable content" in x.details["problem"]


def test_blank_image_does_not_hide_a_real_duplicate_next_to_it(blanks):
    tracing(blanks / "a.png", 1)
    (blanks / "a_copy.png").write_bytes((blanks / "a.png").read_bytes())
    f, _ = run(blanks, [rec(1, "a.png"), rec(2, "a_copy.png"), rec(3, "white.png"), rec(4, "black.png")])
    clusters = by_rule(f, "ecg.duplicate_image")
    assert len(clusters) == 1 and sorted(clusters[0].details["ecgIds"]) == ["e1", "e2"] and clusters[0].severity == "high"
    assert {x.details["problem"] for x in by_rule(f, "ecg.file_unavailable")} == {"image has no usable content (uniform pixels), so it cannot be compared"}


def test_threshold_is_what_separates_blank_from_comparable(blanks):
    """Negative control: with the guard disabled the old (wrong) behaviour returns, proving the test exercises it."""
    f, _ = run(blanks, [rec(1, "white.png"), rec(2, "black.png")], min_pixel_std=0.0)
    assert len(by_rule(f, "ecg.duplicate_image")) == 1


def sparse_trace(path: Path, cycles: float) -> float:
    """A thin dark sine trace on a plain white page -- sparse, like a real strip with no grid. Returns its grey-level std."""
    a = np.full((200, 400), 255, dtype=np.uint8)
    x = np.arange(400)
    y = (100 + 60 * np.sin(2 * np.pi * cycles * x / 400)).astype(int)
    for dy in (-1, 0, 1):
        a[np.clip(y + dy, 0, 199), x] = 20
    Image.fromarray(a).save(path)
    return float(a.std())


def test_sparse_but_real_tracings_are_still_compared(tmp_path):
    assert sparse_trace(tmp_path / "t1.png", 3) > 5 * EcgConfig().min_pixel_std
    (tmp_path / "t1_copy.png").write_bytes((tmp_path / "t1.png").read_bytes())
    sparse_trace(tmp_path / "t2.png", 7)
    f, st = run(tmp_path, [rec(1, "t1.png"), rec(2, "t1_copy.png"), rec(3, "t2.png")])
    assert st["ecgs_unreadable"] == 0
    (c,) = by_rule(f, "ecg.duplicate_image")
    assert sorted(c.details["ecgIds"]) == ["e1", "e2"]              # the different tracing is not pulled into the cluster


# ---- real Phase 3 ECGs are untouched by the guard ------------------------------------------------------------------------
@pytest.mark.skipif(not REPO_ECG_DIR.is_dir(), reason="Phase 3 ECG images not present")
def test_every_committed_ecg_png_is_valid_and_comparable():
    files = sorted(REPO_ECG_DIR.glob("*.png"))
    assert len(files) >= 30
    for p in files:
        with Image.open(p) as im:
            im.verify()
        with Image.open(p) as im:
            assert im.format == "PNG" and im.size[0] > 100 and im.size[1] > 50
            std = float(np.asarray(im.convert("L"), dtype=float).std())
        assert std > 10 * EcgConfig().min_pixel_std, f"{p.name} would be treated as blank (std {std:.1f})"


@pytest.mark.skipif(not REPO_ECG_DIR.is_dir(), reason="Phase 3 ECG images not present")
def test_committed_ecgs_report_no_unavailable_images():
    recs = [rec(i, p.name) for i, p in enumerate(sorted(REPO_ECG_DIR.glob("*.png")))]
    f, st = run(REPO_ECG_DIR, recs)
    assert st["ecgs_unreadable"] == 0 and by_rule(f, "ecg.file_unavailable") == []


# ---- unreadable files: a finding, never a crash, never an accusation -----------------------------------------------------
def test_unavailable_images_are_only_data_quality_findings(tmp_path):
    tracing(tmp_path / "ok.png", 3)
    data = (tmp_path / "ok.png").read_bytes()
    (tmp_path / "truncated.png").write_bytes(data[: len(data) // 2])
    (tmp_path / "empty.png").write_bytes(b"")
    (tmp_path / "text.png").write_text("not an image")
    (tmp_path / "folder.png").mkdir()
    recs = [rec(0, "ok.png"), rec(1, "truncated.png"), rec(2, "empty.png"), rec(3, "text.png"), rec(4, "folder.png"),
            rec(5, "missing.png"), rec(6, "../outside.png"), rec(7, ""), {**rec(8, "x.png"), "image_file": None}]
    f, st = run(tmp_path, recs)
    assert st["ecgs_checked"] == 1 and st["ecgs_unreadable"] == 8
    assert len(by_rule(f, "ecg.file_unavailable")) == 8
    assert by_rule(f, "ecg.duplicate_image") == []
    assert {x.category for x in f} == {"data_quality"} and {x.severity for x in f} == {"medium"}


def test_a_single_unavailable_image_is_never_high_or_suspicious(tmp_path):
    f, _ = run(tmp_path, [rec(1, "missing.png")])
    assert [(x.rule_id, x.severity, x.category) for x in f] == [("ecg.file_unavailable", "medium", "data_quality")]


def test_symlink_pointing_outside_the_ecg_directory_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    tracing(outside / "secret.png", 5)
    root = tmp_path / "root"
    root.mkdir()
    (root / "link.png").symlink_to(outside / "secret.png")
    f, st = run(root, [rec(1, "link.png")])
    assert st["ecgs_checked"] == 0 and "escapes" in by_rule(f, "ecg.file_unavailable")[0].details["problem"]


# ---- exact copies and attribution ---------------------------------------------------------------------------------------
def test_byte_identical_copies_have_distance_zero_and_are_attributed_to_the_right_visits(tmp_path):
    tracing(tmp_path / "orig.png", 7)
    tracing(tmp_path / "other.png", 8)
    for n in ("copy1.png", "copy2.png"):
        (tmp_path / n).write_bytes((tmp_path / "orig.png").read_bytes())
    recs = [rec(1, "orig.png", "pA", "S1"), rec(2, "copy1.png", "pB", "S1"), rec(3, "copy2.png", "pC", "S2"), rec(4, "other.png", "pD", "S1")]
    f, _ = run(tmp_path, recs)
    (c,) = by_rule(f, "ecg.duplicate_image")
    d = c.details
    assert c.severity == "high" and d["maxHammingDistance"] == 0 and d["crossParticipant"] is True
    assert sorted(d["visitIds"]) == ["v1", "v2", "v3"] and sorted(d["participantIds"]) == ["pA", "pB", "pC"]
    assert sorted(d["ecgIds"]) == ["e1", "e2", "e3"] and d["siteIds"] == ["S1", "S2"]
    assert "e4" not in d["ecgIds"] and "pD" not in d["participantIds"]


def test_same_participant_reuse_is_medium_not_high(tmp_path):
    tracing(tmp_path / "a.png", 9)
    (tmp_path / "b.png").write_bytes((tmp_path / "a.png").read_bytes())
    (c,) = by_rule(run(tmp_path, [rec(1, "a.png", "pA"), rec(2, "b.png", "pA")])[0], "ecg.duplicate_image")
    assert c.severity == "medium" and c.details["crossParticipant"] is False


def test_cluster_id_is_stable_across_input_order(tmp_path):
    tracing(tmp_path / "a.png", 11)
    (tmp_path / "b.png").write_bytes((tmp_path / "a.png").read_bytes())
    r = [rec(1, "a.png", "pA"), rec(2, "b.png", "pB")]
    first = by_rule(run(tmp_path, r)[0], "ecg.duplicate_image")[0]
    second = by_rule(run(tmp_path, list(reversed(r)))[0], "ecg.duplicate_image")[0]
    assert first.entity_id == second.entity_id and first.dedupe_key == second.dedupe_key


def test_cache_still_avoids_decoding_unchanged_files(tmp_path):
    tracing(tmp_path / "a.png", 13)
    cache = PhashCache(8)
    for _ in range(2):
        detect_ecg_duplicates([rec(1, "a.png")], tmp_path, EcgConfig(), cache)
    assert cache.misses == 1 and cache.hits == 1
