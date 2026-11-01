import {
  CONTRACT_VERSION, MlError, integrityScanResponseSchema, riskPredictionResponseSchema,
  type IntegrityModel, type IntegrityScanRequest, type IntegrityScanResponse,
  type RiskModel, type RiskPredictionRequest, type RiskPredictionResponse,
} from './contracts';
import type { ZodType } from 'zod';

interface HttpOptions { baseUrl: string; timeoutMs: number; apiKey?: string; fetchImpl?: typeof fetch }

async function postJson<T>(opts: HttpOptions, path: string, body: unknown, schema: ZodType<T, any, any>, signal?: AbortSignal): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new MlError('timeout', `Model service timed out after ${opts.timeoutMs}ms`, err);
    throw new MlError('unavailable', 'Model service is unreachable', err);
  }
  if (res.status >= 500) throw new MlError('model_error', `Model service returned HTTP ${res.status}`);
  if (!res.ok) throw new MlError('model_error', `Model service rejected the request with HTTP ${res.status}`);
  let json: unknown;
  try { json = await res.json(); } catch (err) { throw new MlError('invalid_response', 'Model service returned non-JSON', err); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new MlError('invalid_response', `Model response violates contract: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

function assertEnvelope(req: { contractVersion: string; requestId: string }, res: { contractVersion: string; requestId: string }) {
  if (res.contractVersion.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) {
    throw new MlError('invalid_response', `Unsupported contractVersion '${res.contractVersion}' (expected ${CONTRACT_VERSION})`);
  }
  if (res.requestId !== req.requestId) throw new MlError('invalid_response', 'Response requestId does not match the request');
}

/** RiskModel backed by an external HTTP service: POST {baseUrl}/v1/risk/predict */
export class HttpRiskModel implements RiskModel {
  readonly name = 'http-risk-model';
  readonly version = 'remote';
  constructor(private readonly opts: HttpOptions) {}
  async predict(request: RiskPredictionRequest, options?: { signal?: AbortSignal }): Promise<RiskPredictionResponse> {
    const res = await postJson(this.opts, '/v1/risk/predict', request, riskPredictionResponseSchema, options?.signal);
    assertEnvelope(request, res);
    return res;
  }
}

/** IntegrityModel backed by an external HTTP service: POST {baseUrl}/v1/integrity/predict */
export class HttpIntegrityModel implements IntegrityModel {
  readonly name = 'http-integrity-model';
  readonly version = 'remote';
  constructor(private readonly opts: HttpOptions) {}
  async detect(request: IntegrityScanRequest, options?: { signal?: AbortSignal }): Promise<IntegrityScanResponse> {
    const res = await postJson(this.opts, '/v1/integrity/predict', request, integrityScanResponseSchema, options?.signal);
    assertEnvelope(request, res);
    return res;
  }
}
