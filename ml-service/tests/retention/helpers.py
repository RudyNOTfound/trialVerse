"""Shared constants and builders for the retention tests (imported as `helpers`)."""
from __future__ import annotations

import numpy as np
import pandas as pd

NORMAL = dict(participant_id="N-1", site_id="SITE-A", age=45, distance_km=5.0, daily_wage_worker=0, scheduled_visits=8,
              missed_reminders=0, reimbursement_delay_days=3, side_effects_reported=0, phone_changed=0, visits_missed=0)
ELEVATED = dict(participant_id="E-1", site_id="SITE-A", age=52, distance_km=60.0, daily_wage_worker=1, scheduled_visits=8,
                missed_reminders=4, reimbursement_delay_days=20, side_effects_reported=1, phone_changed=1, visits_missed=3)


def toy_frame(n: int = 200, seed: int = 0) -> pd.DataFrame:
    """Tiny valid training frame with both classes (for unit tests that need no real model)."""
    r = np.random.default_rng(seed)
    df = pd.DataFrame({
        "participant_id": [f"T-{i:05d}" for i in range(n)], "site_id": r.choice(["SITE-A", "SITE-B", "SITE-C"], n),
        "age": r.integers(30, 70, n).astype(float), "distance_km": r.uniform(1, 80, n).round(1),
        "daily_wage_worker": r.integers(0, 2, n), "scheduled_visits": 8, "missed_reminders": r.integers(0, 4, n),
        "reimbursement_delay_days": r.integers(0, 20, n).astype(float), "side_effects_reported": r.integers(0, 2, n),
        "phone_changed": r.integers(0, 2, n), "visits_missed": r.integers(0, 4, n)})
    z = -2 + 0.04 * df["distance_km"] + 0.4 * df["missed_reminders"] + 0.5 * df["phone_changed"]
    df["dropped_out"] = (r.random(n) < 1 / (1 + np.exp(-z))).astype(int)
    return df
