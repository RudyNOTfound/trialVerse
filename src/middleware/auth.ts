import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Actor, Ctx, Role } from '../context';
import { AppError } from '../utils/errors';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    requestId?: string;
    valid?: { query?: any; params?: any };
  }
}

export interface JwtPayload { sub: string; role: Role }

export function signToken(ctx: Ctx, user: { id: string; role: Role }): string {
  return jwt.sign({ role: user.role }, ctx.config.jwt.secret, {
    subject: user.id,
    expiresIn: ctx.config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

/** Verifies the bearer token and re-loads the user so deactivation / role changes take effect immediately. */
export function authenticate(ctx: Ctx): RequestHandler {
  const find = ctx.db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?');
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(AppError.unauthenticated());
    try {
      const payload = jwt.verify(header.slice(7), ctx.config.jwt.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      const user = find.get(payload.sub) as { id: string; email: string; role: Role; is_active: number } | undefined;
      if (!user || !user.is_active) return next(AppError.unauthenticated('Account is not active'));
      req.actor = { id: user.id, role: user.role, email: user.email };
      next();
    } catch {
      next(AppError.unauthenticated('Invalid or expired token'));
    }
  };
}

/** Role gate. Must come after `authenticate`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) return next(AppError.unauthenticated());
    if (!roles.includes(req.actor.role)) return next(AppError.forbidden());
    next();
  };
}

export function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}
