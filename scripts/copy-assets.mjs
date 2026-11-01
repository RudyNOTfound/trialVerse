// Copies non-TS assets (SQL migrations) into dist after `tsc`.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('Copied migrations to dist/db/migrations');
