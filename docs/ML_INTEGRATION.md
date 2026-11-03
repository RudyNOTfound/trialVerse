# ML integration contract (v1.1)

**Audience:** Person A (core backend) and Person B (ML models). This document is the contract. The code of record is [`src/ml/contracts.ts`](../src/ml/contracts.ts) (types + zod response schemas) and [`src/ml/httpModels.ts`](../src/ml/httpModels.ts).

Phase 0 ships **no models**. The core app runs entirely on rule-based baseline engines; ML plugs in behind two interfaces with automatic fallback, so **no business logic changes are needed to add, swap or remove a model**.

## Responsibilities

| Person A (core) | Person B (ML) |
|---|---|
| Builds features/snapshots from the DB, calls the model, validates the response, persists + audits results, falls back to baseline on any failure | Implements one or both endpoints (or the in-process interface), keeps responses within the schema, documents model name/version, handles its own training/serving |
| Owns `CONTRACT_VERSION` and feature definitions | Requests feature additions via a contract change (below) — never reads the app database directly |

## Two ways to integrate

### 1. HTTP model service (recommended)
Run a service and set:

```
ML_RISK_ENABLED=true         ML_RISK_URL=http://localhost:8001
ML_INTEGRITY_ENABLED=true    ML_INTEGRITY_URL=http://localhost:8002
ML_TIMEOUT_MS=3000           ML_API_KEY=<optional bearer token>
```

Each service must implement (JSON, `content-type: application/json`; if `ML_API_KEY` is set the app sends `Authorization: Bearer <key>`):

| Method & path | Request | Response |
|---|---|---|
| `POST /v1/risk/predict` | `RiskPredictionRequest` | `RiskPredictionResponse` |
| `POST /v1/integrity/predict` | `IntegrityScanRequest` | `IntegrityScanResponse` |

### 2. In-process adapter
Implement the TypeScript interface and pass it when building the context (`buildContext(config, { riskModel, integrityModel })`):

```ts
interface RiskModel {
  readonly name: string; readonly version: string;
  predict(request: RiskPredictionRequest, options?: { signal?: AbortSignal }): Promise<RiskPredictionResponse>;
}
interface IntegrityModel {
  readonly name: string; readonly version: string;
  detect(request: IntegrityScanRequest, options?: { signal?: AbortSignal }): Promise<IntegrityScanResponse>;
}
```

## Risk contract

### Request — `RiskPredictionRequest`

```json
{
  "contractVersion": "1.0",
  "requestId": "6f1c…-uuid",
  "entityType": "patient",
  "entityId": "0b9e…-uuid",
  "featureSchemaVersion": "1",
  "features": { "patient_failed_otp_24h": 6, "patient_visits_7d": 1, "…": "…" },
  "requestedAt": "2026-11-01T12:00:00.000Z"
}
```

`entityType` ∈ `patient | visit | reimbursement`. `features` is a flat map of `number | boolean | string | null` (no nesting). The features present depend on `entityType`:

**visit**

| Feature | Type | Meaning |
|---|---|---|
| `visit_status` | string | `scheduled/otp_pending/verified/completed/missed/cancelled` |
| `visit_is_verified` | bool | status is `verified` or `completed` |
| `visit_hours_past_scheduled` | number \| null | hours since `scheduled_at`; null if in the future |
| `visit_otp_failed_attempts` | int | incorrect OTP attempts across all OTPs of the visit |
| `visit_otp_locked_count` | int | OTPs locked for exceeding attempts |
| `visit_otp_issue_count` | int | OTPs issued for the visit |

**patient**

| Feature | Type | Meaning |
|---|---|---|
| `patient_failed_otp_24h` | int | incorrect OTP attempts across the patient's visits in last 24h |
| `patient_visits_7d` | int | non-cancelled visits scheduled in the last 7 days |
| `patient_missed_90d` | int | missed visits in last 90 days |
| `patient_unverified_overdue` | int | visits still `scheduled`/`otp_pending` > 24h after schedule |
| `patient_duplicate_reimbursements` | int | surplus duplicates among pending/approved claims (same visit, category, amount) |
| `patient_reimbursement_total_30d_cents` | int | sum of pending/approved claims in last 30 days |

