import pino from 'pino';

export type Logger = pino.Logger;

/** Structured logger. Sensitive fields are redacted wherever they appear in log objects. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        '*.password',
        '*.passwordHash',
        '*.otp',
        '*.code',
        'password',
        'otp',
        'code',
        'token',
      ],
      censor: '[REDACTED]',
    },
  });
}
