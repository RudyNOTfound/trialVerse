-- 002_ml_inputs.sql
-- Data the ML contract v1.1 needs (see ml-service/docs/phase6 and docs/ML_INTEGRATION.md).
-- Purely additive: nullable columns and new tables only. No existing row is changed, so every existing record stays valid
-- and "unknown" is represented as NULL (never as 0 / '' / a guessed value).

-- ---------------------------------------------------------------- sites
-- IANA timezone (e.g. 'Asia/Kolkata'). No default: a site without one is left out of the integrity scan rather than guessed.
ALTER TABLE trial_sites ADD COLUMN timezone TEXT;
-- Explicit mapping from a site to the category the retention model was trained on (e.g. 'SITE-A'). No value whitelist here:
-- the Python service owns the set of known categories and refuses unknown ones.
ALTER TABLE trial_sites ADD COLUMN ml_site_category TEXT;
CREATE UNIQUE INDEX uq_trial_sites_ml_category ON trial_sites(trial_id, ml_site_category) WHERE ml_site_category IS NOT NULL;

-- ---------------------------------------------------------------- participants / enrollments
-- Coarse travel distance from the participant's home to the site (km). Not an address.
ALTER TABLE enrollments ADD COLUMN distance_to_site_km REAL
  CHECK (distance_to_site_km IS NULL OR (distance_to_site_km >= 0 AND distance_to_site_km <= 2000));
-- Unknown is NULL; it is not the same as "no".
ALTER TABLE patients ADD COLUMN daily_wage_worker INTEGER
  CHECK (daily_wage_worker IS NULL OR daily_wage_worker IN (0, 1));

-- ---------------------------------------------------------------- OTP exceptions
-- A visit that was completed WITHOUT OTP verification. The visit keeps verified_at = NULL (it is never marked verified);
-- this row records why, who decided, and when. The free-text note stays here: it is never sent to ML or hashed into audit metadata.
CREATE TABLE visit_otp_exceptions (
  id          TEXT PRIMARY KEY,
  visit_id    TEXT NOT NULL UNIQUE REFERENCES visits(id),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('device_offline','participant_unreachable','otp_delivery_failed','coordinator_override','other')),
  note        TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- reminders
-- One row per reminder sent to a participant. The outcome is written explicitly (never computed at read time), so the
-- derived feature `missed_reminders` is reproducible from the log.
CREATE TABLE visit_reminders (
  id                  TEXT PRIMARY KEY,
  enrollment_id       TEXT NOT NULL REFERENCES enrollments(id),
  visit_id            TEXT REFERENCES visits(id),
  channel             TEXT NOT NULL CHECK (channel IN ('sms','ivr','call','other')),
  sent_at             TEXT NOT NULL,
  outcome             TEXT NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent','acknowledged','missed')),
  acknowledged_at     TEXT,
  outcome_recorded_at TEXT,
  recorded_by         TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  -- a resolved outcome carries the time it was recorded; an unresolved one does not
  CHECK ((outcome = 'sent') = (outcome_recorded_at IS NULL)),
  -- acknowledged_at exists exactly when the reminder was acknowledged
  CHECK ((outcome = 'acknowledged') = (acknowledged_at IS NOT NULL))
);
CREATE INDEX idx_reminders_enrollment ON visit_reminders(enrollment_id, outcome);

-- ---------------------------------------------------------------- adverse events
-- Existence of a report is the signal (`side_effects_reported`); no free text is stored here or sent to ML.
CREATE TABLE adverse_event_reports (
  id            TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  visit_id      TEXT REFERENCES visits(id),
  reported_at   TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_adverse_events_enrollment ON adverse_event_reports(enrollment_id);

-- ---------------------------------------------------------------- visit measurements
-- Structural checks only (positive numbers). Implausible-but-possible values must stay storable: flagging them is the
-- integrity engine's job. performed_at is the device time at the visit; entered_at is SERVER-set when the row is saved
-- (a client-supplied entry time could be forged), both as UTC instants.
CREATE TABLE visit_measurements (
  visit_id      TEXT PRIMARY KEY REFERENCES visits(id),
  performed_at  TEXT NOT NULL,
  entered_at    TEXT NOT NULL,
  entered_by    TEXT NOT NULL REFERENCES users(id),
  systolic_bp   REAL CHECK (systolic_bp  IS NULL OR systolic_bp  > 0),
  diastolic_bp  REAL CHECK (diastolic_bp IS NULL OR diastolic_bp > 0),
  heart_rate    REAL CHECK (heart_rate   IS NULL OR heart_rate   > 0),
  weight_kg     REAL CHECK (weight_kg    IS NULL OR weight_kg    > 0),
  glucose_mg_dl REAL CHECK (glucose_mg_dl IS NULL OR glucose_mg_dl > 0)
);

-- ---------------------------------------------------------------- ECG records
-- A reference to an ECG image file in the shared ML_ECG_DIR (relative path, never absolute). Different records may point
-- at the same file: re-used ECGs are precisely what the integrity engine looks for, so file_ref is NOT unique.
-- file_sha256 is the backend's own file-integrity record; it is not sent to the ML service.
CREATE TABLE visit_ecgs (
  id          TEXT PRIMARY KEY,
  visit_id    TEXT NOT NULL UNIQUE REFERENCES visits(id),
  file_ref    TEXT NOT NULL CHECK (length(file_ref) BETWEEN 1 AND 500),
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  recorded_at TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_visit_ecgs_file ON visit_ecgs(file_ref);
