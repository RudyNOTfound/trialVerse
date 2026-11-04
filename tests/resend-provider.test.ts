import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResendEmailProvider, scrub } from '../src/email/resendProvider';
import { renderOtpEmail } from '../src/email/otpTemplate';
import { EmailDeliveryError } from '../src/email/types';

/**
 * Exercises the REAL Resend SDK wrapper against a local stub server (the SDK honours RESEND_BASE_URL).
 * No network, no credentials. It proves the request we send and how every failure class is mapped.
 */
describe('ResendEmailProvider (real SDK, stubbed HTTP)', () => {
  let server: http.Server;
  let received: Array<{ url: string; auth: string | undefined; body: any }> = [];
  let behaviour: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => undefined;
  const previous = process.env.RESEND_BASE_URL;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
        behaviour(req, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.RESEND_BASE_URL; else process.env.RESEND_BASE_URL = previous;
    server.closeAllConnections(); // the timeout test leaves a request hanging
    await new Promise<void>((r) => server.close(() => r()));
  });

  const reply = (status: number, json: unknown) => (_q: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
  };
  const msg = renderOtpEmail({ to: 'participant@example.org', code: '123456', expiresInMinutes: 5 });
  const provider = (timeoutMs = 2000) => new ResendEmailProvider('re_test_key_123', 'TrialVerse <noreply@example.org>', timeoutMs);
  const failureOf = async (p: ResendEmailProvider) => { try { await p.send(msg); } catch (e) { return e as EmailDeliveryError; } throw new Error('expected a failure'); };

  it('sends the documented request and returns the provider message id', async () => {
    received = []; behaviour = reply(200, { id: 'em_abc123' });
    expect(await provider().send(msg)).toEqual({ id: 'em_abc123' });
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/emails');
    expect(received[0]!.auth).toBe('Bearer re_test_key_123');
    expect(received[0]!.body).toMatchObject({ from: 'TrialVerse <noreply@example.org>', to: ['participant@example.org'], subject: 'Your TrialVerse verification code' });
    expect(received[0]!.body.html).toContain('123456');
    expect(received[0]!.body.text).toContain('123456');
  });

  it.each([
    [401, 'invalid_api_key', 'provider_auth'],
    [403, 'validation_error', 'provider_auth'],
    [422, 'validation_error', 'provider_rejected'],
    [429, 'rate_limit_exceeded', 'provider_unavailable'],
    [500, 'internal_server_error', 'provider_unavailable'],
  ])('maps HTTP %i (%s) to %s', async (status, name, reason) => {
    behaviour = reply(status, { statusCode: status, name, message: `rejected for participant@example.org with code 123456` });
    const e = await failureOf(provider());
    expect(e).toBeInstanceOf(EmailDeliveryError);
    expect(e.reason).toBe(reason);
    // detail is for server logs only and must be scrubbed of addresses and digit runs
    expect(e.detail).not.toContain('participant@example.org');
    expect(e.detail).not.toContain('123456');
  });

  it('times out on a hanging provider instead of blocking issuance', async () => {
    behaviour = () => undefined; // never replies
    const started = Date.now();
    const e = await failureOf(provider(300));
    expect(e.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps connection failures to "network" without leaking the underlying message', async () => {
    const dead = http.createServer(); await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port; await new Promise<void>((r) => dead.close(() => r()));
    const saved = process.env.RESEND_BASE_URL; process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const e = await failureOf(provider());
      expect(e.reason).toBe('network');
      expect(e.detail ?? '').not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    } finally { process.env.RESEND_BASE_URL = saved; }
  });

  it('treats a 200 without a message id as a failure', async () => {
    behaviour = reply(200, {});
    expect((await failureOf(provider())).reason).toBe('unknown');
  });

  it('requires an API key', () => {
    expect(() => new ResendEmailProvider('', 'a@b.co', 1000)).toThrow(/API key/);
  });
});

describe('email template and scrubbing', () => {
  it('renders both parts, contains the code and expiry, and escapes HTML', () => {
    const m = renderOtpEmail({ to: 'a@b.co', code: '482913', expiresInMinutes: 5 });
    expect(m.text).toContain('482913');
    expect(m.text).toMatch(/expires in 5 minutes/);
    expect(m.html).toContain('482913');
    expect(m.html).toContain('TrialVerse');
    const evil = renderOtpEmail({ to: 'a@b.co', code: '<script>x</script>', expiresInMinutes: 5 });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });
  it('scrubs addresses and long digit runs', () => {
    expect(scrub('bad to x@y.org code 123456 id 12')).toBe('bad to [email] code [digits] id 12');
    expect(scrub(undefined)).toBeUndefined();
  });
});
