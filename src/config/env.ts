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
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_ENABLED: bool.default('true'),
  ML_RISK_ENABLED: bool.default('false'),
  ML_RISK_URL: optionalString,
  ML_INTEGRITY_ENABLED: bool.default('false'),
  ML_INTEGRITY_URL: optionalString,
  ML_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),
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
  otp: { pepper: string; length: number; ttlSeconds: number; maxAttempts: number; demoEnabled: boolean };
  rateLimit: { enabled: boolean; authMax: number };
  ml: {
    risk: { enabled: boolean; url?: string };
    integrity: { enabled: boolean; url?: string };
    timeoutMs: number;
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
  if (e.JWT_SECRET === e.OTP_PEPPER) throw new Error('Invalid configuration: OTP_PEPPER must differ from JWT_SECRET');
  if (e.ML_RISK_ENABLED && !e.ML_RISK_URL) throw new Error('Invalid configuration: ML_RISK_URL required when ML_RISK_ENABLED=true');
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
    },
    rateLimit: { enabled: e.RATE_LIMIT_ENABLED, authMax: e.AUTH_RATE_LIMIT_MAX },
    ml: {
      risk: { enabled: e.ML_RISK_ENABLED, url: e.ML_RISK_URL },
      integrity: { enabled: e.ML_INTEGRITY_ENABLED, url: e.ML_INTEGRITY_URL },
      timeoutMs: e.ML_TIMEOUT_MS,
      apiKey: e.ML_API_KEY,
    },
    ruleOverrides: {
      risk: parseJson('RISK_RULES_OVERRIDES', e.RISK_RULES_OVERRIDES),
      integrity: parseJson('INTEGRITY_RULES_OVERRIDES', e.INTEGRITY_RULES_OVERRIDES),
    },
  };
}
