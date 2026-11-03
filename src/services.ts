import type { Ctx } from './context';
import { createActionService } from './modules/actions/service';
import { createAuditService } from './modules/audit/service';
import { createAuthService } from './modules/auth/service';
import { createCaptureService } from './modules/capture/service';
import { createIntegrityService } from './modules/integrity/service';
import { createPatientService } from './modules/patients/service';
import { createReimbursementService } from './modules/reimbursements/service';
import { createRiskService } from './modules/risk/service';
import { createStatsService } from './modules/stats/service';
import { createTrialService } from './modules/trials/service';
import { createUserService } from './modules/users/service';
import { createOtpService } from './modules/visits/otp';
import { createVisitService } from './modules/visits/service';

/** Instantiates every domain service once. Shared by the HTTP app and the seed script. */
export function createServices(ctx: Ctx) {
  const users = createUserService(ctx);
  const patients = createPatientService(ctx);
  const visits = createVisitService(ctx, patients);
  return {
    users,
    auth: createAuthService(ctx, users),
    patients,
    capture: createCaptureService(ctx, patients),
    trials: createTrialService(ctx),
    visits,
    otp: createOtpService(ctx, visits),
    audit: createAuditService(ctx),
    reimbursements: createReimbursementService(ctx, patients),
    actions: createActionService(ctx),
    risk: createRiskService(ctx),
    integrity: createIntegrityService(ctx),
    stats: createStatsService(ctx),
  };
}
export type Services = ReturnType<typeof createServices>;
