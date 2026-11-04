import dataclasses

import pytest
from PIL import Image

from app.config import default_config
from app.data_generation import ecg, validation
from app.data_generation.generate_all import run_pipeline
from app.data_generation.utils import sha256_file


def test_about_thirty_distinct_images_that_open(ds):
    files = sorted(ds.ecg_dir.glob("ecg_*.png"))
    assert len(files) == 30
    for f in files:
        with Image.open(f) as im:
            im.verify()
        with Image.open(f) as im:
            assert im.format == "PNG" and im.size == (1000, 300)
    assert len({sha256_file(f) for f in files}) == 30


def test_site_c_reuses_identical_images_across_participants(ds):
    e = ds.ecg_metadata
    c = e[e["site_id"] == "SITE-C"]
    per_image = c.groupby("ecg_id")["participant_id"].nunique()
    assert (per_image >= 4).all() and len(per_image) == 6
    for ecg_id, g in c.groupby("ecg_id"):
        assert g["image_sha256"].nunique() == 1  # literally the same bytes
        assert g["image_file"].nunique() == 1
    assert len(e) - e["ecg_id"].nunique() == 18  # reused references


def test_honest_sites_have_distinct_images(ds):
    e = ds.ecg_metadata
    h = e[e["site_id"] != "SITE-C"]
    assert h["ecg_id"].is_unique and h["image_sha256"].is_unique
    assert set(h["ecg_id"]).isdisjoint(set(e[e["site_id"] == "SITE-C"]["ecg_id"]))


def test_perceptual_hashes_separate_distinct_images_and_match_duplicates(ds):
    imagehash = pytest.importorskip("imagehash")
    import itertools
    e = ds.ecg_metadata
    hashes = {i: imagehash.phash(Image.open(ds.ecg_dir / f"{i}.png")) for i in e["ecg_id"].unique()}
    # Two different participants citing the same image are the same file, hence pHash distance 0.
    for ecg_id, g in e.groupby("ecg_id"):
        assert len({f for f in g["image_file"]}) == 1
    assert min(hashes[a] - hashes[b] for a, b in itertools.combinations(sorted(hashes), 2)) >= ecg.MIN_PHASH_DISTANCE


def test_metadata_links_visits_sites_and_files(ds):
    e = ds.ecg_metadata
    assert (e["sampling_rate_hz"] == 500).all() and (e["duration_s"] == 10).all()
    v = ds.visits.set_index("visit_id")
    assert (v.loc[e["visit_id"], "ecg_id"].values == e["ecg_id"].values).all()
    assert all((ds.ecg_dir / f.split("/")[-1]).exists() for f in e["image_file"])


def test_ecg_disabled_pipeline_still_runs(tmp_path):
    cfg = dataclasses.replace(default_config(tmp_path), generate_ecg=False)
    summary = run_pipeline(cfg, check_reproducibility=False)
    d = validation.load_dataset(tmp_path)
    assert summary["ecg"]["status"].startswith("skipped") and summary["ecg"]["images"] == 0
    assert d.ecg_metadata.empty and d.visits["ecg_id"].isna().all()
    assert not list((tmp_path / "ecgs").glob("*.png"))
    assert any(c["skipped"] for c in summary["validation"])


def test_ecg_failure_is_handled_gracefully(tmp_path, monkeypatch):
    import neurokit2

    def boom(*a, **k):
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(neurokit2, "ecg_simulate", boom)
    with pytest.raises(ecg.ECGGenerationError):
        ecg.generate_ecg_images(default_config(tmp_path), tmp_path / "ecgs")
    summary = run_pipeline(default_config(tmp_path), check_reproducibility=False)
    assert summary["ecg"]["references"] == 0 and summary["ecg"]["status"].startswith("skipped")
