# 6. Final decision record — Phase 6 contract v1.1

Date: 2026-11-02 · Specification only: no TypeScript, Python, migration, Phase 3 or Phase 4 file was changed.
Evidence and rejected options: [05](05_UNRESOLVED_DECISIONS.md). Field-level contract: [01](01_CONTRACT_SPECIFICATION.md).
Approval already given: extension of participant data collection and visit data collection (new columns/tables listed in [03](03_IMPLEMENTATION_CHECKLISTS.md) A2).

Owners: **A** = Person A (backend/DB/frontend, product decisions) · **B** = Person B (Python service).

| ID | Selected option | Reason | Owner | Implementation implications | Remaining approval |
|---|---|---|---|---|---|
| D1 | Explicit mapping column `trial_sites.ml_site_category` (nullable, no value restriction); demo sites = `SITE-A…SITE-E` | Keeps demo ids out of production rules; no silent fallback to a wrong site effect | A + B (user-approved) | A: migration, site create/patch field `mlSiteCategory`, seed. B: 422 `unknown_site_category` on contract route (changes one existing Python test deliberately) | None |
| D2 | `trial_sites.timezone` nullable IANA, no default; UTC storage kept | One source of truth; guessing a zone misclassifies night entries | A (user-approved) | A: column + validation + omit sites without tz from `trialData` + audit `sitesSkippedNoTimezone`. B: convert only for local-time rules; missing/invalid ⇒ 422 | None |
| D3 | Audited exception path `POST /visits/:id/status` with `otpException`; table `visit_otp_exceptions`; `otpVerified` derived from `verified_at` | Separates completion from verification without weakening the state machine; no change to `visits` columns | A (user-approved) | A: new table, route change, audit `visit.completed_without_otp`, `investigator`/`admin` only. B: consume `otpVerified=false` + `otpExceptionReason`; LOW alone, escalates only with other signals | None |
| D4 | New `visit_reminders` log; `missed_reminders` = count of `outcome='missed'`, `null` if no resolved reminder; ack window 24 h | Reproducible, auditable, never fabricates a 0; counter alternative keeps contract identical | A | A: table, entry route/seed, derivation SQL. B: nothing new (feature already required) | **Person A**: confirm window = Phase 3 meaning, table vs counter fallback, who records outcomes |
| D5 | Mean paid-claim delay in days; `null` if none | Matches how Phase 3 generated the value | A | A: derivation only, no schema change | None |
| D6 | `droppedOut = (enrollment.status = 'withdrawn')`, required field; screening/screen_failed not sent | Explicit recorded fact instead of an inferred label | A + B | A: send field. B: stop deriving on the contract path; requires field | None |
| D7 | Show backend `level` and engine `retentionRiskLevel` side by side, never relabel; store extras in nullable `risk_assessments.engine_extras` | Two scales are both honest; unifying is a threshold-policy change | A | A: UI labels; optional column. B: none | **Person A**: approve the `engine_extras` column (if declined, extras are display-only; contract unchanged) |
| D8 | `enteredAt` = server-set `visit_measurements.entered_at` | Client time can be forged; completion click ≠ data entry | A | A: set in service layer, not in request schema | None |
| D9 | Shared `ML_ECG_DIR`; `imageRef` relative path; Python hashes; no `imagePhash` in v1.1 | Demo runs on one host; avoids cross-implementation hash mismatch | A + B | A: store files + `file_ref`. B: path-traversal rejection, `ecg.file_unavailable` finding | None |
| D10 | Per-trial scan, caps 200 sites / 5000 participants / 20000 visits / 2000 ECGs; no timeout/batch change | Measure before tuning | B measures, A decides if limits are exceeded | B: T21. A: config change only if T21 fails budget | None |
| D11 | Opaque UUIDs only; no names/DOB/phone/e-mail/address/free text/note/image bytes | Data minimisation; synthetic data only today | A + project owner | A + B: field allow-list in builders and schemas | **Person A / project owner**: lawful basis before any real participant data |
| D12 | `scheduled_visits` required on contract route | Removes a silent default | B | B: remove default on contract route | None |
| D13 | Python echoes `contractVersion: "1.1"` | Unambiguous in logs | B | B: constant | None |

## Final status

**Finalised (10):** D1, D2, D3, D5, D6, D8, D9, D10, D12, D13.

**Chosen but need Person A confirmation (3):**
* **D4** — reminder window (24 h), new table vs counter fallback, outcome recorder. Blocks only the `missed_reminders` feature work.
* **D7** — the optional `risk_assessments.engine_extras` column. Blocks only persistence of extras.
* **D11** — lawful basis for real data (with project owner). Blocks only non-synthetic use.

## Naming and enum conventions (identical in 01–05)
* ML envelope and `trialData`: camelCase; `features` map keys: snake_case; DB columns: snake_case; backend REST bodies: camelCase.
* Visit `status`: `scheduled | otp_pending | verified | completed | missed | cancelled`.
* `otpExceptionReason` / `reasonCode`: `device_offline | participant_unreachable | otp_delivery_failed | coordinator_override | other`.
* Reminder `outcome`: `sent | acknowledged | missed`. Reminder `channel`: `sms | ivr | call | other`.
* Finding `severity`: `low | medium | high | critical`; `details.category`: `technical_violation | suspicious_pattern | data_quality`.
* `retentionRiskLevel`: `low | medium | high`. Backend `level`: `low | medium | high | critical`.
* Versions: `contractVersion "1.1"`, patient `featureSchemaVersion "2"` (visit/reimbursement stay `"1"`).
