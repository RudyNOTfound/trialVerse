import { z } from 'zod';

export interface IntegrityRulesConfig {
  duplicateReimbursement: { enabled: boolean };
  chainBroken: { enabled: boolean };
  otpBruteForce: { enabled: boolean; failures: number; windowMinutes: number };
  verifyAfterFailures: { enabled: boolean; failures: number; windowMinutes: number };
  selfApproval: { enabled: boolean };
  recordChurn: { enabled: boolean; updates: number; windowMinutes: number };
  amountChangedBeforeApproval: { enabled: boolean; windowMinutes: number };
  unverifiedVisitOverdue: { enabled: boolean; hoursOverdue: number };
  roleChange: { enabled: boolean };
  loginFailureBurst: { enabled: boolean; failures: number; windowMinutes: number };
}

export const DEFAULT_INTEGRITY_CONFIG: IntegrityRulesConfig = {
  duplicateReimbursement: { enabled: true },
  chainBroken: { enabled: true },
  otpBruteForce: { enabled: true, failures: 5, windowMinutes: 15 },
  verifyAfterFailures: { enabled: true, failures: 2, windowMinutes: 30 },
  selfApproval: { enabled: true },
  recordChurn: { enabled: true, updates: 4, windowMinutes: 60 },
  amountChangedBeforeApproval: { enabled: true, windowMinutes: 10 },
  unverifiedVisitOverdue: { enabled: true, hoursOverdue: 48 },
  roleChange: { enabled: true },
  loginFailureBurst: { enabled: true, failures: 10, windowMinutes: 15 },
};

const partialRule = z.record(z.union([z.boolean(), z.number()]));

/** Merges validated overrides (INTEGRITY_RULES_OVERRIDES) over defaults. Unknown rule keys/settings are rejected. */
export function resolveIntegrityConfig(overrides?: unknown): IntegrityRulesConfig {
  const cfg = structuredClone(DEFAULT_INTEGRITY_CONFIG) as unknown as Record<string, Record<string, boolean | number>>;
  if (overrides === undefined || overrides === null) return cfg as unknown as IntegrityRulesConfig;
  const parsed = z.record(partialRule).parse(overrides);
  for (const [rule, settings] of Object.entries(parsed)) {
    if (!cfg[rule]) throw new Error(`Unknown integrity rule in overrides: ${rule}`);
    for (const [k, v] of Object.entries(settings)) {
      if (!(k in cfg[rule]) || typeof cfg[rule][k] !== typeof v) throw new Error(`Invalid integrity setting ${rule}.${k}`);
      cfg[rule][k] = v;
    }
  }
  return cfg as unknown as IntegrityRulesConfig;
}
