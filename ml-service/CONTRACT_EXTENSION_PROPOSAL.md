# Contract extension proposal (for Person A's decision)

**Status: proposal only.** Nothing in `src/` or `docs/ML_INTEGRATION.md` was changed. The current contract (v1.0, code of
record `src/ml/contracts.ts`) is implemented exactly as written; this note lists what it cannot carry.

## What does not fit today

| Need | Contract v1.0 | Gap |
|---|---|---|
| Dropout risk (Phase 4 model) | `/v1/risk/predict`, features for `patient`/`visit`/`reimbursement` are OTP failures, claim velocity, visit status | The model needs `site_id`, `distance_km`, `daily_wage_worker`, `missed_reminders`, `side_effects_reported`, `phone_changed`, `visits_missed` (+ optional `age`, `reimbursement_delay_days`). None is sent, and the schema in `001_init.sql` has no columns for most of them (`patients` has `date_of_birth` → age, `visits.status = 'missed'` → `visits_missed`). |
| Site C checks (BP digit preference / variance, rapid entry, late-night entry, ECG reuse) | `/v1/integrity/predict` carries audit events, claims, open visits, chain verdict | No measurements, no device vs entry timestamps, no per-visit OTP flag, no site id, no ECG reference. |
| Hash-chain re-verification in Python | `chain` = backend's verdict only | Events lack `prevHash` / `hash`. |

## Smallest extensions (all MINOR, backwards-compatible)

**1. Risk — `featureSchemaVersion: "2"`, `entityType: "patient"`.** Add the nine participant features above to the flat
`features` map. Models already ignore unknown features and tolerate `null`, so v1 consumers are unaffected. The Python route
already accepts this request unchanged (verified with the backend's own `HttpRiskModel`). Person A decides whether the
backend should capture these fields at all; if not, the retention model should stay off the live path and the baseline
risk engine remains authoritative.

**2. Integrity — optional `trialVisits` array on `IntegrityScanRequest`** (ignored by older models):

```json
"trialVisits": [{"visit_id":"…","participant_id":"…","site_id":"…","visit_number":3,"scheduled_date":"2026-03-01",
  "status":"completed","device_timestamp":"…+05:30","entry_timestamp":"…+05:30","otp_verified":1,
  "systolic_bp":120,"diastolic_bp":80,"heart_rate":70,"weight_kg":70.0,"glucose_mg_dl":110,"ecg_id":"ecg_001"}],
"ecgs": [{"ecg_id":"ecg_001","visit_id":"…","participant_id":"…","site_id":"…","image_file":"ecgs/ecg_001.png"}]
```

with `participants[].dropped_out` for retention. The Python engine already accepts exactly these shapes on
`POST /v1/integrity/trial-scan` (snake_case, `image_file` relative to `ML_ECG_DIR`); merging them into `/v1/integrity/predict`
is a routing change on this side. ECG images must be reachable by the service (shared directory) or sent as precomputed
perceptual hashes (`image_phash`, 16 hex chars) to avoid shipping files.

**3. Hash-chain (optional).** Add `prevHash` and `hash` to `AuditEventSummary` and document `HASH_VERSION` plus the
`canonicalJson` recipe from `src/utils/crypto.ts`. Python could then re-verify the chain independently. Recommended
only if a second verifier is wanted; otherwise keep verification solely in TypeScript (current behaviour).

## Not proposed

* No `fraud_probability` field: nothing here is calibrated for it.
* No change to severity values, `dedupeKey` semantics or error handling.
