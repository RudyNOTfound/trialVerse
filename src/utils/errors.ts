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
  static invalidTransition(entity: string, from: string, to: string) {
    return new AppError(409, 'INVALID_STATE_TRANSITION', `${entity}: cannot change status from '${from}' to '${to}'`, { from, to });
  }
}
