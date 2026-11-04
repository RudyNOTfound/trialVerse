"""Shared helpers: seeded RNG streams, math, timestamp formatting, deterministic file output."""
from __future__ import annotations

import hashlib
import zlib
from datetime import datetime
from pathlib import Path
from typing import Union

import numpy as np
import pandas as pd

IST_SUFFIX = "+05:30"


def make_rng(seed: int, stream: str) -> np.random.Generator:
    """Independent, reproducible generator per named stream (no global random state)."""
    return np.random.default_rng([seed, zlib.crc32(stream.encode("utf-8"))])


def sigmoid(z: Union[np.ndarray, float]) -> Union[np.ndarray, float]:
    """Numerically stable logistic function."""
    return 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))


def iso_ist(ts: datetime) -> str:
    """Format a naive local (IST) datetime as ISO-8601 with an explicit +05:30 offset."""
    return ts.strftime("%Y-%m-%dT%H:%M:%S") + IST_SUFFIX


def parse_ist(value: str) -> datetime:
    """Inverse of `iso_ist`."""
    return datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")


def write_csv(df: pd.DataFrame, path: Path) -> None:
    """Write a CSV with stable formatting so identical data gives byte-identical files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, lineterminator="\n", float_format="%.6g")


def sha256_file(path: Path) -> str:
    """Hex SHA-256 of a file's bytes."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()
