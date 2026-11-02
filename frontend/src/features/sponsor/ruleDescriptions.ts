import { formatMoney } from '@/utils/format';
import type { RuleConfig } from '@/types/api';

// Plain-language copy for each backend rule. The wording follows the rule logic in src/modules/risk/rules.ts and
// src/modules/integrity/rules.ts; the numbers always come from the live `/rules` responses.

interface RiskRuleDoc { applies: 'Visit' | 'Patient' | 'Reimbursement'; description: string; trigger: (c: RuleConfig) => string }

export const RISK_RULE_DOCS: Record<string, RiskRuleDoc> = {
  'visit.otp_failed_attempts': { applies: 'Visit', description: 'Wrong OTP codes were entered repeatedly for the same visit.', trigger: (c) => `${c.threshold}+ incorrect attempts` },
  'visit.otp_locked': { applies: 'Visit', description: 'An OTP was locked after exceeding its attempt limit.', trigger: (c) => `${c.threshold}+ locked OTP` },
  'visit.excess_otp_issues': { applies: 'Visit', description: 'An unusually high number of OTPs were issued for one visit.', trigger: (c) => `${c.threshold}+ OTPs issued` },
  'visit.missing_verification': { applies: 'Visit', description: 'The visit is past its scheduled time and still has no OTP verification.', trigger: (c) => `${c.threshold}+ hours overdue` },
  'patient.failed_otp_burst': { applies: 'Patient', description: 'A burst of failed OTP attempts across the patient’s visits.', trigger: (c) => `${c.threshold}+ failures in 24 hours` },
  'patient.visit_frequency': { applies: 'Patient', description: 'More visits scheduled in a week than is typical.', trigger: (c) => `${c.threshold}+ visits in 7 days` },
  'patient.missed_visits': { applies: 'Patient', description: 'The patient has repeatedly missed visits.', trigger: (c) => `${c.threshold}+ missed in 90 days` },
  'patient.unverified_visits': { applies: 'Patient', description: 'Several past visits remain without OTP verification.', trigger: (c) => `${c.threshold}+ unverified past visits` },
  'patient.duplicate_reimbursements': { applies: 'Patient', description: 'The patient submitted duplicate reimbursement requests.', trigger: (c) => `${c.threshold}+ duplicates` },
  'patient.reimbursement_volume': { applies: 'Patient', description: 'Total amount claimed recently is unusually high.', trigger: (c) => `${formatMoney(c.threshold)} claimed in 30 days` },
  'reimbursement.duplicate': { applies: 'Reimbursement', description: 'Another request exists for the same visit, category and amount.', trigger: (c) => `${c.threshold}+ matching request` },
  'reimbursement.unverified_visit': { applies: 'Reimbursement', description: 'The claim is for a visit that was never OTP-verified.', trigger: () => 'Whenever the visit is unverified' },
  'reimbursement.amount_outlier': { applies: 'Reimbursement', description: 'The amount is far above the average for its category, or above an absolute limit.', trigger: (c) => `${c.threshold}× category average${typeof c.params?.absoluteCents === 'number' ? ` or ${formatMoney(c.params.absoluteCents)}+` : ''}` },
  'reimbursement.rapid_submission': { applies: 'Reimbursement', description: 'The patient submitted many requests in a short time.', trigger: (c) => `${c.threshold}+ requests in 24 hours` },
};

interface IntegrityRuleDoc { title: string; description: string; severity: string; settings: Record<string, string> }

export const INTEGRITY_RULE_DOCS: Record<string, IntegrityRuleDoc> = {
  chainBroken: { title: 'Audit chain broken', description: 'The hash chain failed verification, which indicates altered, removed or inserted audit events.', severity: 'Critical', settings: {} },
  duplicateReimbursement: { title: 'Duplicate reimbursement', description: 'Multiple requests share the same patient, visit, category and amount.', severity: 'High', settings: {} },
  otpBruteForce: { title: 'OTP guessing', description: 'Many incorrect OTP codes in a short period on one visit.', severity: 'High', settings: { failures: 'failed attempts', windowMinutes: 'minute window' } },
  verifyAfterFailures: { title: 'Verified after failures', description: 'A visit was verified right after several failed attempts (fail, fail, success pattern).', severity: 'Medium', settings: { failures: 'failed attempts', windowMinutes: 'minute window' } },
  selfApproval: { title: 'Self-approval', description: 'A reimbursement was approved by the same person who requested it.', severity: 'Critical', settings: {} },
  recordChurn: { title: 'Record churn', description: 'The same record was updated many times in a short period.', severity: 'Medium', settings: { updates: 'updates', windowMinutes: 'minute window' } },
  amountChangedBeforeApproval: { title: 'Amount changed before approval', description: 'A claim amount was edited shortly before it was approved.', severity: 'High', settings: { windowMinutes: 'minute window' } },
  unverifiedVisitOverdue: { title: 'Overdue unverified visit', description: 'A visit is well past its scheduled time with no OTP verification.', severity: 'Low', settings: { hoursOverdue: 'hours overdue' } },
  roleChange: { title: 'Role change', description: 'A user’s role was changed.', severity: 'Medium', settings: {} },
  loginFailureBurst: { title: 'Login failure burst', description: 'Many failed login attempts in a short period.', severity: 'Medium', settings: { failures: 'failed logins', windowMinutes: 'minute window' } },
};
