import { randomUUID } from 'node:crypto';
import type { Actor, Ctx } from '../../context';
import { generateNumericCode, hashOtp, safeEqualHex } from '../../utils/crypto';
import { inTransaction, nowIso, updateRow } from '../../utils/db';
import { EmailDeliveryError } from '../../email/types';
import { AppError } from '../../utils/errors';
import { appendAuditEvent } from '../audit/chain';
import type { VisitDto, VisitService } from './service';

const MAX_ISSUES_PER_HOUR = 5;

export type OtpChannel = 'email' | 'demo' | 'none';

/** How (and whether) the code reached the participant. Never contains the code. */
export interface OtpDeliveryInfo {
  channel: OtpChannel;
  /** `sent`: the provider accepted the email. `demo`: development mode, nothing was sent. */
  status: 'sent' | 'demo' | null;
  /** Masked address of the participant's portal account, e.g. `a***@example.org`. */
  recipientHint: string | null;
  cooldownSeconds: number;
  /** When another code may be issued/resent; null if there is no cooldown. */
  resendAvailableAt: string | null;
}

export interface OtpIssueResult {
  otpId: string; visitId: string; expiresAt: string; maxAttempts: number;
  delivery?: OtpDeliveryInfo;
  /** Present ONLY when DEMO_OTP_ENABLED=true outside production (never together with email delivery). */
  demoOtp?: string;
}

export interface OtpStatusDto {
  id: string; visitId: string; status: string; attempts: number; maxAttempts: number;
  expiresAt: string; usedAt: string | null; createdAt: string;
  delivery: Pick<OtpDeliveryInfo, 'channel' | 'recipientHint' | 'cooldownSeconds' | 'resendAvailableAt'>;
}

interface OtpRow {
  id: string; visit_id: string; code_hash: string; status: string; attempts: number; max_attempts: number;
  expires_at: string; used_at: string | null; created_at: string;
}

type Outcome = { ok: true } | { ok: false; error: AppError };