**reimbursement**

| Feature | Type | Meaning |
|---|---|---|
| `reimb_amount_cents` | int | claim amount |
| `reimb_category` | string | `travel/meals/accommodation/parking/other` |
| `reimb_duplicate_count` | int | other pending/approved claims with same visit+category+amount |
| `reimb_visit_status` / `reimb_visit_verified` | string / bool | linked visit state |
| `reimb_patient_count_24h` | int | claims by the same patient in last 24h |
| `reimb_amount_ratio_to_category_avg` | number \| null | amount ÷ category mean of other claims; null if < 3 comparables |

Adding/changing features = new `featureSchemaVersion` (models must ignore unknown features and tolerate `null`).

### Response — `RiskPredictionResponse`

```json
{
  "contractVersion": "1.0",
  "requestId": "6f1c…-uuid",
  "modelName": "gbm-risk",
  "modelVersion": "0.3.1",
  "score": 82.4,
  "confidence": 0.9,
  "factors": [ { "name": "otp_failure_rate", "contribution": 41.2, "detail": "6 failures in 24h" } ],
  "explanation": "Elevated OTP failure rate combined with claim velocity."
}
```

| Field | Rules |
|---|---|
| `contractVersion` | same **major** version as the app, else rejected |
| `requestId` | must echo the request |
| `modelName`, `modelVersion` | non-empty; stored with each assessment |
| `score` | number 0–100 (higher = riskier). The app derives `level` (low/medium/high/critical at 25/50/75) |
| `confidence` | optional 0–1 |
| `factors` | optional list (≤ 50) of `{name, contribution, detail?}` → stored as `triggeredRules` with id `ml:<name>` |
| `explanation` | string ≤ 2000 chars, shown to users |

## Integrity contract

### Request — `IntegrityScanRequest`

```json
{
  "contractVersion": "1.0",
  "requestId": "…",
  "windowStart": "2026-10-25T12:00:00.000Z",
  "windowEnd": "2026-11-01T12:00:00.000Z",
  "events": [ { "id": "…", "seq": 12, "actorId": "…|null", "action": "otp.verify_failed",
                "entityType": "visit", "entityId": "…", "createdAt": "…", "metadata": { "reason": "incorrect_code" } } ],
  "reimbursements": [ { "id": "…", "patientId": "…", "visitId": "…", "category": "travel", "amountCents": 7500,
                        "status": "pending", "requestedBy": "…", "reviewedBy": null, "createdAt": "…" } ],
  "openVisits": [ { "id": "…", "patientId": "…", "status": "scheduled", "scheduledAt": "…", "verifiedAt": null } ],
  "chain": { "valid": true, "eventsChecked": 145, "errorCount": 0, "firstError": null }
}
```

`events` are audit events in the window, ascending by `seq` (max 5000, most recent kept). `openVisits` = visits past their scheduled time still unverified (any age, max 2000). Event actions/metadata keys are listed by the code that emits them (`grep appendAuditEvent src`); OTP codes, passwords and patient identifiers are never included.

### Response — `IntegrityScanResponse`

```json
{
  "contractVersion": "1.0", "requestId": "…", "modelName": "iso-forest", "modelVersion": "2.0.0",
  "findings": [ {
    "ruleId": "ml.anomalous_actor", "entityType": "user", "entityId": "…", "severity": "high",
    "score": 0.97, "message": "Actor behaviour is anomalous", "details": { "z": 4.2 }, "dedupeKey": "2026-w44"
  } ]
}
```

