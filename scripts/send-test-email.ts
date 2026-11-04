// Sends ONE real test email through the configured provider, to verify credentials and the sender domain.
// Usage:  npm run email:test -- you@example.org
// It uses the same configuration as the server (.env) and requires OTP_EMAIL_ENABLED=true. The message contains a
// harmless placeholder code, never a real OTP.
import 'dotenv/config';
import { loadConfig } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import { createEmailService } from '../src/email/service';
import { EmailDeliveryError } from '../src/email/types';

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: npm run email:test -- recipient@example.org');
  process.exit(2);
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    if (!config.email.enabled) {
      console.error('OTP_EMAIL_ENABLED is not true in your .env, so nothing was sent. Set OTP_EMAIL_ENABLED=true, RESEND_API_KEY and OTP_FROM_EMAIL first.');
      process.exit(1);
    }
    const email = createEmailService(config, createLogger('warn'));
    const { messageId } = await email.sendOtp({ to: to!, code: '000000', expiresInMinutes: 5 });
    console.log(`Accepted by ${email.providerName}. Message id: ${messageId}`);
    console.log(`Check the inbox of ${to} (and spam). The email shows the placeholder code 000000.`);
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      console.error(`Delivery failed (${err.reason})${err.detail ? `: ${err.detail}` : ''}`);
      if (err.reason === 'provider_auth') console.error('The API key was rejected. Check RESEND_API_KEY.');
      if (err.reason === 'provider_rejected') console.error('Resend rejected the message. Common cause: OTP_FROM_EMAIL uses a domain you have not verified in Resend, or (on the free test sender) you are sending to an address other than your own account email.');
    } else {
      console.error((err as Error).message);
    }
    process.exit(1);
  }
}

void main();
