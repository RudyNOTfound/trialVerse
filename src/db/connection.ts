import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../utils/db';

export function openDatabase(databasePath: string): DB {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
