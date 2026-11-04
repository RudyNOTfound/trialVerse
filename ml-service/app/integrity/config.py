"""Every integrity threshold lives here. Documented in ml-service/README.md ("Integrity detection")."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Tuple

from app.config import ML_SERVICE_ROOT


@dataclass(frozen=True)
class VisitRuleConfig:
    late_entry_hours: float = 24.0                  # entry_timestamp - device_timestamp above this = late entry
    visit_window_days: int = 7                      # |device date - scheduled date| above this = outside window
    night_start_hour: int = 23                      # entry hour (local, from the timestamp's own offset) in
    night_end_hour: int = 5                         # [night_start, 24) or [0, night_end) = late-night entry
    plausible_ranges: Dict[str, Tuple[float, float]] = field(default_factory=lambda: {
        "systolic_bp": (70, 250), "diastolic_bp": (40, 150), "heart_rate": (30, 220),
        "weight_kg": (25, 250), "glucose_mg_dl": (30, 600)})
    mandatory_completed_fields: Tuple[str, ...] = (
        "device_timestamp", "entry_timestamp", "otp_verified", "systolic_bp", "diastolic_bp", "heart_rate")
    burst_window_minutes: float = 15.0              # rapid-entry cluster: >= burst_min_entries within this window
    burst_min_entries: int = 5                      # at one site
    min_signals_for_review: int = 2                 # one weak rule is never enough to escalate a visit


@dataclass(frozen=True)
class SiteStatsConfig:
    min_participants: int = 20                      # below these, a site is reported as "insufficient data"
    min_visits: int = 60
    alpha: float = 1e-3                             # one-sided significance level for every comparative test
    retention_min_excess: float = 0.15              # retention must also exceed the other sites' rate by this
    digit_pref_expected: float = 0.20               # share of BP values ending in 0/5 under uniform last digits
    digit_pref_min_excess: float = 0.15
    variance_ratio_max: float = 0.5                 # site variance / other-sites variance must be below this
    otp_min_count: int = 5                          # at least this many unverified completed visits
    night_min_count: int = 3
    late_entry_min_count: int = 3
    min_signals_for_site_review: int = 3            # independent site-level signals needed for severity HIGH


@dataclass(frozen=True)
class EcgConfig:
    hash_size: int = 8                              # pHash bits per side (64-bit hash)
    identical_max_distance: int = 0                 # Hamming distance treated as identical
    near_max_distance: int = 4                      # <= this = near-identical. Phase 3 keeps distinct ECGs >= 8 apart
    max_pairs_reported: int = 50
    min_pixel_std: float = 2.0                      # grey-level std below this = blank/uniform image, not comparable (real ECGs: 35-91)
    cache_size: int = 4096                         # >= the 2,000-ECG request cap, so repeat scans never re-decode unchanged files


@dataclass(frozen=True)
class AnomalyConfig:
    min_rows: int = 100                             # Isolation Forest is not fitted on fewer participant profiles
    n_estimators: int = 200
    contamination: float = 0.02                     # assumed share of anomalous visits (an assumption, not a measurement)
    random_state: int = 42
    site_min_participants: int = 20
    site_enrichment_alpha: float = 1e-3             # Mann-Whitney U: site's anomaly scores vs the other sites'


@dataclass(frozen=True)
class AuditRuleConfig:
    otp_failure_burst: int = 5                      # failed OTP attempts on one visit within the window
    overdue_visits_per_patient: int = 3
    claim_burst_count: int = 4                      # claims by one requester ...
    claim_burst_minutes: float = 10.0               # ... within this many minutes
    actor_min_actors: int = 5                       # robust activity-outlier test needs this many actors
    actor_min_events: int = 100
    actor_robust_z: float = 3.5
    actor_min_share: float = 0.25                   # and the actor must own at least this share of events


@dataclass(frozen=True)
class IntegrityConfig:
    visit: VisitRuleConfig = field(default_factory=VisitRuleConfig)
    site: SiteStatsConfig = field(default_factory=SiteStatsConfig)
    ecg: EcgConfig = field(default_factory=EcgConfig)
    anomaly: AnomalyConfig = field(default_factory=AnomalyConfig)
    audit: AuditRuleConfig = field(default_factory=AuditRuleConfig)
    ecg_root: Path = ML_SERVICE_ROOT / "generated_data"
    max_findings: int = 1000                        # contract limit
    model_name: str = "trialguard-integrity"
    model_version: str = "1.0.0"
