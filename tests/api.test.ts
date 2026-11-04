import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { documentedRouteCount } from '../src/docs/openapi';
import { TEST_ENV, bearer, makeHarness, makeScenario } from './helpers';

describe('API conventions, validation and error handling', () => {
  const h = makeHarness();

  it('serves a health check', async () => {
    const res = await h.api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('returns a consistent 404 envelope for unknown routes', async () => {
    const res = await h.api.get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND', requestId: expect.any(String) } });
  });

  it('propagates and generates request ids', async () => {
    const generated = await h.api.get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await h.api.get('/api/v1/zzz').set('x-request-id', 'client-123');
    expect(echoed.headers['x-request-id']).toBe('client-123');
    expect(echoed.body.error.requestId).toBe('client-123');
  });

  it('rejects malformed JSON and oversized bodies with 4xx envelopes', async () => {
    const bad = await h.api.post('/api/v1/auth/login').set('content-type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const big = await h.api.post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
  });

  it('reports field-level validation details', async () => {
    const sc = await makeScenario(h);
    const res = await h.api.post('/api/v1/trials').set(bearer(sc.admin)).send({ code: '!', title: 'x', phase: 'Z' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['code', 'phase', 'sponsor', 'title']);
  });

  it('validates path ids and query parameters', async () => {
    const sc = await makeScenario(h);
    for (const url of ['/trials/123', '/visits/xyz', '/audit/1', '/actions/abc/history']) {
      expect((await h.api.get(`/api/v1${url}`).set(bearer(sc.admin))).status, url).toBe(400);
    }
    for (const q of ['page=0', 'page=abc', 'pageSize=0', 'pageSize=101', 'order=sideways', 'status=bogus']) {
      expect((await h.api.get(`/api/v1/trials?${q}`).set(bearer(sc.admin))).status, q).toBe(400);
    }
  });

  it('wraps successes and lists in the documented envelopes', async () => {
    const sc = await makeScenario(h);
    const one = await h.api.get(`/api/v1/trials/${sc.trial.id}`).set(bearer(sc.admin));
    expect(Object.keys(one.body).sort()).toEqual(['data', 'success']);
    const list = await h.api.get('/api/v1/trials?pageSize=1').set(bearer(sc.admin));
    expect(list.body).toMatchObject({ success: true, meta: { page: 1, pageSize: 1, total: expect.any(Number), totalPages: expect.any(Number) } });
    expect(Array.isArray(list.body.data)).toBe(true);
  });

  it('never leaks internals on unexpected errors', async () => {
    const sc = await makeScenario(h);
    h.ctx.db.exec('ALTER TABLE trials RENAME TO trials_gone');
    const res = await h.api.get('/api/v1/trials').set(bearer(sc.admin));
    h.ctx.db.exec('ALTER TABLE trials_gone RENAME TO trials');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(JSON.stringify(res.body)).not.toMatch(/sqlite|trials_gone|SELECT|stack/i);
  });

  it('sets security headers and no x-powered-by', async () => {
    const res = await h.api.get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('handles CORS for configured origins only', async () => {
    const cors = makeHarness({ env: { CORS_ORIGINS: 'https://app.example.org' } });
    const ok = await cors.api.get('/health').set('Origin', 'https://app.example.org');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.org');
    const bad = await cors.api.get('/health').set('Origin', 'https://evil.example.org');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document and Swagger UI', async () => {
    const doc = await h.api.get('/api/openapi.json');
    expect(doc.status).toBe(200);
    expect(doc.body.openapi).toBe('3.0.3');
    const ops = Object.values(doc.body.paths).flatMap((p) => Object.keys(p as object));
    expect(ops).toHaveLength(documentedRouteCount);
    expect(ops.length).toBeGreaterThanOrEqual(55);
    expect(doc.body.paths['/visits/{id}/otp/verify'].post.requestBody.content['application/json'].schema.properties.code).toBeDefined();
    expect(doc.body.paths['/patients'].get.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['page', 'pageSize', 'search', 'sort']));
    expect(doc.body.paths['/auth/login'].post.security).toEqual([]);
    expect(doc.body.paths['/audit/verify'].get.security).toEqual([{ bearerAuth: [] }]);
    const ui = await h.api.get('/api/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toMatch(/swagger/i);
  });

  it('documents every mounted route', async () => {
    const doc = (await h.api.get('/api/openapi.json')).body.paths as Record<string, Record<string, unknown>>;
    const documented = new Set(Object.entries(doc).flatMap(([p, m]) => Object.keys(m).map((method) => `${method.toUpperCase()} ${p.replace(/\{\w+\}/g, ':p')}`)));
    const mounted = new Set<string>();
    const mounts: Record<string, string> = {
      '/auth': '/auth', '/users': '/users', '/patients': '/patients', '/trials': '/trials', '/enrollments': '/enrollments', '/visits': '/visits',
      '/audit': '/audit', '/reimbursements': '/reimbursements', '/actions': '/actions', '/risk': '/risk', '/integrity': '/integrity', '/stats': '/stats', '/dev': '/dev',
    };
    const walk = (stack: any[], prefix: string) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const m of Object.keys(layer.route.methods)) mounted.add(`${m.toUpperCase()} ${prefix}${layer.route.path.replace(/:\w+/g, ':p')}`);
        } else if (layer.name === 'router' && layer.handle.stack) {
          const src: string = layer.regexp.source;
          const mount = Object.keys(mounts).find((k) => src.includes(k.slice(1))) ?? '';
          walk(layer.handle.stack, prefix + (src.includes('api') && !mount ? '' : mount));
        }
      }
    };
    const root = (h.app as any)._router.stack.find((l: any) => l.name === 'router' && l.regexp.source.includes('api'));
    walk(root.handle.stack, '');
    const missing = [...mounted].filter((m) => !documented.has(m.replace(/\/$/, '') || m));
    expect([...mounted].length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});

describe('configuration', () => {
  it('fails fast with a readable message when required secrets are missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(/JWT_SECRET[\s\S]*OTP_PEPPER/);
  });
  it('rejects invalid values and malformed rule overrides', () => {
    expect(() => loadConfig({ ...TEST_ENV, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...TEST_ENV, OTP_TTL_SECONDS: '1' })).toThrow(/OTP_TTL_SECONDS/);
    expect(() => loadConfig({ ...TEST_ENV, RISK_RULES_OVERRIDES: '{bad' })).toThrow(/valid JSON/);
  });
  it('parses defaults', () => {
    const c = loadConfig(TEST_ENV);
    expect(c.otp).toMatchObject({ length: 6, ttlSeconds: 300, maxAttempts: 5 });
    expect(c.ml.risk.enabled).toBe(false);
  });
});
