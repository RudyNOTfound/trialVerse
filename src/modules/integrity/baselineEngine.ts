import {
  CONTRACT_VERSION, type AuditEventSummary, type IntegrityEngine, type IntegrityFinding, type IntegrityScanRequest, type IntegrityScanResult,
} from '../../ml/contracts';
import { resolveIntegrityConfig, type IntegrityRulesConfig } from './rules';

export const BASELINE_INTEGRITY_VERSION = '1.0.0';
const MIN = 60_000;

/** True if `times` (sorted ascending, ms) contain `count` entries within any `windowMs` span. */
export function hasBurst(times: number[], count: number, windowMs: number): boolean {
  for (let i = 0; i + count - 1 < times.length; i++) if (times[i + count - 1] - times[i] <= windowMs) return true;
  return false;
}

const ts = (e: AuditEventSummary) => Date.parse(e.createdAt);
const groupBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const i of items) { const k = key(i); (m.get(k) ?? m.set(k, []).get(k)!).push(i); }
  return m;
};

/** Rule-based integrity monitor over audit events and record snapshots. Pure with respect to its input. */
export class BaselineIntegrityEngine implements IntegrityEngine {
  readonly name = 'baseline-integrity-rules';
  readonly version = BASELINE_INTEGRITY_VERSION;
  readonly config: IntegrityRulesConfig;

  constructor(overrides?: unknown) {
    this.config = resolveIntegrityConfig(overrides);
  }

