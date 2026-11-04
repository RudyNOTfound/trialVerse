import { Resend } from 'resend';
import { EmailDeliveryError, type EmailFailureReason, type EmailMessage, type EmailProvider } from './types';

/** Removes anything that looks like an email address or a long digit run before it can reach a log line. */
export function scrub(text: string | undefined): string | undefined {
  return text?.replace(/[^\s<>"']+@[^\s<>"']+/g, '[email]').replace(/\d{4,}/g, '[digits]').slice(0, 200);
}

function classify(statusCode: number | null | undefined, name: string | undefined): EmailFailureReason {
  if (statusCode === 401 || statusCode === 403 || name === 'missing_api_key' || name === 'invalid_api_key' || name === 'restricted_api_key') return 'provider_auth';
  if (statusCode === 429 || (statusCode != null && statusCode >= 500)) return 'provider_unavailable';
  if (statusCode != null && statusCode >= 400) return 'provider_rejected';
  // The SDK reports transport failures (DNS, refused, reset) as an error object with no HTTP status.
  if (statusCode == null) return 'network';
  return 'unknown';
}

/** Resend (https://resend.com) via the official SDK. The SDK returns `{ data, error }` instead of throwing for API errors. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly client: Resend;

  constructor(apiKey: string, private readonly from: string, private readonly timeoutMs: number) {
    if (!apiKey) throw new Error('ResendEmailProvider requires an API key');
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EmailDeliveryError('timeout')), this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        this.client.emails.send({ from: this.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
        timeout,
      ]);
      if (result.error) {
        const e = result.error as { statusCode?: number | null; name?: string; message?: string };
        throw new EmailDeliveryError(classify(e.statusCode, e.name), `${e.statusCode ?? '?'} ${e.name ?? ''} ${scrub(e.message) ?? ''}`.trim());
      }
      if (!result.data?.id) throw new EmailDeliveryError('unknown', 'provider returned no message id');
      return { id: result.data.id };
    } catch (err) {
      if (err instanceof EmailDeliveryError) throw err;
      // Network / SDK exceptions: keep only the error class, never the message (it may echo request data).
      throw new EmailDeliveryError('network', (err as Error)?.name);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
