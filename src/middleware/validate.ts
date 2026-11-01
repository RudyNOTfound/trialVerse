import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../utils/errors';

interface Schemas { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny }

/** Validates and replaces body; parsed query/params are exposed on req.valid. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      req.valid = {};
      if (schemas.params) req.valid.params = schemas.params.parse(req.params);
      if (schemas.query) req.valid.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return next(AppError.validation('Request validation failed', details));
      }
      next(err);
    }
  };
}
