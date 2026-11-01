import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export interface PageMeta { page: number; pageSize: number; total: number; totalPages: number }

export function ok<T>(res: Response, data: T, status = 200, meta?: unknown) {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function paginated<T>(res: Response, data: T[], page: number, pageSize: number, total: number) {
  const meta: PageMeta = { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  return res.status(200).json({ success: true, data, meta });
}

/** Wraps async handlers so rejected promises reach the central error handler (Express 4). */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Common pagination query fields. */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'),
};

export const idParam = z.object({ id: z.string().uuid('id must be a UUID') });

export const isoDate = z.string().datetime({ offset: true, message: 'must be an ISO-8601 datetime' });
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
