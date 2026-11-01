import type Database from 'better-sqlite3';

export type DB = Database.Database;

const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Converts a snake_case DB row into a camelCase API object.
 * `json` lists columns holding JSON text; `is_*` columns become booleans.
 */
export function mapRow<T = Record<string, unknown>>(row: Record<string, unknown> | undefined, json: string[] = []): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    let value = v;
    if (json.includes(k) && typeof v === 'string') value = JSON.parse(v);
    else if (k.startsWith('is_')) value = Boolean(v);
    out[toCamel(k)] = value;
  }
  return out as T;
}

export function mapRows<T = Record<string, unknown>>(rows: Record<string, unknown>[], json: string[] = []): T[] {
  return rows.map((r) => mapRow<T>(r, json) as T);
}

/** Runs fn inside an IMMEDIATE transaction (takes the write lock up front; nests via savepoints). */
export function inTransaction<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** Builds a safe "ORDER BY" from a whitelist; throws away anything not whitelisted. */
export function orderBy(sort: string | undefined, order: 'asc' | 'desc', allowed: Record<string, string>, fallback: string): string {
  const col = (sort && allowed[sort]) || fallback;
  return `ORDER BY ${col} ${order === 'asc' ? 'ASC' : 'DESC'}`;
}

export const nowIso = () => new Date().toISOString();

const toSnake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Returns the keys of `patch` whose value is defined and differs from `existing`. */
export function changedKeys(existing: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => patch[k] !== undefined && patch[k] !== existing[k]);
}

/**
 * UPDATE helper for validated camelCase changes. Column names derive from keys that
 * originate in zod schemas (never raw user input), and are re-checked against a strict pattern.
 */
export function updateRow(db: DB, table: string, id: string, changes: Record<string, unknown>): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) return;
  const cols = keys.map((k) => {
    const c = toSnake(k);
    if (!/^[a-z_]+$/.test(c)) throw new Error(`Unsafe column name: ${k}`);
    return c;
  });
  const values = keys.map((k) => {
    const v = changes[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v;
  });
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
}
