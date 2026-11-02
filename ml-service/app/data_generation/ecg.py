"""Simulated ECG images (NeuroKit2 + Matplotlib) and their assignment to visits.

Image generation is optional: if it is disabled or fails, `generate_ecg_images` raises
`ECGGenerationError` and the caller continues without any ECG references.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Tuple

import numpy as np
import pandas as pd

from app.config import TrialConfig
from app.data_generation.utils import make_rng, sha256_file

ECG_METADATA_COLUMNS = [
    "ecg_record_id", "ecg_id", "image_file", "image_sha256", "participant_id", "visit_id", "site_id",
    "recorded_at", "sampling_rate_hz", "duration_s", "simulated_heart_rate_bpm",
]


class ECGGenerationError(RuntimeError):
    """Raised when ECG images cannot be produced (disabled, missing dependency, or runtime failure)."""


def ecg_image_ids(cfg: TrialConfig) -> List[str]:
    """Stable ids ecg_001..ecg_NNN. Honest-site images come first; reused fraud-site images last."""
    return [f"ecg_{i + 1:03d}" for i in range(cfg.n_ecg_images)]


def ecg_heart_rates(cfg: TrialConfig) -> List[int]:
    """Simulated heart rate (bpm) of every image, in `ecg_image_ids` order."""
    rng = make_rng(cfg.seed, "ecg_params")
    return [int(h) for h in rng.integers(48, 121, cfg.n_ecg_images)]


MIN_PHASH_DISTANCE = 8  # distinct ECGs must differ by at least this many pHash bits (when imagehash is installed)


def _random_style(rng: np.random.Generator) -> dict:
    return {"gain": float(rng.uniform(0.5, 2.2)), "ylo": float(rng.uniform(-2.2, -0.4)),
            "yhi": float(rng.uniform(1.0, 3.2)), "lw": float(rng.uniform(0.8, 3.0)),
            "noise": float(rng.uniform(0.02, 0.12))}


def generate_ecg_images(cfg: TrialConfig, out_dir: Path) -> List[Path]:
    """Render one PNG per ECG id with `neurokit2.ecg_simulate`; return the written paths.

    Each recording gets its own heart rate, amplitude, framing and stroke so that perceptual hashes of
    distinct ECGs stay apart (re-styling deterministically until the pHash distance to every earlier
    image is >= MIN_PHASH_DISTANCE, when `imagehash` is available).
    """
    if not cfg.generate_ecg:
        raise ECGGenerationError("ECG generation disabled by configuration")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import neurokit2 as nk
    except Exception as exc:  # missing or broken dependency
        raise ECGGenerationError(f"ECG dependencies unavailable: {exc}") from exc
    try:
        import imagehash
        from PIL import Image
    except Exception:
        imagehash = None
    out_dir.mkdir(parents=True, exist_ok=True)

    def render(i: int, ecg_id: str, bpm: int, st: dict) -> Path:
        signal = st["gain"] * nk.ecg_simulate(duration=cfg.ecg_duration_s, sampling_rate=cfg.ecg_sampling_rate_hz,
                                              noise=st["noise"], heart_rate=bpm, random_state=cfg.seed * 1000 + i)
        t = np.arange(len(signal)) / cfg.ecg_sampling_rate_hz
        fig, ax = plt.subplots(figsize=(10, 3), dpi=100)
        try:
            ax.plot(t, signal, color="black", linewidth=st["lw"])
            ax.set_xlim(0, cfg.ecg_duration_s)
            ax.set_ylim(st["ylo"], st["yhi"])
            ax.set_xlabel("Time (s)")
            ax.set_ylabel("Amplitude (mV, simulated)")
            ax.set_title(f"Simulated ECG {ecg_id} ({cfg.ecg_sampling_rate_hz} Hz, {cfg.ecg_duration_s} s)")
            ax.grid(True, color="#f4b6b6", linewidth=0.5)
            path = out_dir / f"{ecg_id}.png"
            fig.savefig(path, format="png", metadata={"Software": None})  # no version/time metadata
        finally:
            plt.close(fig)
        return path

    paths: List[Path] = []
    hashes: list = []
    try:
        for i, (ecg_id, bpm) in enumerate(zip(ecg_image_ids(cfg), ecg_heart_rates(cfg))):
            for attempt in range(25):
                st = _random_style(make_rng(cfg.seed, f"ecg_style_{i}_{attempt}"))
                path = render(i, ecg_id, bpm, st)
                if imagehash is None:
                    break
                with Image.open(path) as im:
                    h = imagehash.phash(im)
                if all(h - other >= MIN_PHASH_DISTANCE for other in hashes):
                    hashes.append(h)
                    break
            else:
                hashes.append(h)  # best effort after 25 tries; still the last render
            paths.append(path)
    except Exception as exc:
        raise ECGGenerationError(f"ECG rendering failed: {exc}") from exc
    return paths


def assign_ecg_references(cfg: TrialConfig, visits: pd.DataFrame, ecg_dir: Path
                          ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Attach ECG ids to a sample of completed visits (an "ECG sub-study").

    Honest sites: `ecg_per_honest_site` distinct participants, each with a unique image.
    Fraud site: `reused_ecg_images` images, each reused by `participants_per_reused_ecg` different participants.
    Returns (visits with ecg columns, ecg_metadata, ground_truth rows for reused images).
    """
    rng = make_rng(cfg.seed, "ecg_assign")
    ids = ecg_image_ids(cfg)
    bpms = dict(zip(ids, ecg_heart_rates(cfg)))
    visits = visits.copy()
    visits["ecg_id"] = pd.Series([pd.NA] * len(visits), dtype="string")
    visits["ecg_file"] = pd.Series([pd.NA] * len(visits), dtype="string")
    done = visits[visits["status"] == "completed"]
    refs: List[Tuple[str, str]] = []  # (visit_id, ecg_id)
    next_img = 0

    def pick_visits(site_id: str, n_participants: int) -> List[str]:
        site = done[done["site_id"] == site_id]
        people = rng.choice(np.sort(site["participant_id"].unique()), size=n_participants, replace=False)
        return [rng.choice(site[site["participant_id"] == p]["visit_id"].to_numpy()) for p in people]

    for site_id in cfg.honest_site_ids:
        for vid in pick_visits(site_id, cfg.ecg_per_honest_site):
            refs.append((vid, ids[next_img]))
            next_img += 1
    truth = []
    if cfg.fraud.enabled:
        f = cfg.fraud
        picks = pick_visits(f.site_id, f.reused_ecg_images * f.participants_per_reused_ecg)
        for j, vid in enumerate(picks):
            ecg_id = ids[next_img + j // f.participants_per_reused_ecg]
            refs.append((vid, ecg_id))
            truth.append({"visit_id": vid, "site_id": f.site_id, "anomaly_type": "reused_ecg_image", "detail": ecg_id})

    index = visits.set_index("visit_id")
    rows = []
    for n, (vid, ecg_id) in enumerate(refs, start=1):
        rel = f"ecgs/{ecg_id}.png"
        visits.loc[visits["visit_id"] == vid, ["ecg_id", "ecg_file"]] = [ecg_id, rel]
        r = index.loc[vid]
        image = ecg_dir / f"{ecg_id}.png"
        rows.append({
            "ecg_record_id": f"ECGR-{n:04d}", "ecg_id": ecg_id, "image_file": rel,
            "image_sha256": sha256_file(image) if image.exists() else "",
            "participant_id": r["participant_id"], "visit_id": vid, "site_id": r["site_id"],
            "recorded_at": r["device_timestamp"], "sampling_rate_hz": cfg.ecg_sampling_rate_hz,
            "duration_s": cfg.ecg_duration_s, "simulated_heart_rate_bpm": bpms[ecg_id],
        })
    meta = pd.DataFrame(rows, columns=ECG_METADATA_COLUMNS)
    truth_df = pd.DataFrame(truth, columns=["visit_id", "site_id", "anomaly_type", "detail"])
    return visits, meta, truth_df
