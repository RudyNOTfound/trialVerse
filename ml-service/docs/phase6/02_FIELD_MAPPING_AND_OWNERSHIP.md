# 2. Data ownership and field mapping

Rule: **the backend owns data; Python owns inference.** Python stores nothing about participants, reads no database,
and never writes back. The backend persists every ML result (`risk_assessments`, `integrity_alerts`) with its own audit event.

## 2.1 Ownership matrix

| Concern | Backend (Person A) | Python service (Person B) |
|---|---|---|
| Capture a field (UI/API write) | ✔ all fields | – |
| Store a field | ✔ (migrations, constraints) | – (stateless; ECG files are read from a shared directory, never copied) |
| Validate at capture | ✔ range/format/state rules (zod + SQL CHECK) | – |
| Validate at inference | schema-level only (it builds the request) | ✔ Pydantic: types/ranges/required; **plausibility is a finding, not an error** |
| Derive features (age, delay, counts, flags) | ✔ one place: `src/modules/risk/features.ts` (+ a new integrity builder) | – (never recomputes from raw records) |
| Convert timestamps to site-local time | – (stores UTC only; never assumes a timezone) | ✔ using `sites[].timezone` (D2); no timezone ⇒ refuse |
| Map backend site to model category | ✔ `trial_sites.ml_site_category` (D1) | ✔ rejects categories the model does not know |
| Record an OTP exception | ✔ capture, store, audit (D3) | – (consumes `otpVerified=false` + reason code) |
| Send the request | ✔ `HttpRiskModel` / `HttpIntegrityModel` | – |
| Authentication | ✔ sends `Authorization: Bearer ML_API_KEY` | ✔ verifies it when `ML_API_KEY` is set |
| Timeout / fallback / baseline rules | ✔ `ResilientRiskEngine`/`ResilientIntegrityEngine` | ✔ answers well inside `ML_TIMEOUT_MS` (risk ≈ 30 ms; integrity engine ≈ 0.5–0.6 s measured on the 2,400-visit demo, excluding HTTP and JSON parsing; re-measure at target size) |
| Model/threshold/explanation logic | – | ✔ |
| Persist the ML result | ✔ `risk_assessments`, `integrity_alerts`, audit events | – |
| ECG image bytes | ✔ stores and exposes a shared directory | ✔ reads (pHash, cached by path+mtime+size) |

**No duplication:** `age` is derived, not stored; `phone_changed` and `side_effects` use existing audit/new-report data rather than
copies; `visits_missed`, `scheduled_visits`, `reimbursement_delay_days` are derived from existing tables. Only data that does not
exist today is added: distance, wage status, reminder log, adverse-event reports, visit measurements, ECG records, site timezone, site model category, OTP exceptions (and, if Person A approves, one JSON column for ML extras). `droppedOut` reuses `enrollments.status`.

## 2.2 Mapping chains

Notation: `DB → extraction → request key → Pydantic field → engine`.

### Retention (risk request, `entityType: "patient"`)

| Feature | DB → extraction | Request key | Pydantic (`app/retention/schemas.ParticipantFeatures`) | Engine use |
|---|---|---|---|---|
| site | `enrollments.trial_site_id → trial_sites.ml_site_category` (NULL ⇒ send `null`) | `features.site_id` | `site_id: str` | one-hot; unknown category rejected (422) on the contract route |
| age | `patients.date_of_birth` → `floor((requestedAt − dob)/365.25y)` | `features.age` | `age: Optional[float]` | median-impute, scale |
| distance | NEW `enrollments.distance_to_site_km` | `features.distance_km` | `distance_km: float` | scale |
| wage | NEW `patients.daily_wage_worker` | `features.daily_wage_worker` | `int` (0/1) | passthrough |
| schedule length | `COUNT(visits) WHERE enrollment_id=? AND status!='cancelled'` | `features.scheduled_visits` | `scheduled_visits: StrictInt` | validation only |
| reminders | NEW `visit_reminders`: `CASE WHEN COALESCE(SUM(outcome IN ('acknowledged','missed')),0)=0 THEN NULL ELSE SUM(outcome='missed') END` per enrollment (SQLite) | `features.missed_reminders` | `StrictInt` | scale |
| reimbursement delay | `reimbursements`: `AVG(julianday(paid_at)-julianday(created_at))` over `payment_status='paid'` | `features.reimbursement_delay_days` | `Optional[float]` | median-impute, scale |
| side effects | NEW `adverse_event_reports`: `EXISTS` | `features.side_effects_reported` | `int` (0/1) | passthrough |
| phone change | `audit_logs`: `EXISTS action='patient.updated' AND entity_id=? AND json_extract(metadata,'$.changedFields') LIKE '%"phone"%'` | `features.phone_changed` | `int` (0/1) | passthrough |
| missed visits | `COUNT(visits) WHERE status='missed' AND scheduled_at<=requestedAt` | `features.visits_missed` | `StrictInt` | scale |
| participant id | `patients.id` | `entityId` | `participant_id` (echoed, unused) | – |

