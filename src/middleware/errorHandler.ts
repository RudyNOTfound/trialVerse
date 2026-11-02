import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../config/logger';
import { AppError } from '../utils/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.path}`));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, _next) => {
    const requestId = req.requestId;
    if (err instanceof AppError) {
      const retryAfter = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (err.code === 'OTP_COOLDOWN' && typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
    }
    // body-parser errors (malformed JSON, payload too large)
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body', requestId } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Payload too large', requestId } });
    }
    logger.error({ err, requestId, path: req.path, method: req.method }, 'Unhandled error');
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    });
  };
}
