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
    if (config.email.enabled) {
      ctx.logger.info({ provider: ctx.email.providerName, from: config.email.from, cooldownSeconds: config.otp.resendCooldownSeconds }, 'OTP delivery: email');
    } else if (config.otp.demoEnabled) {
      ctx.logger.warn('DEMO_OTP_ENABLED=true: OTPs are returned in API responses and NOT emailed. Never enable outside development.');
    } else {
      ctx.logger.warn('No OTP delivery channel is configured: issuing an OTP will fail with 503. Set OTP_EMAIL_ENABLED=true with RESEND_API_KEY and OTP_FROM_EMAIL (see README).');
    }
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
