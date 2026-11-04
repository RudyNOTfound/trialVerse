"""Central configuration for the GLU-301 synthetic data generator.

Every tunable value (trial design, site profiles, dropout coefficients, fraud injection) lives here
so scenarios can be changed without editing the generation scripts.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional, Tuple

ML_SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ML_SERVICE_ROOT / "generated_data"


@dataclass(frozen=True)
class SiteProfile:
    """Participant mix and measurement behaviour of one site."""

    site_id: str
    name: str
    city: str
    state: str
    age_mean: float = 54.0
    age_sd: float = 10.0
    distance_median_km: float = 18.0
    daily_wage_rate: float = 0.30
    dropout_offset: float = 0.0  # added to the dropout logit
    visit_jitter_sd_days: float = 1.5
    # Systolic / diastolic BP: person-level baseline sd (between) + visit-to-visit sd (within).
    sbp_mean: float = 132.0
    sbp_between_sd: float = 11.0
    sbp_within_sd: float = 8.0
    dbp_mean: float = 82.0
    dbp_between_sd: float = 7.0
    dbp_within_sd: float = 5.0
    hr_mean: float = 76.0
    hr_sd: float = 10.0


@dataclass(frozen=True)
class DropoutCoefficients:
    """Logistic dropout model: P = sigmoid(intercept + sum(beta * scaled feature)).

    Scaling constants are fixed (not fitted) so the label process is transparent:
    distance_scaled = (km - 25) / 20; reimbursement_scaled = (days - 6) / 5.
    Missing numeric inputs are replaced by their reference value (i.e. scaled 0) in the logit.
    """

    intercept: float = -2.80
    distance: float = 0.70
    daily_wage: float = 0.50
    missed_reminders: float = 0.45
    reimbursement_delay: float = 0.60
    side_effects: float = 0.50
    phone_changed: float = 0.80
    visits_missed: float = 0.55
    distance_center_km: float = 25.0
    distance_scale_km: float = 20.0
    reimbursement_center_days: float = 6.0
    reimbursement_scale_days: float = 5.0


@dataclass(frozen=True)
class FraudConfig:
    """Fraud patterns injected at one site. Every pattern is explicit and tunable."""

    enabled: bool = True
    site_id: str = "SITE-C"
    retention_target: float = 1.0           # no dropouts / missed visits at the fraud site
    bp_round_to_5_rate: float = 0.85         # share of BP readings snapped to a multiple of 5
    sbp_between_sd: float = 2.5              # abnormally low variance
    sbp_within_sd: float = 2.0
    dbp_between_sd: float = 2.0
    dbp_within_sd: float = 1.5
    unverified_visits: int = 18              # completed visits with no OTP verification (>= 9 required)
    batch_count: int = 3                     # unverified visits are entered in this many bursts
    batch_gap_minutes: Tuple[int, int] = (1, 3)   # minutes between entries inside a burst
    batch_start_window_minutes: Tuple[int, int] = (30, 120)  # burst start, minutes after midnight
    late_night_hours: Tuple[int, int] = (23, 4)   # [start, end) local hours considered "late night"
    reused_ecg_images: int = 6               # distinct images that get reused
    participants_per_reused_ecg: int = 4     # different participants sharing each reused image


@dataclass(frozen=True)
class RameshConfig:
    """The demo's high-risk participant (placed at the Roorkee site)."""

    name: str = "Ramesh Verma"
    site_id: str = "SITE-A"
    age: int = 52
    sex: str = "male"
    distance_km: float = 40.0
    missed_reminders: int = 2
    reimbursement_delay_days: int = 12
    daily_wage_worker: int = 1
    side_effects_reported: int = 1  # reported nausea at an earlier visit
    phone_changed: int = 0
    missed_visit_numbers: Tuple[int, ...] = (4,)


