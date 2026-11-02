export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'OTP_NOT_ACTIVE'
  | 'OTP_NO_RECIPIENT'
  | 'OTP_COOLDOWN'
  | 'OTP_DELIVERY_FAILED'
  | 'OTP_DELIVERY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

/** Operational error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation(message: string, details?: unknown) { return new AppError(400, 'VALIDATION_ERROR', message, details); }
  static unauthenticated(message = 'Authentication required') { return new AppError(401, 'UNAUTHENTICATED', message); }
  static forbidden(message = 'You do not have permission to perform this action') { return new AppError(403, 'FORBIDDEN', message); }
  static notFound(what: string) { return new AppError(404, 'NOT_FOUND', `${what} not found`); }
  static conflict(message: string, details?: unknown) { return new AppError(409, 'CONFLICT', message, details); }
  static rateLimited(message: string) { return new AppError(429, 'RATE_LIMITED', message); }
  /** The participant has no active linked portal account, so there is nowhere to send the code. */
  static otpNoRecipient(message: string) { return new AppError(409, 'OTP_NO_RECIPIENT', message); }
  static otpCooldown(retryAfterSeconds: number) {
    return new AppError(429, 'OTP_COOLDOWN', `A code was sent recently. You can send another in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`, { retryAfterSeconds });
  }
  /** Generic on purpose: provider details stay in server logs. */
  static otpDeliveryFailed() { return new AppError(502, 'OTP_DELIVERY_FAILED', 'The code could not be delivered by email. No code was issued; please try again shortly.'); }
  static otpDeliveryUnavailable() {
    return new AppError(503, 'OTP_DELIVERY_UNAVAILABLE', 'OTP delivery is not configured on this server, so no code was issued. An administrator must enable email delivery.');
  }
  static invalidTransition(entity: string, from: string, to: string) {
    return new AppError(409, 'INVALID_STATE_TRANSITION', `${entity}: cannot change status from '${from}' to '${to}'`, { from, to });
  }
}
