import type { AppConfig } from './config/env';
import { createLogger, type Logger } from './config/logger';
import type { Ctx } from './context';
import { openDatabase } from './db/connection';
import { runMigrations } from './db/migrate';
import { createEmailService } from './email/service';
import type { EmailProvider } from './email/types';
import { createMlGateway } from './ml/gateway';
import type { IntegrityModel, RiskModel } from './ml/contracts';
import { BaselineIntegrityEngine } from './modules/integrity/baselineEngine';
import { BaselineRiskEngine } from './modules/risk/baselineEngine';
import type { DB } from './utils/db';

export interface BuildOptions {
  db?: DB;
  logger?: Logger;
  /** In-process ML integration point (alternative to the HTTP model service). */
  riskModel?: RiskModel;
  integrityModel?: IntegrityModel;
  /** Inject an email provider (tests / alternative vendor). Defaults to Resend when OTP_EMAIL_ENABLED=true. */
  emailProvider?: EmailProvider;
  migrate?: boolean;
}

/** Builds the shared dependency context: DB (migrated), logger and the ML gateway. */
export function buildContext(config: AppConfig, opts: BuildOptions = {}): Ctx {
  const logger = opts.logger ?? createLogger(config.logLevel);
  const db = opts.db ?? openDatabase(config.databasePath);
  if (opts.migrate !== false) runMigrations(db);
  const ml = createMlGateway({
    config, logger,
    baselineRisk: new BaselineRiskEngine(config.ruleOverrides.risk),
    baselineIntegrity: new BaselineIntegrityEngine(config.ruleOverrides.integrity),
    riskModel: opts.riskModel, integrityModel: opts.integrityModel,
  });
  const email = createEmailService(config, logger, opts.emailProvider);
  return { db, config, logger, ml, email, demoOtp: new Map() };
}
