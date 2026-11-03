import { describe, expect, it } from 'vitest';
import { bearer, makeHarness, makeScenario } from './helpers';

const api = '/api/v1';

describe('capturing the model inputs through the REST API', () => {
  const h = makeHarness();

  it('site timezone + mlSiteCategory: validated, audited, unique per trial, exposed in the DTO', async () => {
    const sc = await makeScenario(h);
    const url = `${api}/trials/${sc.trial.id}/sites`;
    const ok = await h.api.post(url).set(bearer(sc.coord)).send({ siteCode: 'CAP-1', name: 'Cap 1', country: 'India', timezone: 'Asia/Kolkata', mlSiteCategory: 'SITE-A' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ timezone: 'Asia/Kolkata', mlSiteCategory: 'SITE-A' });
    for (const bad of ['Mars/Olympus', '+05:30', 'IST', 'asia/kolkata', 'US/Eastern', '']) {
      const r = await h.api.post(url).set(bearer(sc.coord)).send({ siteCode: 'CAP-X', name: 'x', country: 'India', timezone: bad });
      expect(r.status, bad).toBe(400);
    }
    const dup = await h.api.post(url).set(bearer(sc.coord)).send({ siteCode: 'CAP-2', name: 'Cap 2', country: 'India', mlSiteCategory: 'SITE-A' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/mlSiteCategory/);
    const other = await h.api.post(url).set(bearer(sc.coord)).send({ siteCode: 'CAP-3', name: 'Cap 3', country: 'India' });
    expect(other.body.data).toMatchObject({ timezone: null, mlSiteCategory: null });
    const patch = (body: object) => h.api.patch(`${url}/${other.body.data.id}`).set(bearer(sc.coord)).send(body);
    expect((await patch({ timezone: 'UTC', mlSiteCategory: 'SITE-B' })).body.data).toMatchObject({ timezone: 'UTC', mlSiteCategory: 'SITE-B' });
    expect((await patch({ mlSiteCategory: 'SITE-A' })).status).toBe(409);
    expect((await patch({ timezone: 'Nowhere/City' })).status).toBe(400);
    expect((await patch({ timezone: null, mlSiteCategory: null })).body.data).toMatchObject({ timezone: null, mlSiteCategory: null });
    expect((await h.api.patch(`${url}/${other.body.data.id}`).set(bearer(sc.inv)).send({ timezone: 'UTC' })).status).toBe(403);
    const audit = (await h.api.get(`${api}/audit?action=trial_site.updated&entityId=${other.body.data.id}`).set(bearer(sc.admin))).body.data;
    expect(audit.length).toBeGreaterThan(0);
  });

  it('enrollment distanceToSiteKm: range-checked, audited, status-only patches still work', async () => {
    const sc = await makeScenario(h);
    const url = `${api}/enrollments/${sc.enrollment.id}`;
    expect((await h.api.patch(url).set(bearer(sc.coord)).send({ distanceToSiteKm: 42.5 })).body.data.distanceToSiteKm).toBe(42.5);
    for (const bad of [-1, 2001, 'far']) expect((await h.api.patch(url).set(bearer(sc.coord)).send({ distanceToSiteKm: bad })).status, String(bad)).toBe(400);
    expect((await h.api.patch(url).set(bearer(sc.coord)).send({})).status).toBe(400);
    expect((await h.api.patch(url).set(bearer(sc.coord)).send({ distanceToSiteKm: null })).body.data.distanceToSiteKm).toBeNull();
    const both = await h.api.patch(url).set(bearer(sc.coord)).send({ status: 'withdrawn', distanceToSiteKm: 5 });
    expect(both.body.data).toMatchObject({ status: 'withdrawn', distanceToSiteKm: 5 });
    const audit = (await h.api.get(`${api}/audit?entityId=${sc.enrollment.id}`).set(bearer(sc.admin))).body.data.map((e: any) => e.action);
    expect(audit).toContain('enrollment.updated');
    expect(JSON.stringify(audit)).not.toMatch(/42/);
  });

  it('participant dailyWageWorker: boolean or unknown (null), never coerced to false', async () => {
    const sc = await makeScenario(h);
    const created = await h.api.post(`${api}/patients`).set(bearer(sc.coord)).send({ firstName: 'Wage', lastName: 'Earner', dateOfBirth: '1980-01-01', sex: 'male', dailyWageWorker: true });
    expect(created.body.data.dailyWageWorker).toBe(true);
    const unknown = await h.api.post(`${api}/patients`).set(bearer(sc.coord)).send({ firstName: 'No', lastName: 'Info', dateOfBirth: '1980-01-01', sex: 'male' });
    expect(unknown.body.data.dailyWageWorker).toBeNull();
    const p = (id: string, body: object) => h.api.patch(`${api}/patients/${id}`).set(bearer(sc.coord)).send(body);
    expect((await p(unknown.body.data.id, { dailyWageWorker: false })).body.data.dailyWageWorker).toBe(false);
    expect((await p(unknown.body.data.id, { dailyWageWorker: null })).body.data.dailyWageWorker).toBeNull();
    expect((await p(unknown.body.data.id, { dailyWageWorker: 'yes' })).status).toBe(400);
    expect((await h.api.get(`${api}/patients/${created.body.data.id}`).set(bearer(sc.inv))).body.data.dailyWageWorker).toBe(true);
  });

  it('values captured through the API reach the risk feature map', async () => {
    const sc = await makeScenario(h);
    await h.api.patch(`${api}/enrollments/${sc.enrollment.id}`).set(bearer(sc.coord)).send({ distanceToSiteKm: 12 });
    await h.api.patch(`${api}/patients/${sc.patient.id}`).set(bearer(sc.coord)).send({ dailyWageWorker: true });
    await h.api.patch(`${api}/trials/${sc.trial.id}/sites/${sc.site.id}`).set(bearer(sc.coord)).send({ mlSiteCategory: 'SITE-C', timezone: 'Asia/Kolkata' });
    const f = (await import('../src/modules/risk/features')).buildFeatures(h.ctx.db, 'patient', sc.patient.id);
    expect(f).toMatchObject({ distance_km: 12, daily_wage_worker: 1, site_id: 'SITE-C' });
  });
});
