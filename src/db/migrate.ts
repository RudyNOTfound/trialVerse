import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/env';
import { openDatabase } from './connection';
import type { DB } from '../utils/db';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction. Returns applied names. */
export function runMigrations(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
    ran.push(file);
  }
  return ran;
}

if (require.main === module) {
  try { require('dotenv').config(); } catch { /* optional */ }
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const ran = runMigrations(db);
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date.');
  db.close();
}