Python route: `risk_adapter.to_retention_input()` copies only these keys, `RetentionPredictor.predict()` validates and scores.

### Integrity (`trialData`)

| Item | DB → extraction | Request key | Pydantic (new, `app/api/schemas.py`) | Engine use |
|---|---|---|---|---|
| visit identity | `visits.id`, `patient_id`, `trial_site_id` | `trialData.visits[].visitId/participantId/siteId` | `TrialVisit` | grouping, `entityId` |
| visit order | `ROW_NUMBER() OVER (PARTITION BY enrollment_id ORDER BY scheduled_at)` | `visitNumber` | `visit_number` | retention fallback (final visit) |
| schedule | `visits.scheduled_at` | `scheduledAt` | → local `scheduled_date` | visit-window rule |
| actual visit time | NEW `visit_measurements.performed_at` | `performedAt` | `device_timestamp` | window rule, entry lag |
| entry time | NEW `visit_measurements.entered_at` | `enteredAt` | `entry_timestamp` | late-entry, night-entry, rapid-entry |
| OTP | `visits.verified_at IS NOT NULL` (`false` for exception-completed visits) | `otpVerified` (boolean) | `otp_verified` | missing-OTP rule/rate |
| OTP exception reason | NEW `visit_otp_exceptions.reason_code` (note text never leaves the backend) | `otpExceptionReason` | `otp_exception_reason` | finding evidence only |
| dropout flag | `enrollments.status = 'withdrawn'` (not sent for `screening`/`screen_failed`) | `participants[].droppedOut` | `dropped_out` | site retention statistic |
| BP/HR/weight/glucose | NEW `visit_measurements.*` | `systolicBp…glucoseMgDl` | `systolic_bp…glucose_mg_dl` | plausibility, digit preference, variance, anomaly |
| ECG | NEW `visit_ecgs` | `ecgs[]` (`imageRef` only) | `TrialEcg` | pHash computed by Python |
| site tz | NEW `trial_sites.timezone` (UTC timestamps unchanged) | `sites[].timezone` | new `SiteRef` | local-time rules only |
| audit info | `audit_logs`, `reimbursements`, open `visits`, `verifyChain()` | `events`, `reimbursements`, `openVisits`, `chain` | `IntegrityRequest` (unchanged) | `ml.*` audit rules |

Result: `findings[] → integrity_alerts` (existing code path, unchanged).

## 2.4 Canonical name map (one name per concept — used identically in 01, 03, 04)

