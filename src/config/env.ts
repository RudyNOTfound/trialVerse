import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_PATH: z.string().default('./data/trialguard.db'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  DEMO_OTP_ENABLED: bool.default('false'),
  /** Seconds a visit must wait before another OTP can be issued/resent. 0 disables the cooldown (tests only). */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  /** Max OTP issue requests per staff user per 15 minutes (on top of the per-visit cooldown and hourly cap). */
  OTP_ISSUE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  /** Max OTP verification requests per user per 15 minutes (on top of the per-OTP attempt lockout). */
  OTP_VERIFY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  // ---- Email delivery of OTPs (Resend) ----
  OTP_EMAIL_ENABLED: bool.default('false'),
  RESEND_API_KEY: optionalString,
  OTP_FROM_EMAIL: optionalString,
  OTP_EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_ENABLED: bool.default('true'),
  ML_RISK_ENABLED: bool.default('false'),
  ML_RISK_URL: optionalString,
  ML_INTEGRITY_ENABLED: bool.default('false'),
  ML_INTEGRITY_URL: optionalString,
  /** Risk requests (typically ~30 ms). */
  ML_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),
  /** Integrity scans over a whole trial can take seconds (a 20,000-visit scan measured 1.7-3.1 s on a laptop), so they get their own, larger budget. */
  ML_INTEGRITY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  /** Directory shared with the ML service (its ML_ECG_DIR). ECG records store paths relative to it. */
  ML_ECG_DIR: optionalString,
  ML_API_KEY: optionalString,
  RISK_RULES_OVERRIDES: optionalString,
  INTEGRITY_RULES_OVERRIDES: optionalString,
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: string;
  corsOrigins: string[];
  databasePath: string;
  jwt: { secret: string; expiresIn: string };
  bcryptRounds: number;
  otp: { pepper: string; length: number; ttlSeconds: number; maxAttempts: number; demoEnabled: boolean; resendCooldownSeconds: number };
  /** Email delivery of OTPs. When `enabled`, `apiKey` and `from` are guaranteed present (validated at load). */
  email: { enabled: boolean; apiKey?: string; from?: string; timeoutMs: number };
  rateLimit: { enabled: boolean; authMax: number; otpIssueMax: number; otpVerifyMax: number };
  ml: {
    risk: { enabled: boolean; url?: string };
    integrity: { enabled: boolean; url?: string };
    timeoutMs: number;
    integrityTimeoutMs: number;
    /** Absolute, validated at load. Undefined => ECG file references cannot be registered. */
    ecgDir?: string;
    apiKey?: string;
  };
  ruleOverrides: { risk?: unknown; integrity?: unknown };
}