`severity` ∈ `low|medium|high|critical`; `score` optional 0–1; `details` any JSON object; ≤ 1000 findings. Each finding becomes an `integrity_alerts` row (`status: open`). **De-duplication**: fingerprint = hash(`modelName`, `ruleId`, `entityType`, `entityId`, `dedupeKey`) — a repeated finding with the same key doesn't create a new alert, so set `dedupeKey` to something that changes when it's a genuinely *new* occurrence (e.g. a time bucket or triggering event id).

## Error handling & fallback (guaranteed behaviour)

The app wraps any ML engine in `ResilientRiskEngine` / `ResilientIntegrityEngine`. **A model problem never fails the API request.** On any of the following the baseline engine runs instead and the stored/returned result carries `fallback: { used: true, reason: "<kind>: <message>" }`:

| `kind` | Trigger |
|---|---|
| `unavailable` | connection refused / DNS / network error |
| `timeout` | no response within `ML_TIMEOUT_MS` (HTTP) or the outer guard (in-process) |
| `model_error` | HTTP ≥ 400, or the in-process model threw |
| `invalid_response` | non-JSON, schema violation, incompatible `contractVersion` major, `requestId` mismatch |

Models should return HTTP 200 with a valid body on success, 4xx for requests they cannot handle (→ fallback), and respond well inside `ML_TIMEOUT_MS`. There is no retry or circuit breaker in Phase 0 (a failing model costs one timeout per request; add a breaker if this matters).

## Versioning rules

- `CONTRACT_VERSION` is `MAJOR.MINOR`. **MINOR**: backwards-compatible additions (new optional fields/features). **MAJOR**: anything else; the app rejects responses with a different major.
- Models must ignore unknown request fields; the app ignores unknown response fields.
- Contract changes are made in `src/ml/contracts.ts` + this document in one PR reviewed by both people.

## Testing your model against the app

1. Run the app (`npm run dev`) with the env above pointing at your service.
2. `POST /api/v1/risk/assessments {"entityType":"patient","entityId":"<id from seed>"}` and check `engine.name`, `fallback`.
3. `POST /api/v1/integrity/scans {}` and check `alerts[].source`.
4. `tests/ml-integration.test.ts` contains a complete reference stub server and shows every failure mode; copy it as a starting point.

Minimal reference service (Node):

```js
require('http').createServer((req, res) => {
  let b = ''; req.on('data', c => b += c).on('end', () => {
    const r = JSON.parse(b); res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/risk/predict')
      return res.end(JSON.stringify({ contractVersion: '1.0', requestId: r.requestId, modelName: 'demo', modelVersion: '0.0.1',
        score: Math.min(100, (r.features.visit_otp_failed_attempts ?? 0) * 20), factors: [], explanation: 'demo model' }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(8001);
```


---

## Contract v1.1 (Phase 6) — what the backend sends to the Python service

Version `1.1` is additive over `1.0` (peers compare the MAJOR number only). Person B's Pydantic models in
`ml-service/app/api/schemas.py` are the source of truth; `src/ml/contracts.ts` mirrors them and is checked before every send.

### Risk (`entityType: "patient"`, `featureSchemaVersion: "2"`)
`visit` and `reimbursement` requests stay on schema `"1"`. A participant is scored by the retention (Logistic Regression) model only
when every REQUIRED input is known; otherwise the request is not sent and the baseline answers with a reason such as
`invalid_request: missing required features: site_id`. Unknown is `null`, never `0`.

| Feature | Source |
|---|---|
| `site_id` | `trial_sites.ml_site_category` of the participant's current enrollment (unmapped ⇒ null) |
| `age` | `patients.date_of_birth` |
| `distance_km` | `enrollments.distance_to_site_km` (`PATCH /enrollments/:id`) |
| `daily_wage_worker` | `patients.daily_wage_worker` (create/`PATCH /patients/:id`; null = unknown) |
| `scheduled_visits`, `visits_missed` | visits of the enrollment (cancelled excluded; missed = status `missed`) |
| `missed_reminders` | `visit_reminders` with resolved outcome; none resolved ⇒ null |
| `reimbursement_delay_days` | mean of `paid_at - created_at` over paid reimbursements; none ⇒ null |
| `side_effects_reported` | any row in `adverse_event_reports` |
| `phone_changed` | a `patient.updated` audit event that changed `phone` |