| Concept | DB column / table | Backend REST field | ML key | Type | Nullable | Decision |
|---|---|---|---|---|---|---|
| Model site category | `trial_sites.ml_site_category` | `mlSiteCategory` | `features.site_id` | string | yes (null ⇒ 422 ⇒ baseline) | D1 |
| Site timezone | `trial_sites.timezone` | `timezone` | `trialData.sites[].timezone` | IANA string | yes (null ⇒ site omitted from scan) | D2 |
| Distance | `enrollments.distance_to_site_km` | `distanceToSiteKm` | `features.distance_km` | number 0–2000 | yes (null ⇒ 422) | – |
| Wage status | `patients.daily_wage_worker` | `dailyWageWorker` | `features.daily_wage_worker` | 0/1 ⇄ boolean | yes (null ⇒ 422) | – |
| Reminder log | `visit_reminders` (`enrollment_id`, `channel`, `sent_at`, `outcome`, …) | reminder endpoints | `features.missed_reminders` | integer | yes (no resolved reminder ⇒ null) | D4 |
| Adverse event | `adverse_event_reports` | adverse-event endpoints | `features.side_effects_reported` | 0/1 | no (absence of reports = 0) | – |
| OTP exception | `visit_otp_exceptions.reason_code` | `otpException.reasonCode` | `trialData.visits[].otpExceptionReason` | enum | yes | D3 |
| OTP verified | derived `visits.verified_at IS NOT NULL` | `otpVerified` | `trialData.visits[].otpVerified` | boolean | null unless `completed` | D3 |
| Performed time | `visit_measurements.performed_at` | `performedAt` | `trialData.visits[].performedAt` | ISO instant | required if completed | – |
| Entered time | `visit_measurements.entered_at` (server-set) | read-only `enteredAt` | `trialData.visits[].enteredAt` | ISO instant | required if completed | D8 |
| Dropout flag | derived `enrollments.status='withdrawn'` | – | `trialData.participants[].droppedOut` | boolean | no | D6 |
| ECG file | `visit_ecgs.file_ref` | upload endpoint | `trialData.ecgs[].imageRef` | relative path | no | D9 |
| Engine extras | `risk_assessments.engine_extras` (JSON, optional) | `engineExtras` | response `retentionRiskLevel`, `recommendedActions` | object | yes | D7 |

`REMINDER_ACK_DEADLINE_HOURS` is backend configuration (default 24), not a contract field.

## 2.3 Complete examples

### A. Ramesh — risk request / response (values from the real service; participant data fictional)

Request (`POST {ML_RISK_URL}/v1/risk/predict`, `Authorization: Bearer …` if configured):

```json
{
  "contractVersion": "1.1",
  "requestId": "6f1c2a0e-0000-4000-8000-000000000001",
  "entityType": "patient",
  "entityId": "0b9e7c1a-0000-4000-8000-0000000000a1",
  "featureSchemaVersion": "2",
  "features": {
    "patient_failed_otp_24h": 0, "patient_visits_7d": 0, "patient_missed_90d": 1,
    "patient_unverified_overdue": 0, "patient_duplicate_reimbursements": 0, "patient_reimbursement_total_30d_cents": 0,
    "site_id": "SITE-A", "age": 52, "distance_km": 40, "daily_wage_worker": 1, "scheduled_visits": 8,
    "missed_reminders": 2, "reimbursement_delay_days": 12, "side_effects_reported": 1, "phone_changed": 0, "visits_missed": 1
  },
  "requestedAt": "2026-11-01T12:00:00.000Z"
}
```

Response (verified live; `factors`/`recommendedActions` truncated here to 3/2 entries):

```json
{
  "contractVersion": "1.1",
  "requestId": "6f1c2a0e-0000-4000-8000-000000000001",
  "modelName": "retention-dropout-risk",
  "modelVersion": "1.0.0+logistic_regression.0e359a5a",
  "score": 70.01,
  "factors": [
    {"name": "missed_reminders", "contribution": 10.55, "detail": "Missed reminders: 2 raises the model's risk score by 10.5 points"},
    {"name": "reimbursement_delay_days", "contribution": 10.42, "detail": "Reimbursement delay: 12 days raises the model's risk score by 10.4 points"},
    {"name": "daily_wage_worker", "contribution": 8.69, "detail": "Daily-wage worker: yes raises the model's risk score by 8.7 points"}
  ],
  "explanation": "Predicted dropout risk 70/100; retention model category: high (model thresholds, separate from the platform's risk levels). Largest risk-increasing factors: missed reminders (+10.6), reimbursement delay (+10.4), daily-wage worker (+8.7). Factors are statistical associations in synthetic training data, not causes. Prototype; not validated for clinical use.",
  "retentionRiskLevel": "high",
  "recommendedActions": [
    {"action_type": "reminder_escalation", "title": "Increase reminder frequency or use IVR calls", "reason": "2 reminders were missed.", "priority": "high"},
    {"action_type": "reimbursement_priority", "title": "Prioritise reimbursement resolution (instant payout where possible)", "reason": "Reimbursements are taking about 12 days.", "priority": "high"}
  ]
}
```

