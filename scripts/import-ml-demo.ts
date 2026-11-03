// Usage: npm run ml:demo-import -- [--db <path>] [--data ml-service/generated_data]
// Adds the synthetic GLU-301 dataset (ml-service/generated_data/demo) to a database. Defaults to the application's own database
// (DATABASE_PATH), so the normal flow is:   npm run seed   then   npm run ml:demo-import   -> one database for the browser demo.
// Safe to run on a fresh or an already seeded database, and to repeat: records have deterministic UUIDs and are never duplicated or changed.
import 'dotenv/config';
import fs from 'node:fs';
import { loadConfig } from '../src/config/env';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { importMlDemo } from '../src/seed/mlDemoImport';

const config = loadConfig();
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const dbPath = arg('db', config.databasePath);
const dataDir = arg('data', 'ml-service/generated_data');

if (config.isProduction) { console.error('Refusing to import synthetic demo data when NODE_ENV=production.'); process.exit(1); }
if (!fs.existsSync(`${dataDir}/demo/visits.csv`)) {
  console.error(`No generated data in ${dataDir}/demo. Run: cd ml-service && python -m app.data_generation.generate_all`);
  process.exit(1);
}
const db = openDatabase(dbPath);
runMigrations(db);
try {
  const r = importMlDemo(db, { dataDir, bcryptRounds: config.bcryptRounds });
  if (r.alreadyImported) console.log(`Nothing to do: the ML demo data is already in ${dbPath}.`);
  else console.log(`Imported into ${dbPath}: ${r.participants} participants, ${r.visits} visits, ${r.measurements} measurement sets, ${r.ecgs} ECG references, ${r.reimbursements} paid claims.`);
  if (r.createdUsers.length) console.log(`Created demo accounts: ${r.createdUsers.join(', ')} (demo password; see \`npm run seed\`).`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
} finally { db.close(); }