A 422 from Python is surfaced as a safe summary (error code, feature names, field paths — never messages or values), e.g.
`model_error: Model service rejected the request (HTTP 422: unknown_site_category)`.

### Integrity (`trialData`)
`src/modules/integrity/trialData.ts` builds, per trial and with a constant number of queries: `sites` (IANA `timezone`,
`mlSiteCategory`), `participants` (`droppedOut` from enrollment status `withdrawn`), `visits` (UTC instants with offsets,
`otpVerified`, `otpExceptionReason`, measurements, `ecgRecordId`) and `ecgs` (`imageRef` relative to `ML_ECG_DIR`). Caps:
200 sites, 5000 participants, 20000 visits, 2000 ECGs. A site without a timezone is left out together with its participants,
visits and ECGs, and its id is recorded in `integrity.scan_completed` metadata (`sitesSkippedNoTimezone`) and in the scan response `coverage`.

### OTP exception
`POST /visits/:id/status` with `{ "status": "completed", "otpException": { "reasonCode": "...", "note": "..." } }`
(admin/investigator only) completes a visit that was never OTP-verified. The visit is never marked verified
(`verifiedAt` stays null, `otpVerified: false`); the exception is stored in `visit_otp_exceptions`, audited as
`visit.completed_without_otp` (reason code only — the free-text note stays in the database and is hidden from other roles) and sent
to Python as `otpVerified:false` + `otpExceptionReason`, which is evidence for reviewers and never lowers a finding.
Without `otpException` the usual 409 stays.

### Configuration
| Variable | Meaning |
|---|---|
| `ML_RISK_URL`, `ML_INTEGRITY_URL`, `*_ENABLED` | where/whether to call the service |
| `ML_API_KEY` | bearer token; must equal the Python service's `ML_API_KEY`. Wrong key ⇒ HTTP 401 ⇒ baseline fallback (`unauthorized`) |
| `ML_TIMEOUT_MS` | risk timeout (default 3000) |
| `ML_INTEGRITY_TIMEOUT_MS` | integrity timeout (default 10000) — scans send the whole trial |
| `ML_ECG_DIR` | directory with the ECG images, must be the same directory the Python service uses (its `ML_ECG_DIR`) |

Fallback is always marked: `fallback: { used: true, reason }` with reasons `unavailable`, `timeout`, `unauthorized`,
`invalid_request` (refused before sending) or `model_error` (including Python's 422).

### Running against the real Python service
```bash
# 1. Python (once): a venv with the versions the shipped model was trained with
python3 -m venv ~/.venv-ml && ~/.venv-ml/bin/pip install -r ml-service/requirements.txt \
  scikit-learn==1.6.1 numpy==2.0.2 pandas==2.3.3 shap==0.49.1      # newer scikit-learn cannot load pipeline.joblib
# 2. dataset + service
cd ml-service && python -m app.data_generation.generate_all
ML_API_KEY=<test key> ML_ECG_DIR=$PWD/generated_data uvicorn app.main:app --port 8011
# 3. demo data into the backend database (idempotent, additive), then use the app normally
npm run ml:demo-import
# 4. live tests (skipped unless ML_LIVE_URL and ML_LIVE_DATA are set)
ML_LIVE_URL=http://127.0.0.1:8011 ML_LIVE_KEY=<test key> ML_LIVE_DATA=$PWD/ml-service/generated_data \
  ML_LIVE_LOG=<service log file> npx vitest run tests/live
```

### Not implemented in this phase
REST endpoints for reminders, adverse-event reports, visit measurements and ECG registration (the tables exist and the
payload builders read them; they are filled by the demo import). Optional `risk_assessments.engine_extras` (decision D7) was not added.
