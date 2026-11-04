# Integrity engine demonstration (GLU-301, synthetic)

Synthetic Phase 3 data, fully fictional. Findings are review prompts; none of them establishes fraud. This prototype is not validated for real clinical-trial monitoring.

Visits scanned: 2400 (1966 completed) across 5 sites. Findings: 44 — by severity {'critical': 0, 'high': 25, 'medium': 9, 'low': 10}, by category {'technical_violation': 0, 'suspicious_pattern': 35, 'data_quality': 9}.

## Site-level statistics

| Site | Participants | Completed visits | Retained | SBP SD | SBP ending 0/5 | Completed w/o OTP | Late-night entries | Entries >24 h late | Rapid-entry clusters | Signals |
|---|---|---|---|---|---|---|---|---|---|---|
| SITE-A | 60 | 381 | 44/60 | 14 | 23% | 2 | 0 | 0 | 0 | — |
| SITE-B | 60 | 363 | 42/60 | 15.5 | 20% | 4 | 0 | 0 | 0 | — |
| SITE-C | 60 | 480 | 60/60 | 3.62 | 89% | 18 | 18 | 18 | 3 | high_retention, digit_preference, low_variance, missing_otp, late_night_entries, delayed_entries, rapid_entry_clusters |
| SITE-D | 60 | 347 | 37/60 | 13.4 | 19% | 1 | 0 | 0 | 0 | — |
| SITE-E | 60 | 395 | 47/60 | 12.2 | 21% | 2 | 0 | 0 | 0 | — |

Comparative tests (each site vs the pooled other sites, one-sided; p-values):

| Site | Retention | SBP digit pref. | SBP variance ratio | Missing OTP | Late night | Delayed entry |
|---|---|---|---|---|---|---|
| SITE-A | 0.824 | 0.095 | 1 (ratio 1.42) | 0.978 | 1 | 1 |
| SITE-B | 0.953 | 0.5 | 1 (ratio 1.88) | 0.763 | 1 | 1 |
| SITE-C | 1.03e-09 | 3.88e-230 | 7.72e-172 (ratio 0.0681) | 3.54e-06 | 7.44e-12 | 7.44e-12 |
| SITE-D | 1 | 0.647 | 0.998 (ratio 1.26) | 0.995 | 1 | 1 |
| SITE-E | 0.42 | 0.372 | 0.617 (ratio 1.02) | 0.982 | 1 | 1 |

Isolation Forest over 262 participant recording profiles (features: sbp_sd, dbp_sd, heart_rate_sd, glucose_sd, sbp_share_ending_0_or_5, dbp_share_ending_0_or_5, sbp_range; contamination assumption 0.02). Site score comparison (Mann-Whitney U vs other sites):

| Site | Mean anomaly score | Others | p | Participants in anomalous set |
|---|---|---|---|---|
| SITE-A | 0.453 | 0.467 | 0.99 | 0 |
| SITE-B | 0.473 | 0.463 | 0.067 | 2 |
| SITE-C | 0.493 | 0.456 | 3.5e-10 | 3 |
| SITE-D | 0.456 | 0.466 | 0.92 | 1 |
| SITE-E | 0.444 | 0.470 | 1 | 0 |

## Findings

### Technical Violation (0)


### Suspicious Pattern (35)

- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-269f81a49659`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-38ebfe715aa3`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-3e314cf71a83`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-66b108818438`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-878be8aea2e9`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `ecg.duplicate_image` — ecg_cluster `ecg-cluster-e5ddb550d2eb`: 4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.
- **HIGH** `site.multiple_integrity_signals` — site `SITE-C`: Site SITE-C shows 7 independent integrity signals (high_retention, digit_preference, low_variance, missing_otp, late_night_entries, delayed_entries, rapid_entry_clusters). Together they are unusual relative to the other sites and warrant a human review; they do not prove misconduct.
- **MEDIUM** `site.low_bp_variance` — site `SITE-C`: Systolic BP at SITE-C has SD 3.6 versus 13.9 at the other sites (variance ratio 0.07, p=7.7e-172). Real patient data are rarely this uniform.
- **MEDIUM** `site.bp_digit_preference` — site `SITE-C`: 89% of systolic BP readings at SITE-C end in 0 or 5 (about 20% expected if last digits were uniform; n=480, p=3.9e-230). This suggests rounded or invented values.
- **MEDIUM** `site.delayed_entries` — site `SITE-C`: SITE-C has 18 entries made >24 h after the visit (3.8% of 480) versus 0.0% at the other sites (p=7.4e-12).
- **MEDIUM** `site.late_night_entries` — site `SITE-C`: SITE-C has 18 entries made late at night (3.8% of 480) versus 0.0% at the other sites (p=7.4e-12).
- **MEDIUM** `site.anomaly_enrichment` — site `SITE-C`: Participant recording profiles at SITE-C score higher on the unsupervised anomaly model than at the other sites (mean 0.49 vs 0.46, p=3.5e-10). This is an anomaly signal, not proof of fraud.
- **MEDIUM** `site.missing_otp_rate` — site `SITE-C`: SITE-C has 18 completed visits without OTP verification (3.8% of 480) versus 0.6% at the other sites (p=3.5e-06).
- **MEDIUM** `site.rapid_entry_cluster` — site `SITE-C`: 6 visits at SITE-C were entered within 9.7 minutes (2026-04-29T01:16:00+05:30 to 2026-04-29T01:25:42+05:30).
- **MEDIUM** `site.rapid_entry_cluster` — site `SITE-C`: 6 visits at SITE-C were entered within 11.7 minutes (2026-06-24T00:36:00+05:30 to 2026-06-24T00:47:42+05:30).
- **MEDIUM** `site.rapid_entry_cluster` — site `SITE-C`: 6 visits at SITE-C were entered within 8.7 minutes (2026-08-20T01:48:00+05:30 to 2026-08-20T01:56:44+05:30).
- **LOW** `site.high_retention` — site `SITE-C`: Site SITE-C retained 100% of participants versus 71% at the other sites (p=1.0e-09). High retention alone is not evidence of fraud; it is only meaningful alongside other signals.
- **HIGH** `visit.multiple_integrity_signals` — 18 visits ({'SITE-C': 18}), e.g. `V-C-001-03` with signals ['late_entry', 'missing_otp', 'night_entry', 'rapid_entry']. Full list in the JSON report.

### Data Quality (9)

- **LOW** `visit.missing_otp` — visit `V-A-039-07`: Visit V-A-039-07 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-A-057-04`: Visit V-A-057-04 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-B-003-01`: Visit V-B-003-01 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-B-015-01`: Visit V-B-015-01 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-B-045-01`: Visit V-B-045-01 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-B-050-02`: Visit V-B-050-02 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-D-004-06`: Visit V-D-004-06 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-E-026-01`: Visit V-E-026-01 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.
- **LOW** `visit.missing_otp` — visit `V-E-036-04`: Visit V-E-036-04 completed without OTP verification. A single signal is a data-quality warning, not evidence of misconduct.

## Duplicate ECG clusters

| Cluster | Visits | Participants | Max Hamming distance (of 64 bits) |
|---|---|---|---|
| `ecg-cluster-269f81a49659` | V-C-014-04, V-C-028-08, V-C-036-01, V-C-015-03 | P-C-014, P-C-015, P-C-028, P-C-036 | 0 |
| `ecg-cluster-38ebfe715aa3` | V-C-032-05, V-C-026-08, V-C-012-08, V-C-043-05 | P-C-012, P-C-026, P-C-032, P-C-043 | 0 |
| `ecg-cluster-3e314cf71a83` | V-C-001-03, V-C-052-04, V-C-033-04, V-C-046-06 | P-C-001, P-C-033, P-C-046, P-C-052 | 0 |
| `ecg-cluster-66b108818438` | V-C-020-04, V-C-049-05, V-C-022-07, V-C-008-02 | P-C-008, P-C-020, P-C-022, P-C-049 | 0 |
| `ecg-cluster-878be8aea2e9` | V-C-017-04, V-C-006-02, V-C-031-01, V-C-050-08 | P-C-006, P-C-017, P-C-031, P-C-050 | 0 |
| `ecg-cluster-e5ddb550d2eb` | V-C-011-07, V-C-002-07, V-C-047-08, V-C-037-06 | P-C-002, P-C-011, P-C-037, P-C-047 | 0 |

ECG images checked: 48; unreadable: 0.

## Check against the Phase 3 ground truth

- Injected unverified late-night visits: 18; flagged as multi-signal visits: 18.
- Multi-signal visits not in the ground truth: none.
- Injected reused-ECG visits: 24; inside duplicate clusters: 24; ECG-cluster visits not in ground truth: none.
- Site C visits: 480; with a multi-signal finding: 18 (the engine does not flag every Site C visit).
- Honest-site multi-signal visits: none; site-level medium/high findings by site: {'SITE-C': 10}.
- Honest-site single-signal data-quality warnings (e.g. missing OTP): 9 — kept at LOW because one weak rule is not evidence of misconduct.

## Limitations observed

- Ground truth is injected by the same author as the detectors, so detection here is a sanity check, not a performance estimate.
- Site C's patterns are strong by construction. Subtler real-world fabrication would be harder to see.
- Honest sites still trigger a few LOW missing-OTP warnings (about 0.6% of their visits); any real deployment must expect such noise.
- The visit-level Isolation Forest was dropped: coordinated fabrication forms a dense cluster, so few members are individually isolated. The participant-profile forest only separates Site C as a group (mean score), and only through features that overlap the variance and digit-preference statistics, so it is a corroborating signal rather than independent evidence.
- Retention is derived from the supplied `dropped_out` flags; high retention alone is shown as LOW severity.
- Hash-chain verification is not repeated here: the backend contract carries only the backend's own chain verdict.
