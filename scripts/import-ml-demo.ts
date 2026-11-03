// Usage: npm run ml:demo-import -- [--db data/ml-demo.db] [--data ml-service/generated_data]
// Loads the synthetic GLU-301 dataset into a NEW, empty database. It refuses to write into a database that already has patients.
import fs from 'node:fs';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { importMlDemo } from '../src/seed/mlDemoImport';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const dbPath = arg('db', 'data/ml-demo.db');
const dataDir = arg('data', 'ml-service/generated_data');

if (!fs.existsSync(`${dataDir}/demo/visits.csv`)) {
  console.error(`No generated data in ${dataDir}/demo. Run: cd ml-service && python -m app.data_generation.generate_all`);
  process.exit(1);
}
const db = openDatabase(dbPath);
runMigrations(db);
try {
  const r = importMlDemo(db, { dataDir });
  console.log(`Imported into ${dbPath}: ${r.participants} participants, ${r.visits} visits, ${r.measurements} measurement sets, ${r.ecgs} ECG references.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
} finally { db.close(); }
