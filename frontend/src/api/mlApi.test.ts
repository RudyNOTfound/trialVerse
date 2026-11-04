import { afterEach, describe, expect, it, vi } from 'vitest';
import riskJson from '@/test/fixtures/risk-ramesh.json';
import scanJson from '@/test/fixtures/scan.json';
import { installFakeApi, page } from '@/test/fakeApi';
import { ApiError, setUnauthorizedHandler, tokenStore } from './client';
import { auditApi } from './audit';
import { integrityApi } from './integrity';
import { riskApi } from './risk';

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());

describe('riskApi', () => {
  it('assess posts the entity to /risk/assessments and returns the backend\'s assessment unchanged', async () => {
    api = installFakeApi({ 'POST /risk/assessments': { status: 201, data: riskJson } });
    const a = await riskApi.assess('patient', riskJson.entityId);
    expect(api.calls).toEqual([expect.objectContaining({ method: 'POST', path: '/risk/assessments', body: { entityType: 'patient', entityId: riskJson.entityId } })]);
    expect(a).toEqual(riskJson);                       // no re-computation, no re-labelling
  });
  it('list sends filters as query params and drops empty ones', async () => {
    api = installFakeApi({ 'GET /risk/assessments': (req) => page([riskJson], Number(req.params?.page), Number(req.params?.pageSize)) });
    const r = await riskApi.list({ entityType: 'patient', level: undefined, sort: 'assessedAt', order: 'desc', page: 2, pageSize: 100 });
    expect(r.items).toHaveLength(0);                   // page 2 of 1 item
    expect(api.calls[0]!.params).toEqual({ entityType: 'patient', sort: 'assessedAt', order: 'desc', page: 2, pageSize: 100 });
  });
});

describe('integrityApi.scan', () => {
  it('sends the look-back window and the trial', async () => {
    api = installFakeApi({ 'POST /integrity/scans': { status: 201, data: scanJson } });
    const r = await integrityApi.scan(168, 'trial-1');
    expect(api.calls[0]!.body).toEqual({ windowHours: 168, trialId: 'trial-1' });
    expect(r.coverage).toMatchObject({ trialsScanned: 1, sitesSkippedNoTimezone: [] });
    expect(r.alerts.length).toBe(scanJson.alerts.length);
  });
  it('omits what was not given (platform-wide scan)', async () => {
    api = installFakeApi({ 'POST /integrity/scans': { status: 201, data: scanJson } });
    await integrityApi.scan();
    expect(api.calls[0]!.body).toEqual({});
  });
});

describe('scan history comes from the audit trail', () => {
  it('asks the audit API for integrity.scan_completed events', async () => {
    api = installFakeApi({ 'GET /audit': page([]) });
    await auditApi.list({ action: 'integrity.scan_completed', pageSize: 10, order: 'desc' });
    expect(api.calls[0]!.params).toMatchObject({ action: 'integrity.scan_completed' });
  });
});

describe('error handling (real interceptors)', () => {
  it('403 becomes an ApiError with the backend\'s code and message; the session is kept', async () => {
    tokenStore.set('abc');
    api = installFakeApi({ 'GET /risk/assessments': { status: 403, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' } } });
    const err = await riskApi.list().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(tokenStore.get()).toBe('abc');
  });
  it('401 clears the token and notifies the app (expired session)', async () => {
    tokenStore.set('abc'); const onUnauthorized = vi.fn(); setUnauthorizedHandler(onUnauthorized);
    api = installFakeApi({ 'POST /integrity/scans': { status: 401, error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } } });
    await expect(integrityApi.scan(168, 't')).rejects.toMatchObject({ status: 401 });
    expect(tokenStore.get()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('service unavailable (network) is a readable ApiError, not a crash', async () => {
    api = installFakeApi({ 'POST /risk/assessments': { networkError: true } });
    await expect(riskApi.assess('patient', 'x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: expect.stringMatching(/Cannot reach/) });
  });
  it('a 500 keeps the server message for display', async () => {
    api = installFakeApi({ 'POST /integrity/scans': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } } });
    await expect(integrityApi.scan(24, 't')).rejects.toMatchObject({ status: 500, message: 'Unexpected error' });
  });
});