(Python now answers `contractVersion: "1.1"` (D13, implemented); the backend only compares majors. Here the backend sent `site_id: "SITE-A"` because `trial_sites.ml_site_category = 'SITE-A'` for Ramesh's site.)
The backend persists: `score 70`, `level high` (25/50/75), `triggeredRules` = `ml:<factor>` rows, `explanation`, engine name/version, and the audit event `risk.assessed`.

Missing-input example → fallback path:

```json
// request.features.distance_km = null   (or site_id = null because ml_site_category is unmapped, or missed_reminders = null because no reminder data)   →   HTTP 422
{"error": {"code": "unsupported_feature_schema",
           "message": "Request lacks the participant features the retention model needs; refusing to score on defaults",
           "requestId": "…", "details": {"missingFeatures": ["distance_km"], "featureSchemaVersion": "2"}}}
// backend stores the baseline result with fallback.reason = "model_error: Model service rejected the request with HTTP 422"
```

### B. Site C — integrity request (abridged) and findings

```json
{
  "contractVersion": "1.1", "requestId": "9d3e…", "windowStart": "2026-10-25T12:00:00.000Z", "windowEnd": "2026-11-01T12:00:00.000Z",
  "events": [], "reimbursements": [], "openVisits": [],
  "chain": {"valid": true, "eventsChecked": 145, "errorCount": 0, "firstError": null},
  "trialData": {
    "scope": {"trialId": "a1b2…", "asOf": "2026-11-01T12:00:00.000Z"},
    "sites": [{"siteId": "5c1e…", "siteCode": "SITE-C", "timezone": "Asia/Kolkata"}],
    "participants": [{"participantId": "7a90…", "siteId": "5c1e…", "droppedOut": false}],
    "visits": [{
      "visitId": "c3f0…", "participantId": "7a90…", "siteId": "5c1e…", "visitNumber": 3, "visitType": "week-8", "status": "completed",
      "scheduledAt": "2026-04-23T04:30:00.000Z", "performedAt": "2026-04-23T09:09:00+05:30", "enteredAt": "2026-04-29T01:16:00+05:30",
      "otpVerified": false, "otpExceptionReason": "device_offline", "systolicBp": 120, "diastolicBp": 80, "heartRate": 72, "weightKg": 70.4, "glucoseMgDl": 110, "ecgRecordId": "ecgr-0001"
    }],
    "ecgs": [{"ecgRecordId": "ecgr-0001", "visitId": "c3f0…", "participantId": "7a90…", "siteId": "5c1e…", "imageRef": "ecgs/ecg_028.png"}]
  }
}
```

Findings produced from the Phase 3 demo by the legacy route. After adoption the only differences are that `entityId`/`details.siteId` carry the backend's `siteId` UUID (shown as `5c1e…`), the message names the site by `siteCode`, and visit/participant ids are the backend's UUIDs (Phase 3 ids kept below for readability):

```json
{"ruleId": "site.bp_digit_preference", "entityType": "site", "entityId": "5c1e…", "severity": "medium", "score": 0.8854,
 "message": "89% of systolic BP readings at SITE-C end in 0 or 5 (about 20% expected if last digits were uniform; n=480, p=3.9e-230). This suggests rounded or invented values.",
 "details": {"share_ending_0_or_5": 0.885, "expected": 0.2, "n": 480, "p_value": 3.9e-230, "category": "suspicious_pattern",
             "recommendedReviewAction": "Request source documents or device logs for a sample of readings.", "siteId": "5c1e…", "siteCode": "SITE-C"},
 "dedupeKey": "5c1e…"}
{"ruleId": "ecg.duplicate_image", "entityType": "ecg_cluster", "entityId": "ecg-cluster-3e314cf71a83", "severity": "high", "score": 1.0,
 "message": "4 ECG images are identical (pHash Hamming distance up to 0, threshold 4) across 4 participant(s). Independent recordings of different people should not match.",
 "details": {"visitIds": ["V-C-001-03", "V-C-052-04", "V-C-033-04", "V-C-046-06"], "participantIds": ["P-C-001", "P-C-033", "P-C-046", "P-C-052"],
             "maxHammingDistance": 0, "hashBits": 64, "crossParticipant": true, "category": "suspicious_pattern",
             "recommendedReviewAction": "Compare the original device exports and recording metadata for these visits.", "siteId": "5c1e…", "siteCode": "SITE-C"},
 "dedupeKey": "3e314cf71a83"}
```

The `trialData` request shape is a **target** (Python does not accept it yet; the equivalent snake_case body works today on
`/v1/integrity/trial-scan`). Findings above are produced today by that route.
