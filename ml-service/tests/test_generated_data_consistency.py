"""Consistency of the committed Phase 3 demo data (synthetic): ECG files, hashes and metadata references all agree."""
from __future__ import annotations

import hashlib
from pathlib import Path

import pandas as pd
import pytest
from PIL import Image

DATA = Path(__file__).resolve().parents[1] / "generated_data"
pytestmark = pytest.mark.skipif(not (DATA / "demo" / "ecg_metadata.csv").is_file(), reason="Phase 3 demo data not present")


@pytest.fixture(scope="module")
def meta():
    return pd.read_csv(DATA / "demo" / "ecg_metadata.csv")


@pytest.fixture(scope="module")
def visits():
    return pd.read_csv(DATA / "demo" / "visits.csv")


def test_every_metadata_row_points_at_an_existing_readable_png(meta):
    assert len(meta) == 48
    for rel in meta.image_file.unique():
        p = DATA / rel
        assert p.is_file(), rel
        with Image.open(p) as im:
            im.verify()
        with Image.open(p) as im:
            assert im.format == "PNG"


def test_recorded_sha256_equals_the_sha256_of_the_file(meta):
    for r in meta.itertuples():
        assert hashlib.sha256((DATA / r.image_file).read_bytes()).hexdigest() == r.image_sha256, r.image_file


def test_same_file_means_same_hash_and_different_file_means_different_hash(meta):
    g = meta.groupby("image_file").image_sha256.nunique()
    assert (g == 1).all()
    assert meta.groupby("image_sha256").image_file.nunique().eq(1).all()
    assert meta.image_file.nunique() == 30


def test_no_orphan_image_files(meta):
    on_disk = {f"ecgs/{p.name}" for p in (DATA / "ecgs").glob("*.png")}
    assert on_disk == set(meta.image_file)


def test_ids_are_unique_and_each_visit_has_at_most_one_ecg(meta):
    assert meta.ecg_record_id.is_unique and meta.visit_id.is_unique


def test_ecg_rows_agree_with_the_visit_they_belong_to(meta, visits):
    v = visits.set_index("visit_id")
    assert set(meta.visit_id) <= set(v.index)
    for r in meta.itertuples():
        assert v.loc[r.visit_id, "participant_id"] == r.participant_id
        assert v.loc[r.visit_id, "site_id"] == r.site_id


def test_reused_images_are_only_at_site_c_and_cross_participants(meta):
    shared = meta.groupby("image_file").filter(lambda g: len(g) > 1)
    assert not shared.empty and set(shared.site_id) == {"SITE-C"}
    for _, g in shared.groupby("image_file"):
        assert g.participant_id.nunique() == len(g)                 # every reuse is a different participant
