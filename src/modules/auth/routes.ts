import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Ctx } from '../../context';
import { actorOf, authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok } from '../../utils/http';
import type { UserService } from '../users/service';
import type { AuthService } from './service';
import { loginBody, registerBody } from './schemas';

export function authRouter(ctx: Ctx, auth: AuthService, users: UserService) {
  const r = Router();
  const limiter = ctx.config.rateLimit.enabled
    ? rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: ctx.config.rateLimit.authMax,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) =>
          res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' } }),
      })
    : (_req: unknown, _res: unknown, next: () => void) => next();

  r.post('/register', limiter, validate({ body: registerBody }), asyncHandler(async (req, res) => ok(res, await auth.register(req.body), 201)));
  r.post('/login', limiter, validate({ body: loginBody }), asyncHandler(async (req, res) =>
    ok(res, await auth.login(req.body.email, req.body.password))));
  r.get('/me', authenticate(ctx), asyncHandler((req, res) => ok(res, users.getById(actorOf(req).id))));
  return r;
}
