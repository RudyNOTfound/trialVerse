import 'dotenv/config';
import { createApp } from './app';
import { buildContext } from './bootstrap';
import { loadConfig } from './config/env';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const ctx = buildContext(config);
  const app = createApp(ctx);
  const server = app.listen(config.port, () => {
    ctx.logger.info({ port: config.port, env: config.env, docs: `http://localhost:${config.port}/api/docs` }, 'TrialGuard API listening');
    if (config.otp.demoEnabled) ctx.logger.warn('DEMO_OTP_ENABLED=true: OTPs are returned in API responses. Never enable outside development.');
  });

  const shutdown = (signal: string) => {
    ctx.logger.info({ signal }, 'Shutting down');
    server.close(() => { ctx.db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => ctx.logger.error({ reason }, 'Unhandled promise rejection'));
}

main();