function parseJson(name: string, raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid configuration: ${name} must be valid JSON`);
  }
}

/**
 * Whether synthetic demo data may be written (seeding / ML demo import) in this environment.
 * Fails CLOSED: only an unset NODE_ENV, 'development' or 'test' is allowed. 'production' is refused, and so is anything unrecognised
 * ('Production', 'prod', 'staging', ...), which `loadConfig` would reject as invalid anyway: a typo must never open the door.
 * Independent of `loadConfig` on purpose, so it can be asked by code that has no AppConfig (e.g. `importMlDemo`).
 */
export function demoDataAllowed(source: Record<string, string | undefined> = process.env): boolean {
  const v = source.NODE_ENV;
  return v === undefined || v === '' || v === 'development' || v === 'test';
}

/** Parses and validates environment variables. Throws a readable error when invalid. */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const corsOrigins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

  if (isProduction) {
    if (e.DEMO_OTP_ENABLED) throw new Error('Invalid configuration: DEMO_OTP_ENABLED must be false in production');
    if (corsOrigins.includes('*')) throw new Error('Invalid configuration: CORS_ORIGINS must not be "*" in production');
  }
  if (e.OTP_EMAIL_ENABLED) {
    const missing = [!e.RESEND_API_KEY && 'RESEND_API_KEY', !e.OTP_FROM_EMAIL && 'OTP_FROM_EMAIL'].filter(Boolean);
    if (missing.length) {
      throw new Error(`Invalid configuration: OTP_EMAIL_ENABLED=true requires ${missing.join(' and ')}. Set them, or set OTP_EMAIL_ENABLED=false.`);
    }
    // Accepts "noreply@example.org" or "TrialVerse <noreply@example.org>".
    if (!/^(?:[^<>\r\n]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(e.OTP_FROM_EMAIL!)) {
      throw new Error('Invalid configuration: OTP_FROM_EMAIL must be an email address, optionally as "Name <address>"');
    }
    // Demo mode returns OTPs in API responses; it must never be combined with real delivery.
    if (e.DEMO_OTP_ENABLED) {
      throw new Error('Invalid configuration: DEMO_OTP_ENABLED cannot be combined with OTP_EMAIL_ENABLED=true (it would expose OTPs in API responses). Disable one.');
    }
  }
  if (e.JWT_SECRET === e.OTP_PEPPER) throw new Error('Invalid configuration: OTP_PEPPER must differ from JWT_SECRET');
  if (e.ML_RISK_ENABLED && !e.ML_RISK_URL) throw new Error('Invalid configuration: ML_RISK_URL required when ML_RISK_ENABLED=true');
  for (const [name, url] of [['ML_RISK_URL', e.ML_RISK_URL], ['ML_INTEGRITY_URL', e.ML_INTEGRITY_URL]] as const) {
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(`Invalid configuration: ${name} must be an http(s) URL`);
  }
  let ecgDir: string | undefined;
  if (e.ML_ECG_DIR) {
    ecgDir = path.resolve(e.ML_ECG_DIR);
    if (!fs.existsSync(ecgDir) || !fs.statSync(ecgDir).isDirectory()) throw new Error('Invalid configuration: ML_ECG_DIR must be an existing directory');
  }
  if (e.ML_INTEGRITY_ENABLED && !e.ML_INTEGRITY_URL) {
    throw new Error('Invalid configuration: ML_INTEGRITY_URL required when ML_INTEGRITY_ENABLED=true');
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    corsOrigins,
    databasePath: e.DATABASE_PATH,
    jwt: { secret: e.JWT_SECRET, expiresIn: e.JWT_EXPIRES_IN },
    bcryptRounds: e.BCRYPT_ROUNDS,
    otp: {
      pepper: e.OTP_PEPPER,
      length: e.OTP_LENGTH,
      ttlSeconds: e.OTP_TTL_SECONDS,
      maxAttempts: e.OTP_MAX_ATTEMPTS,
      demoEnabled: e.DEMO_OTP_ENABLED,
      resendCooldownSeconds: e.OTP_RESEND_COOLDOWN_SECONDS,
    },
    email: { enabled: e.OTP_EMAIL_ENABLED, apiKey: e.RESEND_API_KEY, from: e.OTP_FROM_EMAIL, timeoutMs: e.OTP_EMAIL_TIMEOUT_MS },
    rateLimit: { enabled: e.RATE_LIMIT_ENABLED, authMax: e.AUTH_RATE_LIMIT_MAX, otpIssueMax: e.OTP_ISSUE_RATE_LIMIT_MAX, otpVerifyMax: e.OTP_VERIFY_RATE_LIMIT_MAX },
    ml: {
      risk: { enabled: e.ML_RISK_ENABLED, url: e.ML_RISK_URL },
      integrity: { enabled: e.ML_INTEGRITY_ENABLED, url: e.ML_INTEGRITY_URL },
      timeoutMs: e.ML_TIMEOUT_MS,
      integrityTimeoutMs: e.ML_INTEGRITY_TIMEOUT_MS,
      ecgDir,
      apiKey: e.ML_API_KEY,
    },
    ruleOverrides: {
      risk: parseJson('RISK_RULES_OVERRIDES', e.RISK_RULES_OVERRIDES),
      integrity: parseJson('INTEGRITY_RULES_OVERRIDES', e.INTEGRITY_RULES_OVERRIDES),
    },
  };
}
