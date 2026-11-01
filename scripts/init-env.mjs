// Creates .env from .env.example with freshly generated random secrets. Never overwrites an existing .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}
const secret = () => randomBytes(48).toString('hex');
const out = readFileSync('.env.example', 'utf8')
  .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret()}`)
  .replace(/^OTP_PEPPER=.*$/m, `OTP_PEPPER=${secret()}`);
writeFileSync('.env', out, { mode: 0o600 });
console.log('Created .env with generated JWT_SECRET and OTP_PEPPER (development defaults, DEMO_OTP_ENABLED=true).');
