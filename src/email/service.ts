import type { AppConfig } from '../config/env';
import type { Logger } from '../config/logger';
import { renderOtpEmail } from './otpTemplate';
import { ResendEmailProvider } from './resendProvider';
import { EmailDeliveryError, type EmailProvider } from './types';

export interface EmailService {
  /** True when OTP email delivery is configured and switched on. */
  readonly enabled: boolean;
  /** Provider name for audit/log metadata (e.g. `resend`); null when disabled. */
  readonly providerName: string | null;
  /** Sends the OTP email. Resolves with the provider message id; throws `EmailDeliveryError` on any failure. */
  sendOtp(opts: { to: string; code: string; expiresInMinutes: number }): Promise<{ messageId: string }>;
}

/**
 * Builds the email service. When `OTP_EMAIL_ENABLED=true` the config must carry credentials (also enforced at config
 * load); building the service re-checks so a programmatic misconfiguration fails loudly instead of at first send.
 * A `provider` can be injected (tests, or a different vendor later).
 */
export function createEmailService(config: AppConfig, logger: Logger, provider?: EmailProvider): EmailService {
  if (!config.email.enabled) {
    return {
      enabled: false, providerName: null,
      async sendOtp() { throw new EmailDeliveryError('provider_unavailable', 'email delivery is disabled'); },
    };
  }
  const p = provider ?? (() => {
    if (!config.email.apiKey || !config.email.from) {
      throw new Error('Email delivery is enabled but RESEND_API_KEY / OTP_FROM_EMAIL are not configured');
    }
    return new ResendEmailProvider(config.email.apiKey, config.email.from, config.email.timeoutMs);
  })();

  return {
    enabled: true,
    providerName: p.name,
    async sendOtp({ to, code, expiresInMinutes }) {
      try {
        const { id } = await p.send(renderOtpEmail({ to, code, expiresInMinutes }));
        return { messageId: id };
      } catch (err) {
        const e = err instanceof EmailDeliveryError ? err : new EmailDeliveryError('unknown', (err as Error)?.name);
        // Log the failure class only. Never the recipient, the code or the message body.
        logger.error({ provider: p.name, reason: e.reason, detail: e.detail }, 'OTP email delivery failed');
        throw e;
      }
    },
  };
}
