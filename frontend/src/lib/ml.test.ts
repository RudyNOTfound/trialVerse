import { describe, expect, it } from 'vitest';
import alertsJson from '@/test/fixtures/alerts.json';
import riskJson from '@/test/fixtures/risk-ramesh.json';
import sitesJson from '@/test/fixtures/sites.json';
import type { IntegrityAlert, RiskAssessment, TrialSite } from '@/types/api';
import { alertSiteIds, entityLabel, factorsOf, latestByEntity, needsAttention, participantIdsOf, reviewActionOf, riskSource, ruleLabel, scopeAlerts, summariseSites, visitIdsOf } from './ml';

const ramesh = riskJson as unknown as RiskAssessment;
const alerts = alertsJson as unknown as IntegrityAlert[];
const sites = sitesJson as unknown as TrialSite[];
const siteC = sites.find((s) => s.siteCode === 'SITE-C')!;

describe('riskSource', () => {
  it('real ML result is "model"', () => expect(riskSource(ramesh)).toBe('model'));
  // variants of the REAL fixture with only the named fields changed
  it('fallback.used wins over the engine name', () => expect(riskSource({ ...ramesh, engine: { name: 'baseline-rules', version: '1' }, fallback: { used: true, reason: 'unavailable: Model service is unreachable' } })).toBe('fallback'));
  it('baseline engine without a fallback means ML was simply not used', () => expect(riskSource({ ...ramesh, engine: { name: 'baseline-rules', version: '1' }, fallback: { used: false, reason: null } })).toBe('baseline'));
});

describe('factorsOf', () => {
  it('keeps the API values, orders by magnitude, and marks the direction from the sign', () => {
    const f = factorsOf(ramesh);
    expect(f).toHaveLength(ramesh.triggeredRules.length);
    expect(f[0]).toMatchObject({ name: 'missed_reminders', weight: 10.54, direction: 'raises' });
    expect(f.map((x) => Math.abs(x.weight))).toEqual([...f.map((x) => Math.abs(x.weight))].sort((a, b) => b - a));
    expect(f.find((x) => x.name === 'site_id')).toMatchObject({ weight: -2.19, direction: 'lowers' });
    expect(f.every((x) => x.detail.length > 0)).toBe(true);
  });
  it('does not invent factors when the engine returned none', () => expect(factorsOf({ triggeredRules: [] })).toEqual([]));
});

describe('latestByEntity / needsAttention', () => {
  it('keeps only the most recent assessment per entity', () => {
    const older = { ...ramesh, id: 'old', score: 10, level: 'low' as const, assessedAt: '2026-01-01T00:00:00.000Z' };
    const other = { ...ramesh, id: 'o', entityId: 'someone-else', assessedAt: '2026-02-01T00:00:00.000Z' };
    const m = latestByEntity([older, ramesh, other]);
    expect(m.size).toBe(2);
    expect(m.get(ramesh.entityId)?.id).toBe(ramesh.id);
  });
  it('flags only high and critical', () => expect(['low', 'medium', 'high', 'critical'].map((l) => needsAttention(l as never))).toEqual([false, false, true, true]));
});

describe('integrity scoping on real alerts', () => {
  it('reads site ids from details.siteId, details.siteIds (ECG clusters) and site entities', () => {
    const siteAlert = alerts.find((a) => a.entityType === 'site')!;
    expect(alertSiteIds(siteAlert)).toContain(siteC.id);
    const cluster = alerts.find((a) => a.entityType === 'ecg_cluster')!;
    expect(alertSiteIds(cluster)).toEqual([siteC.id]);
  });
  it('separates trial findings from platform-wide audit findings', () => {
    const { trial, platform } = scopeAlerts(alerts, sites.map((s) => s.id));
    expect(trial.length + platform.length).toBe(alerts.length);
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.every((a) => ['user', 'reimbursement', 'patient'].includes(a.entityType) || a.ruleId.startsWith('ml.'))).toBe(true);
    expect(trial.every((a) => alertSiteIds(a).length > 0)).toBe(true);
  });
  it('scoping to a trial with other sites leaves nothing (no cross-trial leakage)', () => {
    expect(scopeAlerts(alerts, ['00000000-0000-4000-8000-000000000000']).trial).toEqual([]);
  });
});

