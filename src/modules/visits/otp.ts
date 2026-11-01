import { randomUUID } from 'node:crypto';
import type { Actor, Ctx } from '../../context';
import { generateNumericCode, hashOtp, safeEqualHex } from '../../utils/crypto';
import { inTransaction, nowIso, updateRow } from '../../utils/db';
import { AppError } from '../../utils/errors';
import { appendAuditEvent } from '../audit/chain';
import type { VisitService } from './service';

const MAX_ISSUES_PER_HOUR = 5;

export interface OtpIssueResult {
  otpId: string; visitId: string; expiresAt: string; maxAttempts: number;
  /** Present ONLY when DEMO_OTP_ENABLED=true (never in production). */
  demoOtp?: string;
}

export interface OtpStatusDto {
  id: string; visitId: string; status: string; attempts: number; maxAttempts: number;
  expiresAt: string; usedAt: string | null; createdAt: string;
}

interface OtpRow {
  id: string; visit_id: string; code_hash: string; status: string; attempts: number; max_attempts: number;
  expires_at: string; used_at: string | null; created_at: string;
}

type Outcome = { ok: true } | { ok: false; error: AppError };

export function createOtpService(ctx: Ctx, visits: VisitService) {
  const { db, config } = ctx;

  return {
    /**
     * Issues a fresh OTP for a visit. Any previously active OTP is superseded.
     * Only an HMAC of the code is stored. `opts.code` exists for seeding/tests and is never reachable from the API.
     */
    issue(visitId: string, actor: Actor, opts: { code?: string } = {}): OtpIssueResult {
      const code = opts.code ?? generateNumericCode(config.otp.length);
      const otpId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.otp.ttlSeconds * 1000).toISOString();

      inTransaction(db, () => {
        const visit = visits.get(visitId);
        if (!['scheduled', 'otp_pending'].includes(visit.status)) {
          throw AppError.conflict(`Cannot issue an OTP for a visit with status '${visit.status}'`);
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
          metadata: { otpId, expiresAt, supersededPrevious: superseded > 0, patientId: visit.patientId },
        });
      });

      const result: OtpIssueResult = { otpId, visitId, expiresAt, maxAttempts: config.otp.maxAttempts };
      if (config.otp.demoEnabled && !config.isProduction) {
        ctx.demoOtp.set(visitId, { code, expiresAt });
        result.demoOtp = code;
      }
      return result;
    },

    /** Latest OTP record for a visit (metadata only, never the code). */
    status(visitId: string, actor: Actor): OtpStatusDto | null {
      visits.getForActor(visitId, actor);
      const row = db.prepare('SELECT * FROM otp_records WHERE visit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(visitId) as OtpRow | undefined;
      if (!row) return null;
      const expired = row.status === 'active' && row.expires_at <= nowIso();
      return {
        id: row.id, visitId: row.visit_id, status: expired ? 'expired' : row.status, attempts: row.attempts,
        maxAttempts: row.max_attempts, expiresAt: row.expires_at, usedAt: row.used_at, createdAt: row.created_at,
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
