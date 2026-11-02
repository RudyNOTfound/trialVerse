import { ApiError } from '@/api/client';

export interface OtpFailure { title: string; message: string; tone: 'warn' | 'error'; remainingAttempts?: number; retryAfterSeconds?: number }

/** Maps backend error codes (see docs/ARCHITECTURE.md status codes) to user-facing guidance. */
export function describeOtpError(e: unknown): OtpFailure {
  if (!(e instanceof ApiError)) return { title: 'Something went wrong', message: e instanceof Error ? e.message : 'Unexpected error', tone: 'error' };
  switch (e.code) {
    case 'OTP_INVALID': {
      const remaining = (e.details as { remainingAttempts?: number } | undefined)?.remainingAttempts;
      return { title: 'Incorrect code', message: remaining != null ? `That code is wrong. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before the OTP locks.` : 'That code is wrong.', tone: 'warn', remainingAttempts: remaining };
    }
    case 'OTP_EXPIRED': return { title: 'Code expired', message: 'This code has expired. Ask clinic staff to send a new one.', tone: 'error' };
    case 'OTP_LOCKED': return { title: 'OTP locked', message: 'Too many incorrect attempts. This code is locked; clinic staff must send a new one.', tone: 'error', remainingAttempts: 0 };
    case 'OTP_NOT_ACTIVE': return { title: 'No usable OTP', message: e.message.includes('already been used') ? 'This OTP has already been used. Each code works once.' : 'There is no active OTP for this visit. Issue a new one first.', tone: 'error' };
    // --- email delivery (staff-facing) ---
    case 'OTP_NO_RECIPIENT': return { title: 'No account to email', message: e.message, tone: 'error' };
    case 'OTP_COOLDOWN': {
      const retryAfterSeconds = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      return { title: 'Please wait before resending', message: e.message, tone: 'warn', retryAfterSeconds };
    }
    case 'OTP_DELIVERY_FAILED': return { title: 'Email could not be delivered', message: 'The code was not sent, so no new code was issued and any previous code still works. Try again in a moment. If it keeps failing, contact an administrator.', tone: 'error' };
    case 'OTP_DELIVERY_UNAVAILABLE': return { title: 'Email delivery is not set up', message: 'This server has no OTP delivery configured, so no code was issued. An administrator must enable email delivery.', tone: 'error' };
    case 'FORBIDDEN': return { title: 'Not permitted', message: 'Your account is not allowed to perform this action on this visit.', tone: 'error' };
    case 'INVALID_STATE_TRANSITION': return { title: 'Visit state does not allow this', message: e.message, tone: 'error' };
    case 'RATE_LIMITED': return { title: 'Too many requests', message: 'Please wait a moment and try again.', tone: 'warn' };
    case 'VALIDATION_ERROR': return { title: 'Invalid code', message: 'Enter the numeric code (4–10 digits).', tone: 'warn' };
    default: return { title: e.status === 0 ? 'Connection problem' : 'Request failed', message: e.message, tone: 'error' };
  }
}
