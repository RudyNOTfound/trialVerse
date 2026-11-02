/** Provider-agnostic email contract. Swap the provider by implementing `EmailProvider`; nothing else depends on Resend. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Resolves with the provider's message id once the provider has ACCEPTED the message. Throws `EmailDeliveryError` otherwise. */
  send(message: EmailMessage, opts?: { signal?: AbortSignal }): Promise<{ id: string }>;
}

export type EmailFailureReason = 'timeout' | 'provider_auth' | 'provider_rejected' | 'provider_unavailable' | 'network' | 'unknown';

/**
 * Delivery failure with a coarse, safe reason. `detail` is for server logs only (already scrubbed of addresses);
 * it is never returned to API clients.
 */
export class EmailDeliveryError extends Error {
  constructor(public readonly reason: EmailFailureReason, public readonly detail?: string) {
    super(`Email delivery failed: ${reason}`);
    this.name = 'EmailDeliveryError';
  }
}