describe('summariseSites', () => {
  const { trial } = scopeAlerts(alerts, sites.map((s) => s.id));
  const rows = summariseSites(trial, sites);
  it('has one row per site, even without findings', () => expect(rows.map((r) => r.site.siteCode).sort()).toEqual(sites.map((s) => s.siteCode).sort()));
  it('ranks the site with the most severe findings first: Site C, the one with the injected anomalies', () => {
    expect(rows[0]!.site.siteCode).toBe('SITE-C');
    expect(rows[0]!.highest).toBe('high');
    expect(rows[0]!.rules.map((r) => r.ruleId)).toEqual(expect.arrayContaining(['site.bp_digit_preference', 'site.low_bp_variance', 'site.multiple_integrity_signals']));
  });
  it('counts equal the alerts that name the site', () => {
    const c = rows.find((r) => r.site.siteCode === 'SITE-C')!;
    expect(c.total).toBe(trial.filter((a) => alertSiteIds(a).includes(siteC.id)).length);
    expect(Object.values(c.bySeverity).reduce((x, y) => x + y, 0)).toBe(c.total);
  });
  it('sites with no alerts have highest = null', () => rows.filter((r) => r.total === 0).forEach((r) => expect(r.highest).toBeNull()));
});

describe('alert evidence accessors', () => {
  const multi = alerts.find((a) => a.ruleId === 'visit.multiple_integrity_signals')!;
  it('reads the participant, visit and review action the API supplies', () => {
    expect(participantIdsOf(multi)).toHaveLength(1);
    expect(visitIdsOf(multi)).toEqual([multi.entityId]);
    expect(reviewActionOf(multi)).toMatch(/\w/);
  });
  it('labels rules readably', () => {
    expect(ruleLabel('site.bp_digit_preference')).toBe('BP digit preference');
    expect(ruleLabel('visit.missing_otp')).toBe('Missing OTP');
    expect(ruleLabel('ecg.duplicate_image')).toBe('Duplicate image');
    expect(ruleLabel('ml.actor_activity_outlier')).toBe('Actor activity outlier');
  });
  it('keeps the scope where two rules would read the same', () => {
    expect(ruleLabel('site.multiple_integrity_signals')).toBe('Multiple integrity signals (site)');
    expect(ruleLabel('visit.multiple_integrity_signals')).toBe('Multiple integrity signals (visit)');
    expect(ruleLabel('site.multiple_integrity_signals')).not.toBe(ruleLabel('visit.multiple_integrity_signals'));
  });
});

describe('entityLabel', () => {
  const site = alerts.find((a) => a.entityType === 'site')!;
  const cluster = alerts.find((a) => a.entityType === 'ecg_cluster')!;
  it('names a site by its code, not an id', () => expect(entityLabel(site)).toBe('Site SITE-C'));
  it('describes an ECG cluster by what it contains, not by its internal key', () => {
    const label = entityLabel(cluster);
    expect(label).toMatch(/^ECG image cluster \(\d+ visits?\)$/);
    expect(label).not.toMatch(/ecg-clus|ecg_cluster/i);
  });
  it('prefers the name the API embeds, and falls back to type + short id', () => {
    expect(entityLabel({ entityType: 'visit', entityId: 'abcdef12-0000', entityName: 'Week 2 · Daniel Okafor', details: {} })).toBe('Week 2 · Daniel Okafor');
    expect(entityLabel({ entityType: 'reimbursement', entityId: 'abcdef12-0000', details: {} })).toBe('Reimbursement abcdef12');
  });
});