def _default_sites() -> Tuple[SiteProfile, ...]:
    return (
        SiteProfile("SITE-A", "Roorkee Diabetes Research Centre", "Roorkee", "Uttarakhand"),
        SiteProfile("SITE-B", "Deccan Metabolic Institute", "Pune", "Maharashtra",
                    dropout_offset=0.10, visit_jitter_sd_days=2.5, sbp_mean=134.0, sbp_between_sd=12.0,
                    sbp_within_sd=9.0, hr_sd=11.0),
        SiteProfile("SITE-C", "Vidarbha Clinical Research Unit", "Nagpur", "Maharashtra",
                    age_mean=55.0, distance_median_km=24.0, daily_wage_rate=0.35),
        SiteProfile("SITE-D", "Malabar Endocrine Centre", "Kochi", "Kerala",
                    age_mean=60.0, age_sd=8.0, distance_median_km=26.0, daily_wage_rate=0.42,
                    dropout_offset=0.20, sbp_mean=129.0, dbp_mean=80.0, hr_mean=73.0),
        SiteProfile("SITE-E", "Gomti Diabetes Institute", "Lucknow", "Uttar Pradesh",
                    dropout_offset=-0.10, visit_jitter_sd_days=2.0, sbp_mean=131.0, sbp_between_sd=10.0,
                    sbp_within_sd=7.5, hr_mean=78.0),
    )


@dataclass(frozen=True)
class TrialConfig:
    """Top-level configuration. Override fields via `dataclasses.replace(cfg, ...)`."""

    trial_id: str = "GLU-301"
    condition: str = "Type 2 diabetes"
    seed: int = 42
    n_training_participants: int = 2000
    n_demo_participants: int = 300
    scheduled_visits: int = 8
    visit_interval_days: int = 28
    reimbursement_per_visit_inr: int = 350
    enrollment_start: date = date(2026, 1, 5)
    enrollment_span_days: int = 56
    as_of_date: date = date(2026, 11, 1)     # snapshot date; every scheduled visit is before it
    sites: Tuple[SiteProfile, ...] = field(default_factory=_default_sites)
    dropout: DropoutCoefficients = field(default_factory=DropoutCoefficients)
    fraud: FraudConfig = field(default_factory=FraudConfig)
    ramesh: RameshConfig = field(default_factory=RameshConfig)
    honest_otp_unverified_rate: float = 0.008
    # ECG
    generate_ecg: bool = True
    ecg_sampling_rate_hz: int = 500
    ecg_duration_s: int = 10
    ecg_per_honest_site: int = 6
    # Output
    output_dir: Path = DEFAULT_OUTPUT_DIR

    @property
    def site_ids(self) -> Tuple[str, ...]:
        return tuple(s.site_id for s in self.sites)

    @property
    def honest_site_ids(self) -> Tuple[str, ...]:
        return tuple(s for s in self.site_ids if not (self.fraud.enabled and s == self.fraud.site_id))

    @property
    def n_ecg_images(self) -> int:
        return self.ecg_per_honest_site * len(self.honest_site_ids) + (
            self.fraud.reused_ecg_images if self.fraud.enabled else 0)

    def site(self, site_id: str) -> SiteProfile:
        for s in self.sites:
            if s.site_id == site_id:
                return s
        raise KeyError(site_id)

    def site_profile_for_visits(self, site_id: str) -> SiteProfile:
        """Profile used to generate measurements: the fraud site's BP spread is overridden."""
        profile = self.site(site_id)
        if self.fraud.enabled and site_id == self.fraud.site_id:
            f = self.fraud
            return dataclasses.replace(profile, sbp_between_sd=f.sbp_between_sd, sbp_within_sd=f.sbp_within_sd,
                                       dbp_between_sd=f.dbp_between_sd, dbp_within_sd=f.dbp_within_sd)
        return profile

    def participants_per_site(self) -> dict:
        base, extra = divmod(self.n_demo_participants, len(self.sites))
        return {s.site_id: base + (1 if i < extra else 0) for i, s in enumerate(self.sites)}


def default_config(output_dir: Optional[Path] = None, **overrides) -> TrialConfig:
    """Build the default config, optionally redirecting output or overriding top-level fields."""
    cfg = TrialConfig(**overrides)
    if output_dir is not None:
        cfg = dataclasses.replace(cfg, output_dir=Path(output_dir))
    return cfg
