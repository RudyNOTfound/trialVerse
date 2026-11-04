import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { http } from '@/api/client';

/**
 * Replaces only the TRANSPORT of the real axios client, so tests still run through the real API modules, the real `unwrap` helpers and
 * the real response interceptors (error normalisation, 401 handling). Responses come from fixtures captured from the real backend.
 */
export interface FakeRequest { method: string; path: string; params?: Record<string, unknown>; body?: unknown }
export interface FakeReply { status?: number; data?: unknown; meta?: unknown; error?: { code: string; message: string; details?: unknown }; networkError?: boolean }
type Handler = FakeReply | ((req: FakeRequest) => FakeReply | Promise<FakeReply>);

const paged = <T,>(items: T[], page = 1, pageSize = 20): FakeReply => ({ data: items.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) } });
export const page = paged;

export function installFakeApi(routes: Record<string, Handler>) {
  const calls: FakeRequest[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    return { method: method!.toUpperCase(), re: new RegExp(`^${pattern!.replace(/:[a-zA-Z]+/g, '[^/]+')}$`), handler };
  });
  const original = http.defaults.adapter;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? 'get').toUpperCase();
    const path = (config.url ?? '').split('?')[0]!;
    const req: FakeRequest = { method, path, params: config.params, body: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data };
    calls.push(req);
    const route = compiled.find((r) => r.method === method && r.re.test(path));
    const reply: FakeReply = route ? (typeof route.handler === 'function' ? await route.handler(req) : route.handler) : { status: 404, error: { code: 'NOT_FOUND', message: `No fake route for ${method} ${path}` } };
    if (reply.networkError) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    const status = reply.status ?? (reply.error ? 500 : 200);
    const response = {
      status, statusText: String(status), headers: {}, config,
      data: reply.error ? { success: false, error: reply.error } : { success: true, data: reply.data, ...(reply.meta ? { meta: reply.meta } : {}) },
    };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response as never);
    return response as never;
  };
  http.defaults.adapter = adapter;
  return {
    calls,
    called: (method: string, path: string | RegExp) => calls.filter((c) => c.method === method.toUpperCase() && (typeof path === 'string' ? c.path === path : path.test(c.path))),
    restore: () => { http.defaults.adapter = original; },
  };
}
