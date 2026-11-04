import type { AppConfig } from './config/env';
import type { Logger } from './config/logger';
import type { DB } from './utils/db';
import type { EmailService } from './email/service';
import type { MlGateway } from './ml/gateway';

export type Role = 'admin' | 'coordinator' | 'investigator' | 'patient';
export const ROLES: Role[] = ['admin', 'coordinator', 'investigator', 'patient'];
export const STAFF_ROLES: Role[] = ['admin', 'coordinator', 'investigator'];

/** The authenticated principal performing an operation. */
export interface Actor { id: string; role: Role; email?: string }

/** In-memory, dev-only holder of the most recently issued OTP per visit (never persisted). */
export type DemoOtpStore = Map<string, { code: string; expiresAt: string }>;

/** Dependencies shared by all services. Built once per app instance. */
export interface Ctx {
  db: DB;
  config: AppConfig;
  logger: Logger;
  ml: MlGateway;
  email: EmailService;
  demoOtp: DemoOtpStore;
}
