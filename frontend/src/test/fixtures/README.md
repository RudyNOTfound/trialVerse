# Fixtures

Responses captured from a real TrialVerse backend (TypeScript API + Python ML service, 2026-11-03) running the seeded demo with the
GLU-301 synthetic dataset. They are **data**, not behaviour: tests render real response shapes. All people in them are synthetic.

| File | Source request |
|---|---|
| `risk-ramesh.json` | `POST /risk/assessments` `{ entityType: "patient", entityId: <Ramesh> }` (data) |
| `scan.json` | `POST /integrity/scans` `{ windowHours: 168, trialId: <GLU-301> }` (data; alerts trimmed to 26 of 49, all site and ECG alerts kept) |
| `alerts.json` | the same alerts as returned by `GET /integrity/alerts` |
| `sites.json`, `trial.json` | `GET /trials/{id}/sites`, `GET /trials` |
| `roster.json` | a few rows of `GET /enrollments?trialId=` (Ramesh + participants of each site) |
| `scan-history.json` | `GET /audit?action=integrity.scan_completed` |

Tests derive variants (for example a fallback result) by changing named fields of these objects and say so in the test.
Refresh by re-running the demo (`npm run seed`, `npm run ml:demo-import`, ML service + backend with the ML flags) and re-saving these responses.

| `stats-sponsor.json`, `stats-operations.json` | `GET /stats/sponsor?topRisks=5`, `GET /stats/operations` (data) |
| `site-alerts-open.json` | `GET /integrity/alerts?entityType=site&status=open&sort=severity&order=desc` (data) |
