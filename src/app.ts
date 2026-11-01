import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import type { Ctx } from './context';
import { buildOpenApiDocument } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { actionsRouter } from './modules/actions/routes';
import { auditRouter } from './modules/audit/routes';
import { authRouter } from './modules/auth/routes';
import { integrityRouter } from './modules/integrity/routes';
import { patientsRouter } from './modules/patients/routes';
import { reimbursementsRouter } from './modules/reimbursements/routes';
import { riskRouter } from './modules/risk/routes';
import { enrollmentsRouter, trialsRouter } from './modules/trials/routes';
import { usersRouter } from './modules/users/routes';
import { devRouter, visitsRouter } from './modules/visits/routes';
import { createServices } from './services';

export const API_PREFIX = '/api/v1';

export function createApp(ctx: Ctx): Express {
  const app = express();
  const s = createServices(ctx);
  app.disable('x-powered-by');
  if (ctx.config.isProduction) app.set('trust proxy', 1);

  // Request id + access log
  app.use((req, res, next) => {
    req.requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 100) || randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      ctx.logger.info({ requestId: req.requestId, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6 }, 'request');
    });
    next();
  });

  // Swagger UI needs inline scripts, so it is mounted before the strict helmet policy.
  const openapi = buildOpenApiDocument(ctx.config);
  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'TrialGuard API' }));

  app.use(helmet());
  app.use(cors({ origin: ctx.config.corsOrigins.includes('*') ? true : ctx.config.corsOrigins, credentials: false }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    try {
      ctx.db.prepare('SELECT 1').get();
      res.json({ success: true, data: { status: 'ok', env: ctx.config.env, time: new Date().toISOString() } });
    } catch {
      res.status(503).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Database unavailable' } });
    }
  });

  const api = express.Router();
  api.use('/auth', authRouter(ctx, s.auth, s.users));
  api.use('/users', usersRouter(ctx, s.users));
  api.use('/patients', patientsRouter(ctx, s.patients));
  api.use('/trials', trialsRouter(ctx, s.trials));
  api.use('/enrollments', enrollmentsRouter(ctx, s.trials, s.patients));
  api.use('/visits', visitsRouter(ctx, s.visits, s.otp, s.patients));
  api.use('/audit', auditRouter(ctx));
  api.use('/reimbursements', reimbursementsRouter(ctx, s.reimbursements, s.patients));
  api.use('/actions', actionsRouter(ctx, s.actions));
  api.use('/risk', riskRouter(ctx, s.risk));
  api.use('/integrity', integrityRouter(ctx, s.integrity));
  if (ctx.config.otp.demoEnabled && !ctx.config.isProduction) api.use('/dev', devRouter(ctx, s.otp));
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.logger));
  return app;
}
