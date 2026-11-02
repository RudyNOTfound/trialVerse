import type { DB } from './db';

/**
 * Batched name lookups used to embed readable names in API responses (patientName, trialCode, ...).
 * Each call issues ONE `WHERE id IN (...)` query for the distinct ids on the page, so a list of N rows costs a
 * constant number of extra queries instead of N. Table/column names are constants, never user input.
 */
const uniq = (ids: Array<string | null | undefined>): string[] => [...new Set(ids.filter((x): x is string => !!x))];

function load<T extends { id: string }>(db: DB, select: string, table: string, ids: string[]): Map<string, T> {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`SELECT ${select} FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as T[];
  return new Map(rows.map((r) => [r.id, r]));
}

export interface Lookups {
  patients(ids: Array<string | null | undefined>): Map<string, { id: string; name: string; code: string }>;
  trials(ids: Array<string | null | undefined>): Map<string, { id: string; code: string; title: string }>;
  sites(ids: Array<string | null | undefined>): Map<string, { id: string; name: string }>;
  users(ids: Array<string | null | undefined>): Map<string, { id: string; name: string; role: string }>;
}

/**
 * Human-readable label for entities referenced by (entityType, entityId) pairs, e.g. in risk assessments and alerts.
 * Patient -> "Amelia Hartwell"; visit -> "Week 4 · Amelia Hartwell"; reimbursement -> "Amelia Hartwell · travel".
 * Unknown types (audit_chain, auth, user...) get no label. At most one query per entity type.
 */
export function entityLabels(db: DB, refs: Array<{ entityType: string; entityId: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const idsOf = (type: string) => uniq(refs.filter((r) => r.entityType === type).map((r) => r.entityId));
  const run = (sql: (marks: string) => string, ids: string[], type: string) => {
    if (ids.length === 0) return;
    const rows = db.prepare(sql(ids.map(() => '?').join(','))).all(...ids) as Array<{ id: string; label: string }>;
    for (const r of rows) out.set(`${type}:${r.id}`, r.label);
  };
  run((m) => `SELECT id, first_name || ' ' || last_name AS label FROM patients WHERE id IN (${m})`, idsOf('patient'), 'patient');
  run((m) => `SELECT v.id, v.visit_type || ' · ' || p.first_name || ' ' || p.last_name AS label FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id IN (${m})`, idsOf('visit'), 'visit');
  run((m) => `SELECT r.id, p.first_name || ' ' || p.last_name || ' · ' || r.category AS label FROM reimbursements r JOIN patients p ON p.id = r.patient_id WHERE r.id IN (${m})`, idsOf('reimbursement'), 'reimbursement');
  return out;
}

export function createLookups(db: DB): Lookups {
  return {
    patients: (ids) => load(db, `id, first_name || ' ' || last_name AS name, subject_code AS code`, 'patients', uniq(ids)),
    trials: (ids) => load(db, 'id, code, title', 'trials', uniq(ids)),
    sites: (ids) => load(db, 'id, name', 'trial_sites', uniq(ids)),
    users: (ids) => load(db, 'id, full_name AS name, role', 'users', uniq(ids)),
  };
}
