import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import type { ApiErrorBody, Paginated } from '@/types/api';

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
const TOKEN_KEY = 'trialverse.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Normalised error thrown by every API call. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export const setUnauthorizedHandler = (fn: UnauthorizedHandler | null) => { onUnauthorized = fn; };

export const http = axios.create({ baseURL: API_BASE_URL, timeout: 15_000, headers: { 'Content-Type': 'application/json' } });

http.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

http.interceptors.response.use(
  (res) => res,
  (err: AxiosError<{ success: false; error?: ApiErrorBody }>) => {
    if (!err.response) {
      return Promise.reject(new ApiError(0, { code: 'NETWORK_ERROR', message: 'Cannot reach the TrialVerse API. Check that the backend is running.' }));
    }
    const { status, data, config } = err.response;
    const body: ApiErrorBody = data?.error ?? { code: `HTTP_${status}`, message: err.message };
    // A 401 on the login call itself is a credentials problem, not an expired session.
    const isLogin = config?.url?.includes('/auth/login');
    if (status === 401 && !isLogin) {
      tokenStore.clear();
      onUnauthorized?.();
    }
    return Promise.reject(new ApiError(status, body));
  },
);

/** Unwraps `{ success, data }`. */
export async function get<T>(url: string, params?: object, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.get<{ success: true; data: T }>(url, { ...config, params: cleanParams(params) });
  return res.data.data;
}

/** Unwraps `{ success, data, meta }` list responses. */
export async function getPage<T>(url: string, params?: object): Promise<Paginated<T>> {
  const res = await http.get<{ success: true; data: T[]; meta: Paginated<T>['meta'] }>(url, { params: cleanParams(params) });
  return { items: res.data.data, meta: res.data.meta };
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.post<{ success: true; data: T }>(url, body ?? {});
  return res.data.data;
}

export async function patch<T>(url: string, body: unknown): Promise<T> {
  const res = await http.patch<{ success: true; data: T }>(url, body);
  return res.data.data;
}

export async function del(url: string): Promise<void> {
  await http.delete(url);
}

/** Drops undefined / empty-string params so filters can be passed straight from UI state. */
function cleanParams(params?: object) {
  if (!params) return undefined;
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    // Validation failures carry per-field messages in `details`; show them instead of the generic summary.
    if (Array.isArray(e.details)) {
      const parts = (e.details as Array<{ path?: string; message?: string }>).filter((d) => d?.message).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
      if (parts.length) return parts.join('; ');
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
