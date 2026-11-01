-- TrialGuard initial schema. All ids are UUID text; all timestamps are ISO-8601 UTC text.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','coordinator','investigator','patient')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE patients (
  id            TEXT PRIMARY KEY,
  subject_code  TEXT NOT NULL UNIQUE,                 -- pseudonymous identifier used in trials
  user_id       TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  sex           TEXT NOT NULL CHECK (sex IN ('female','male','other','unknown')),
  email         TEXT COLLATE NOCASE,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','inactive')),
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_patients_name ON patients(last_name, first_name);
CREATE INDEX idx_patients_status ON patients(status);

CREATE TABLE trials (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT,
  sponsor     TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('I','I/II','II','II/III','III','IV')),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended','completed','terminated')),
  start_date  TEXT,
  end_date    TEXT,
  created_by  TEXT REFERENCES users(id),
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_trials_status ON trials(status);

CREATE TABLE trial_sites (
  id                       TEXT PRIMARY KEY,
  trial_id                 TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  site_code                TEXT NOT NULL,
  name                     TEXT NOT NULL,
  city                     TEXT,
  country                  TEXT NOT NULL,
  principal_investigator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (trial_id, site_code)
);
CREATE INDEX idx_trial_sites_trial ON trial_sites(trial_id);

CREATE TABLE enrollments (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  trial_id      TEXT NOT NULL REFERENCES trials(id),
  trial_site_id TEXT NOT NULL REFERENCES trial_sites(id),
  status        TEXT NOT NULL DEFAULT 'screening' CHECK (status IN ('screening','enrolled','completed','withdrawn','screen_failed')),
  arm           TEXT,
  enrolled_at   TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (patient_id, trial_id)
);
CREATE INDEX idx_enrollments_trial ON enrollments(trial_id, status);
CREATE INDEX idx_enrollments_site ON enrollments(trial_site_id);

CREATE TABLE visits (
  id            TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  trial_id      TEXT NOT NULL REFERENCES trials(id),
  trial_site_id TEXT NOT NULL REFERENCES trial_sites(id),
  visit_type    TEXT NOT NULL,                       -- e.g. screening, baseline, week-4
  scheduled_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','otp_pending','verified','completed','missed','cancelled')),
  otp_issued_at TEXT,
  verified_at   TEXT,
  verified_by   TEXT REFERENCES users(id),
  completed_at  TEXT,
  notes         TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_visits_patient ON visits(patient_id, scheduled_at);
CREATE INDEX idx_visits_trial ON visits(trial_id, status);
CREATE INDEX idx_visits_status_sched ON visits(status, scheduled_at);

-- Only a keyed hash of the OTP is stored. The plaintext is never persisted.
CREATE TABLE otp_records (
  id           TEXT PRIMARY KEY,
  visit_id     TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','locked','superseded')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  issued_by    TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_otp_visit ON otp_records(visit_id, status);
-- At most one active OTP per visit.
CREATE UNIQUE INDEX uq_otp_one_active ON otp_records(visit_id) WHERE status = 'active';

-- Append-only, hash-chained audit log. seq gives a gap-detectable total order.
CREATE TABLE audit_logs (
  seq         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  actor_id    TEXT,                                   -- NULL for system events
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  metadata    TEXT NOT NULL,                          -- canonical JSON
  created_at  TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- Single-row pointer to the chain head; lets verification detect tail truncation.
CREATE TABLE audit_chain_head (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq  INTEGER NOT NULL,
  last_hash TEXT NOT NULL
);

CREATE TABLE reimbursements (
  id               TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  visit_id         TEXT NOT NULL REFERENCES visits(id),
  trial_id         TEXT NOT NULL REFERENCES trials(id),
  category         TEXT NOT NULL CHECK (category IN ('travel','meals','accommodation','parking','other')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  payment_status   TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none','unpaid','processing','paid','failed')),
  requested_by     TEXT NOT NULL REFERENCES users(id),
  reviewed_by      TEXT REFERENCES users(id),
  reviewed_at      TEXT,
  rejection_reason TEXT,
  paid_at          TEXT,
  transaction_ref  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_reimb_patient ON reimbursements(patient_id, created_at);
CREATE INDEX idx_reimb_visit ON reimbursements(visit_id);
CREATE INDEX idx_reimb_status ON reimbursements(status, payment_status);

-- Generic status history used by reimbursements and actions.
CREATE TABLE status_history (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('reimbursement','action')),
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL DEFAULT 'status',
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id),
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_status_history_entity ON status_history(entity_type, entity_id, created_at);

CREATE TABLE actions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  due_date     TEXT,
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  trial_id     TEXT REFERENCES trials(id),
  patient_id   TEXT REFERENCES patients(id),
  visit_id     TEXT REFERENCES visits(id),
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_actions_assignee ON actions(assignee_id, status);
CREATE INDEX idx_actions_due ON actions(due_date);
CREATE INDEX idx_actions_trial ON actions(trial_id);

CREATE TABLE risk_assessments (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('patient','visit','reimbursement')),
  entity_id       TEXT NOT NULL,
  score           REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  level           TEXT NOT NULL CHECK (level IN ('low','medium','high','critical')),
  triggered_rules TEXT NOT NULL,                      -- JSON array
  explanation     TEXT NOT NULL,
  engine_name     TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  fallback_used   INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1)),
  fallback_reason TEXT,
  requested_by    TEXT REFERENCES users(id),
  assessed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_risk_entity ON risk_assessments(entity_type, entity_id, assessed_at);
CREATE INDEX idx_risk_level ON risk_assessments(level);

CREATE TABLE integrity_alerts (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  message     TEXT NOT NULL,
  details     TEXT NOT NULL,                          -- JSON
  source      TEXT NOT NULL,                          -- engine name
  fingerprint TEXT NOT NULL UNIQUE,                   -- de-duplication key
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  detected_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_alerts_status ON integrity_alerts(status, severity);
CREATE INDEX idx_alerts_entity ON integrity_alerts(entity_type, entity_id);