  async scan(req: IntegrityScanRequest): Promise<IntegrityScanResult> {
    if (req.contractVersion.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) throw new Error(`Unsupported contractVersion ${req.contractVersion}`);
    const c = this.config;
    const events = [...req.events].sort((a, b) => a.seq - b.seq);
    const out: IntegrityFinding[] = [];

    // 1. Audit chain integrity failure.
    if (c.chainBroken.enabled && !req.chain.valid) {
      out.push({
        ruleId: 'integrity.chain_broken', entityType: 'audit_chain', entityId: 'main', severity: 'critical',
        message: `Audit chain verification failed with ${req.chain.errorCount} error(s): ${req.chain.firstError?.message ?? 'unknown'}`,
        details: { errorCount: req.chain.errorCount, firstError: req.chain.firstError }, dedupeKey: `${req.chain.firstError?.type}:${req.chain.firstError?.seq}`,
      });
    }

    // 2. Duplicate reimbursement requests.
    if (c.duplicateReimbursement.enabled) {
      const live = req.reimbursements.filter((r) => ['pending', 'approved'].includes(r.status));
      for (const [, group] of groupBy(live, (r) => `${r.patientId}|${r.visitId}|${r.category}|${r.amountCents}`)) {
        if (group.length < 2) continue;
        const ids = group.map((g) => g.id).sort();
        out.push({
          ruleId: 'integrity.duplicate_reimbursement', entityType: 'reimbursement', entityId: ids[ids.length - 1], severity: 'high',
          message: `${group.length} reimbursement requests share the same patient, visit, category and amount (${group[0].amountCents / 100})`,
          details: { reimbursementIds: ids, visitId: group[0].visitId, amountCents: group[0].amountCents }, dedupeKey: ids.join(','),
        });
      }
    }

    const byVisit = groupBy(events.filter((e) => e.entityType === 'visit'), (e) => e.entityId);

    // 3 & 4. OTP brute force and suspicious "fail, fail, success" sequences.
    for (const [visitId, evs] of byVisit) {
      if (c.otpBruteForce.enabled) {
        const fails = evs.filter((e) => e.action === 'otp.verify_failed' && e.metadata.reason === 'incorrect_code').map(ts);
        if (hasBurst(fails, c.otpBruteForce.failures, c.otpBruteForce.windowMinutes * MIN)) {
          out.push({
            ruleId: 'integrity.otp_brute_force', entityType: 'visit', entityId: visitId, severity: 'high',
            message: `${c.otpBruteForce.failures}+ incorrect OTP attempts within ${c.otpBruteForce.windowMinutes} minutes (possible guessing)`,
            details: { failedAttempts: fails.length }, dedupeKey: String(new Date(fails[0]).toISOString().slice(0, 13)),
          });
        }
      }
      if (c.verifyAfterFailures.enabled) {
        const seq = evs.filter((e) => e.action === 'otp.verify_failed' && e.metadata.reason === 'incorrect_code' || e.action === 'otp.verified');
        for (let i = 0; i < seq.length; i++) {
          if (seq[i].action !== 'otp.verified') continue;
          const prior: AuditEventSummary[] = [];
          for (let j = i - 1; j >= 0 && seq[j].action === 'otp.verify_failed' && ts(seq[i]) - ts(seq[j]) <= c.verifyAfterFailures.windowMinutes * MIN; j--) prior.push(seq[j]);
          if (prior.length >= c.verifyAfterFailures.failures) {
            out.push({
              ruleId: 'integrity.verify_after_failures', entityType: 'visit', entityId: visitId, severity: 'medium',
              message: `OTP verified successfully only after ${prior.length} consecutive failed attempts`,
              details: { failedBeforeSuccess: prior.length, verifiedEventId: seq[i].id }, dedupeKey: seq[i].id,
            });
          }
        }
      }
    }

    // 5. Self-approval (segregation of duties).
    if (c.selfApproval.enabled) {
      for (const e of events) {
        if (e.action === 'reimbursement.approved' && e.actorId && e.metadata.requestedBy === e.actorId) {
          out.push({
            ruleId: 'integrity.self_approval', entityType: 'reimbursement', entityId: e.entityId, severity: 'critical',
            message: 'Reimbursement was approved by the same user who requested it',
            details: { actorId: e.actorId, eventId: e.id }, dedupeKey: e.id,
          });
        }
      }
    }

    // 6. Record churn: many updates to one record in a short span.
    if (c.recordChurn.enabled) {
      const updates = events.filter((e) => e.action.endsWith('.updated') && ['patient', 'visit', 'reimbursement', 'trial', 'action'].includes(e.entityType));
      for (const [key, evs] of groupBy(updates, (e) => `${e.entityType}|${e.entityId}`)) {
        const times = evs.map(ts);
        if (hasBurst(times, c.recordChurn.updates, c.recordChurn.windowMinutes * MIN)) {
          const [entityType, entityId] = key.split('|');
          out.push({
            ruleId: 'integrity.record_churn', entityType, entityId, severity: 'medium',
            message: `${evs.length} updates to this ${entityType} (${c.recordChurn.updates}+ within ${c.recordChurn.windowMinutes} minutes)`,
            details: { updateCount: evs.length, actors: [...new Set(evs.map((e) => e.actorId))] }, dedupeKey: new Date(times[0]).toISOString().slice(0, 13),
          });
        }
      }
    }

    // 7. Amount changed shortly before approval.
    if (c.amountChangedBeforeApproval.enabled) {
      for (const [id, evs] of groupBy(events.filter((e) => e.entityType === 'reimbursement'), (e) => e.entityId)) {
        for (const ap of evs.filter((e) => e.action === 'reimbursement.approved')) {
          const edit = evs.find((e) => e.action === 'reimbursement.updated' && 'amountCents' in e.metadata && ts(ap) - ts(e) >= 0 && ts(ap) - ts(e) <= c.amountChangedBeforeApproval.windowMinutes * MIN);
          if (edit) {
            out.push({
              ruleId: 'integrity.amount_changed_before_approval', entityType: 'reimbursement', entityId: id, severity: 'high',
              message: `Amount was edited within ${c.amountChangedBeforeApproval.windowMinutes} minutes before approval`,
              details: { amountChange: edit.metadata.amountCents, editEventId: edit.id, approvalEventId: ap.id }, dedupeKey: ap.id,
            });
          }
        }
      }
    }

    // 8. Visits past due without verification.
    if (c.unverifiedVisitOverdue.enabled) {
      const cutoff = Date.parse(req.windowEnd) - c.unverifiedVisitOverdue.hoursOverdue * 3600_000;
      for (const v of req.openVisits) {
        if (Date.parse(v.scheduledAt) <= cutoff) {
          out.push({
            ruleId: 'integrity.unverified_visit_overdue', entityType: 'visit', entityId: v.id, severity: 'low',
            message: `Visit scheduled ${v.scheduledAt} is still '${v.status}' (no OTP verification) after ${c.unverifiedVisitOverdue.hoursOverdue}h`,
            details: { status: v.status, scheduledAt: v.scheduledAt, patientId: v.patientId }, dedupeKey: v.status,
          });
        }
      }
    }

    // 9. Privilege / role changes.
    if (c.roleChange.enabled) {
      for (const e of events) {
        if (e.action === 'user.updated' && (e.metadata.changes as Record<string, unknown> | undefined)?.role) {
          out.push({
            ruleId: 'integrity.role_change', entityType: 'user', entityId: e.entityId, severity: 'medium',
            message: 'A user role was changed', details: { change: (e.metadata.changes as Record<string, unknown>).role, actorId: e.actorId }, dedupeKey: e.id,
          });
        }
      }
    }

    // 10. Login failure burst (credential stuffing / brute force).
    if (c.loginFailureBurst.enabled) {
      const times = events.filter((e) => e.action === 'auth.login_failed').map(ts);
      if (hasBurst(times, c.loginFailureBurst.failures, c.loginFailureBurst.windowMinutes * MIN)) {
        out.push({
          ruleId: 'integrity.login_failure_burst', entityType: 'auth', entityId: 'login', severity: 'medium',
          message: `${c.loginFailureBurst.failures}+ failed logins within ${c.loginFailureBurst.windowMinutes} minutes`,
          details: { failedLogins: times.length }, dedupeKey: new Date(times[0]).toISOString().slice(0, 13),
        });
      }
    }

    return {
      engine: { name: this.name, version: this.version }, windowStart: req.windowStart, windowEnd: req.windowEnd,
      findings: out, scannedAt: new Date().toISOString(), fallback: { used: false },
    };
  }
}