/** `amelia.hartwell@example.org` -> `a***@example.org`. Used wherever an address is shown, never the full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function createOtpService(ctx: Ctx, visits: VisitService) {
  const { db, config } = ctx;

  /** Visits for which a send is currently in flight (single process: SQLite is single-writer). */
  const inFlight = new Set<string>();

  const channel = (): OtpChannel => (config.email.enabled ? 'email' : config.otp.demoEnabled && !config.isProduction ? 'demo' : 'none');

  const latestOtpAt = (visitId: string): string | null =>
    (db.prepare('SELECT created_at FROM otp_records WHERE visit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(visitId) as { created_at: string } | undefined)?.created_at ?? null;

  /** Seconds the caller must still wait, or 0. In email mode every OTP row is a DELIVERED one (rows are committed only after the provider accepted the message), so failed sends never start a cooldown. */
  const cooldownRemaining = (visitId: string, now: Date): number => {
    const cooldown = config.otp.resendCooldownSeconds;
    const last = latestOtpAt(visitId);
    if (!cooldown || !last) return 0;
    return Math.max(0, Math.ceil((new Date(last).getTime() + cooldown * 1000 - now.getTime()) / 1000));
  };

  const resendAvailableAt = (visitId: string): string | null => {
    const last = latestOtpAt(visitId);
    return config.otp.resendCooldownSeconds && last ? new Date(new Date(last).getTime() + config.otp.resendCooldownSeconds * 1000).toISOString() : null;
  };

  /** The participant's portal account, resolved on the backend only. */
  const accountFor = (patientId: string) =>
    db.prepare(`SELECT u.id, u.email, u.is_active, u.role FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.deleted_at IS NULL`)
      .get(patientId) as { id: string; email: string; is_active: number; role: string } | undefined;

  const requireRecipient = (patientId: string): { email: string } => {
    const u = accountFor(patientId);
    if (!u) throw AppError.otpNoRecipient('This participant has no linked portal account, so a code cannot be emailed. Link their account first.');
    if (!u.is_active) throw AppError.otpNoRecipient('This participant\'s portal account is deactivated, so a code cannot be emailed.');
    return { email: u.email };
  };

  const deliveryInfo = (visit: VisitDto, status: OtpDeliveryInfo['status']): OtpDeliveryInfo => {
    const u = accountFor(visit.patientId);
    return {
      channel: channel(), status, recipientHint: u ? maskEmail(u.email) : null,
      cooldownSeconds: config.otp.resendCooldownSeconds, resendAvailableAt: resendAvailableAt(visit.id),
    };
  };

  /** Failed deliveries are audited without the code, the address or provider detail. */
  const auditDeliveryFailure = (visit: VisitDto, actor: Actor, reason: string) => {
    try {
      inTransaction(db, () => appendAuditEvent(db, {
        actorId: actor.id, action: 'otp.delivery_failed', entityType: 'visit', entityId: visit.id,
        metadata: { patientId: visit.patientId, channel: 'email', provider: ctx.email.providerName, reason },
      }));
    } catch (err) {
      ctx.logger.error({ err }, 'Could not record otp.delivery_failed audit event');
    }
  };

  const issue = (visitId: string, actor: Actor, opts: { code?: string; enforceCooldown?: boolean; delivery?: { channel: OtpChannel; messageId?: string } } = {}): OtpIssueResult => {
    const code = opts.code ?? generateNumericCode(config.otp.length);
    const otpId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000).toISOString();

    inTransaction(db, () => {
      const visit = visits.get(visitId);
      if (!['scheduled', 'otp_pending'].includes(visit.status)) {
        throw AppError.conflict(`Cannot issue an OTP for a visit with status '${visit.status}'`);
      }
      if (opts.enforceCooldown) {
        const wait = cooldownRemaining(visitId, now);
        if (wait > 0) throw AppError.otpCooldown(wait);
      }
      const recent = (db.prepare('SELECT COUNT(*) c FROM otp_records WHERE visit_id = ? AND created_at >= ?')
        .get(visitId, new Date(now.getTime() - 3600_000).toISOString()) as { c: number }).c;
      if (recent >= MAX_ISSUES_PER_HOUR) throw AppError.rateLimited('Too many OTPs issued for this visit; try again later');

      const ts = now.toISOString();
      const superseded = db.prepare(`UPDATE otp_records SET status = 'superseded', updated_at = ? WHERE visit_id = ? AND status = 'active'`).run(ts, visitId).changes;
      db.prepare(
        `INSERT INTO otp_records (id, visit_id, code_hash, status, attempts, max_attempts, expires_at, issued_by, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
      ).run(otpId, visitId, hashOtp(code, otpId, config.otp.pepper), config.otp.maxAttempts, expiresAt, actor.id, ts, ts);
      updateRow(db, 'visits', visitId, { status: 'otp_pending', otpIssuedAt: ts });
      appendAuditEvent(db, {
        actorId: actor.id, action: 'otp.issued', entityType: 'visit', entityId: visitId,
        // Never the code or its hash. `messageId` is the provider's opaque id, useful for support tracing.
        metadata: {
          otpId, expiresAt, supersededPrevious: superseded > 0, patientId: visit.patientId,
          ...(opts.delivery ? { channel: opts.delivery.channel, ...(opts.delivery.messageId ? { messageId: opts.delivery.messageId, provider: ctx.email.providerName } : {}) } : {}),
        },
      });
    });

    const result: OtpIssueResult = { otpId, visitId, expiresAt, maxAttempts: config.otp.maxAttempts };
    // Defence in depth: config validation already forbids demo + email together, but never expose a code when email is on.
    if (config.otp.demoEnabled && !config.isProduction && !config.email.enabled) {
      ctx.demoOtp.set(visitId, { code, expiresAt });
      result.demoOtp = code;
    }
    return result;
  };

  return {
    issue,

    /**
     * Issues an OTP and DELIVERS it. This is what the HTTP route uses.
     *  1. validate (visit state, delivery configured, cooldown, hourly cap, recipient with an active portal account)
     *  2. email mode: send the code through the provider
     *  3. only after the provider accepted it, commit the OTP via `issue` (supersedes the previous one, audits, moves the visit)
     * If the send fails nothing is committed: no new OTP, the visit is unchanged and the previous code (if any) still works.
     * The plaintext code exists only in memory here and in the email; it is never logged, audited or returned.
     */
    async issueAndDeliver(visitId: string, actor: Actor): Promise<OtpIssueResult> {
      const visit = visits.get(visitId);
      if (!['scheduled', 'otp_pending'].includes(visit.status)) {
        throw AppError.conflict(`Cannot issue an OTP for a visit with status '${visit.status}'`);
      }
      const mode = channel();
      if (mode === 'none') throw AppError.otpDeliveryUnavailable(); // fail closed: never fall back to showing the code
      const wait = cooldownRemaining(visitId, new Date());
      if (wait > 0) throw AppError.otpCooldown(wait);
      const recipient = mode === 'email' ? requireRecipient(visit.patientId) : null;

      if (inFlight.has(visitId)) throw AppError.conflict('A code is already being sent for this visit. Please wait a moment.');
      inFlight.add(visitId);
      try {
        const code = generateNumericCode(config.otp.length);
        let messageId: string | undefined;
        if (mode === 'email') {
          try {
            ({ messageId } = await ctx.email.sendOtp({ to: recipient!.email, code, expiresInMinutes: Math.max(1, Math.ceil(config.otp.ttlSeconds / 60)) }));
          } catch (err) {
            auditDeliveryFailure(visit, actor, err instanceof EmailDeliveryError ? err.reason : 'unknown');
            throw AppError.otpDeliveryFailed();
          }
        }
        let result: OtpIssueResult;
        try {
          result = issue(visitId, actor, { code, enforceCooldown: true, delivery: { channel: mode, messageId } });
        } catch (err) {
          // The email went out but the commit was refused (e.g. the visit was cancelled meanwhile). The code is unusable.
          ctx.logger.warn({ visitId, mode }, 'OTP email sent but issuance was rejected afterwards');
          throw err;
        }
        result.delivery = deliveryInfo(visit, mode === 'email' ? 'sent' : 'demo');
        return result;
      } finally {
        inFlight.delete(visitId);
      }
    },

    /** Latest OTP record for a visit (metadata only, never the code). */
    status(visitId: string, actor: Actor): OtpStatusDto | null {
      visits.getForActor(visitId, actor);
      const row = db.prepare('SELECT * FROM otp_records WHERE visit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(visitId) as OtpRow | undefined;
      if (!row) return null;
      const expired = row.status === 'active' && row.expires_at <= nowIso();
      const visit = visits.get(visitId);
      const account = accountFor(visit.patientId);
      return {
        id: row.id, visitId: row.visit_id, status: expired ? 'expired' : row.status, attempts: row.attempts,
        maxAttempts: row.max_attempts, expiresAt: row.expires_at, usedAt: row.used_at, createdAt: row.created_at,
        delivery: {
          channel: channel(), recipientHint: account ? maskEmail(account.email) : null,
          cooldownSeconds: config.otp.resendCooldownSeconds, resendAvailableAt: resendAvailableAt(visitId),
        },
      };
    },

    /**
     * Verifies a submitted OTP. All state changes (attempt counters, lockout, expiry, success) and their
     * audit events are committed BEFORE any error is thrown, so failed attempts are always recorded.
     */
    verify(visitId: string, code: string, actor: Actor) {
      const visit = visits.getForActor(visitId, actor);

      const outcome = inTransaction(db, (): Outcome => {
        const now = new Date();
        const ts = now.toISOString();
        const audit = (action: string, metadata: Record<string, unknown>) =>
          appendAuditEvent(db, { actorId: actor.id, action, entityType: 'visit', entityId: visitId, metadata: { patientId: visit.patientId, ...metadata } });
        const fail = (error: AppError): Outcome => ({ ok: false, error });

        const otp = db.prepare(`SELECT * FROM otp_records WHERE visit_id = ? AND status = 'active'`).get(visitId) as OtpRow | undefined;
        if (!otp) {
          const last = db.prepare('SELECT id, status FROM otp_records WHERE visit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(visitId) as
            | { id: string; status: string } | undefined;
          const reason = !last ? 'never_issued' : last.status;
          audit('otp.verify_failed', { reason, otpId: last?.id ?? null });
          if (last?.status === 'locked') return fail(new AppError(423, 'OTP_LOCKED', 'This OTP is locked after too many failed attempts; request a new one'));
          if (last?.status === 'used') return fail(new AppError(409, 'OTP_NOT_ACTIVE', 'This OTP has already been used'));
          if (last?.status === 'expired') return fail(new AppError(410, 'OTP_EXPIRED', 'This OTP has expired; request a new one'));
          return fail(new AppError(409, 'OTP_NOT_ACTIVE', 'There is no active OTP for this visit'));
        }

        if (otp.expires_at <= ts) {
          db.prepare(`UPDATE otp_records SET status = 'expired', updated_at = ? WHERE id = ?`).run(ts, otp.id);
          audit('otp.verify_failed', { reason: 'expired', otpId: otp.id });
          return fail(new AppError(410, 'OTP_EXPIRED', 'This OTP has expired; request a new one'));
        }

        const match = safeEqualHex(hashOtp(code, otp.id, config.otp.pepper), otp.code_hash);
        if (!match) {
          const attempts = otp.attempts + 1;
          const locked = attempts >= otp.max_attempts;
          db.prepare(`UPDATE otp_records SET attempts = ?, status = ?, updated_at = ? WHERE id = ?`).run(attempts, locked ? 'locked' : 'active', ts, otp.id);
          audit('otp.verify_failed', { reason: 'incorrect_code', otpId: otp.id, attempt: attempts, maxAttempts: otp.max_attempts });
          if (locked) {
            audit('otp.locked', { otpId: otp.id, attempts });
            return fail(new AppError(423, 'OTP_LOCKED', 'Too many incorrect attempts; this OTP is now locked. Request a new one', { remainingAttempts: 0 }));
          }
          return fail(new AppError(400, 'OTP_INVALID', 'Incorrect verification code', { remainingAttempts: otp.max_attempts - attempts }));
        }

        // Success: consume the OTP exactly once and mark the visit verified.
        const used = db.prepare(`UPDATE otp_records SET status = 'used', used_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'active'`).run(ts, ts, otp.id);
        if (used.changes !== 1) return fail(new AppError(409, 'OTP_NOT_ACTIVE', 'This OTP has already been used'));
        updateRow(db, 'visits', visitId, { status: 'verified', verifiedAt: ts, verifiedBy: actor.id });
        audit('otp.verified', { otpId: otp.id, verifiedByRole: actor.role });
        audit('visit.verified', { from: visit.status, to: 'verified' });
        return { ok: true };
      });

      if (!outcome.ok) throw outcome.error;
      return visits.get(visitId);
    },

    /** Dev-only: the OTP most recently issued by this process. Returns null when unavailable. */
    getDemoOtp(visitId: string): { code: string; expiresAt: string } | null {
      if (!config.otp.demoEnabled || config.isProduction) return null;
      const entry = ctx.demoOtp.get(visitId);
      return entry && entry.expiresAt > nowIso() ? entry : null;
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;
