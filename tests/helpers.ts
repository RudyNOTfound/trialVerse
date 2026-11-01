import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { buildContext, type BuildOptions } from '../src/bootstrap';
import { loadConfig, type AppConfig } from '../src/config/env';
import { createLogger } from '../src/config/logger';
import type { Actor, Ctx, Role } from '../src/context';
import { signToken } from '../src/middleware/auth';
import { createServices, type Services } from '../src/services';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_PATH: ':memory:',
  JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234567890',
  OTP_PEPPER: 'test-otp-pepper-test-otp-pepper-1234567890',
  BCRYPT_ROUNDS: '4',
  RATE_LIMIT_ENABLED: 'false',
  DEMO_OTP_ENABLED: 'true',
};

export const makeConfig = (over: Record<string, string> = {}): AppConfig => loadConfig({ ...TEST_ENV, ...over });

export interface Harness { app: Express; ctx: Ctx; s: Services; api: ReturnType<typeof request> }

export function makeHarness(opts: { env?: Record<string, string> } & Omit<BuildOptions, 'logger'> = {}): Harness {
  const ctx = buildContext(makeConfig(opts.env), { logger: createLogger('silent'), riskModel: opts.riskModel, integrityModel: opts.integrityModel });
  const app = createApp(ctx);
  return { app, ctx, s: createServices(ctx), api: request(app) };
}

export const PASSWORD = 'Passw0rd-Strong1';

export interface TestUser { id: string; email: string; role: Role; token: string; actor: Actor }

let counter = 0;
export async function makeUser(h: Harness, role: Role, name = role): Promise<TestUser> {
  const email = `${name}${++counter}@test.local`;
  const u = await h.s.users.create({ email, password: PASSWORD, fullName: `Test ${name}`, role }, null);
  return { id: u.id, email, role, token: signToken(h.ctx, u), actor: { id: u.id, role, email } };
}

export const bearer = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

/** A fully wired clinical scenario created through the services. */
export async function makeScenario(h: Harness) {
  const admin = await makeUser(h, 'admin');
  const coord = await makeUser(h, 'coordinator');
  const inv = await makeUser(h, 'investigator');
  const patientUser = await makeUser(h, 'patient');
  const patient = h.s.patients.create({ firstName: 'Pat', lastName: 'Tester', dateOfBirth: '1980-01-01', sex: 'female', userId: patientUser.id }, coord.actor);
  const trial = h.s.trials.createTrial({ code: `TR-${++counter}`, title: 'Test Trial', sponsor: 'Acme', phase: 'II' }, admin.actor);
  h.s.trials.updateTrial(trial.id, { status: 'active' }, admin.actor);
  const site = h.s.trials.createSite(trial.id, { siteCode: 'S-01', name: 'Site One', country: 'USA', principalInvestigatorId: inv.id }, admin.actor);
  const enrollment = h.s.trials.createEnrollment({ patientId: patient.id, trialId: trial.id, trialSiteId: site.id }, coord.actor);
  h.s.trials.updateEnrollmentStatus(enrollment.id, 'enrolled', inv.actor);
  const visit = h.s.visits.create({ enrollmentId: enrollment.id, visitType: 'Baseline', scheduledAt: new Date().toISOString() }, coord.actor);
  const newVisit = (type = 'Follow-up', when = new Date().toISOString()) =>
    h.s.visits.create({ enrollmentId: enrollment.id, visitType: type, scheduledAt: when }, coord.actor);
  return { admin, coord, inv, patientUser, patient, trial, site, enrollment, visit, newVisit };
}
