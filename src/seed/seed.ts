/**
 * Demo data seeder. Everything is created through the real services, so the audit chain
 * is genuine and verifiable. Refuses to run in production.
 *
 *   npm run seed          # seed an empty database
 *   npm run seed:reset    # delete the database file first, then seed
 */
import 'dotenv/config';
import fs from 'node:fs';
import { buildContext } from '../bootstrap';
import { loadConfig } from '../config/env';
import type { Actor, Ctx } from '../context';
import { createServices } from '../services';
import { AppError } from '../utils/errors';

export const DEMO_PASSWORD = 'DemoPass#2025';
export const DEMO_OTP = '123456';

const day = 86400_000;
const at = (days: number, hours = 0) => new Date(Date.now() + days * day + hours * 3600_000).toISOString();
const dateOnly = (days: number) => at(days).slice(0, 10);

export async function seed(ctx: Ctx, log: (m: string) => void = () => {}) {
  const s = createServices(ctx);
  if ((ctx.db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0) {
    throw new Error('Database already contains users. Use `npm run seed:reset` to start over.');
  }

  // ---- Users --------------------------------------------------------------------------------
  const mk = async (email: string, fullName: string, role: Actor['role']) => {
    const u = await s.users.create({ email, password: DEMO_PASSWORD, fullName, role }, null);
    return { id: u.id, role: u.role, email: u.email } satisfies Actor;
  };
  const admin = await mk('admin@trialguard.demo', 'Alex Admin', 'admin');
  const coord1 = await mk('coordinator1@trialguard.demo', 'Casey Coordinator', 'coordinator');
  const coord2 = await mk('coordinator2@trialguard.demo', 'Jordan Coordinator', 'coordinator');
  const inv1 = await mk('investigator1@trialguard.demo', 'Dr. Priya Raman', 'investigator');
  const inv2 = await mk('investigator2@trialguard.demo', 'Dr. Marcus Webb', 'investigator');
  const pu1 = await mk('patient1@trialguard.demo', 'Amelia Hartwell', 'patient');
  const pu2 = await mk('patient2@trialguard.demo', 'Rajesh Kulkarni', 'patient');
  const pu3 = await mk('patient3@trialguard.demo', 'Sofia Marchetti', 'patient');
  log('users');

  // ---- Trials & sites ------------------------------------------------------------------------
  const onc = s.trials.createTrial({ code: 'TG-ONC-301', title: 'Phase III Study of Zeronib in Advanced NSCLC', sponsor: 'Meridian Therapeutics', phase: 'III', startDate: dateOnly(-120), endDate: dateOnly(500), description: 'Randomised, double-blind study comparing Zeronib to standard of care.' }, admin);
  const card = s.trials.createTrial({ code: 'TG-CARD-201', title: 'Phase II Trial of CardioShield in Heart Failure', sponsor: 'Northwind Pharma', phase: 'II', startDate: dateOnly(-60), endDate: dateOnly(300) }, admin);
  const dia = s.trials.createTrial({ code: 'TG-DIA-101', title: 'Phase I Dose Escalation of GlucoStable', sponsor: 'Aster Biosciences', phase: 'I', startDate: dateOnly(30) }, coord1);
  s.trials.updateTrial(onc.id, { status: 'active' }, admin);
  s.trials.updateTrial(card.id, { status: 'active' }, admin);

  const boston = s.trials.createSite(onc.id, { siteCode: 'BOS-01', name: 'Harborview Cancer Center', city: 'Boston', country: 'USA', principalInvestigatorId: inv1.id }, admin);
  const toronto = s.trials.createSite(onc.id, { siteCode: 'TOR-02', name: 'Lakeshore Clinical Research', city: 'Toronto', country: 'Canada', principalInvestigatorId: inv2.id }, admin);
  const chicago = s.trials.createSite(card.id, { siteCode: 'CHI-01', name: 'Midwest Heart Institute', city: 'Chicago', country: 'USA', principalInvestigatorId: inv2.id }, admin);
  const london = s.trials.createSite(dia.id, { siteCode: 'LON-01', name: 'Thames Metabolic Unit', city: 'London', country: 'UK', principalInvestigatorId: inv1.id }, admin);
  log('trials');

  // ---- Patients & enrollments ----------------------------------------------------------------
  const p = (firstName: string, lastName: string, dob: string, sex: 'female' | 'male', userId?: string) =>
    s.patients.create({ firstName, lastName, dateOfBirth: dob, sex, email: `${firstName}.${lastName}@example.org`.toLowerCase().replace(/[^a-z0-9.@-]/g, ''), phone: '+1-555-01' + String(Math.floor(Math.random() * 90) + 10), userId }, coord1);
  const amelia = p('Amelia', 'Hartwell', '1968-03-14', 'female', pu1.id);
  const rajesh = p('Rajesh', 'Kulkarni', '1975-11-02', 'male', pu2.id);
  const sofia = p('Sofia', 'Marchetti', '1982-07-21', 'female', pu3.id);
  const daniel = p('Daniel', 'Okafor', '1959-01-30', 'male');
  const mei = p('Mei-Ling', 'Chen', '1990-09-09', 'female');
  const tomas = p('Tomas', 'Herrera', '1971-05-17', 'male');
  const grace = p('Grace', 'Lindqvist', '1985-12-25', 'female');
  const omar = p('Omar', 'Haddad', '1963-08-08', 'male');

  const enrol = (patientId: string, trialId: string, trialSiteId: string, status: 'screening' | 'enrolled' | 'withdrawn', arm?: string) => {
    const e = s.trials.createEnrollment({ patientId, trialId, trialSiteId, arm }, coord1);
    if (status === 'enrolled' || status === 'withdrawn') s.trials.updateEnrollmentStatus(e.id, 'enrolled', inv1);
    if (status === 'withdrawn') s.trials.updateEnrollmentStatus(e.id, 'withdrawn', inv1);
    return e;
  };
  const eAmelia = enrol(amelia.id, onc.id, boston.id, 'enrolled', 'Zeronib');
  const eRajesh = enrol(rajesh.id, onc.id, boston.id, 'enrolled', 'Standard of care');
  const eDaniel = enrol(daniel.id, onc.id, toronto.id, 'enrolled', 'Zeronib');
  const eMei = enrol(mei.id, onc.id, toronto.id, 'enrolled', 'Standard of care');
  const eTomas = enrol(tomas.id, onc.id, boston.id, 'enrolled', 'Zeronib');
  const eSofia = enrol(sofia.id, card.id, chicago.id, 'enrolled', 'CardioShield 20mg');
  const eGrace = enrol(grace.id, card.id, chicago.id, 'withdrawn');
  enrol(omar.id, dia.id, london.id, 'screening');
  void eGrace;
  log('patients & enrollments');

  // ---- Visits & OTP --------------------------------------------------------------------------
  const visit = (enr: { id: string }, type: string, when: string) => s.visits.create({ enrollmentId: enr.id, visitType: type, scheduledAt: when }, coord1);
  const verify = (v: { id: string }, who: Actor, code = DEMO_OTP) => { s.otp.issue(v.id, coord1, { code }); return s.otp.verify(v.id, code, who); };

  // Completed & verified (patient verifies their own visit)
  const vAmeliaDone = visit(eAmelia, 'Baseline', at(-30));
  verify(vAmeliaDone, pu1);
  s.visits.changeStatus(vAmeliaDone.id, 'completed', 'All procedures performed', inv1);

  const vAmeliaWeek4 = visit(eAmelia, 'Week 4', at(-2));
  verify(vAmeliaWeek4, pu1); // verified, awaiting investigator sign-off

  const vRajeshDone = visit(eRajesh, 'Baseline', at(-21));
  verify(vRajeshDone, coord1);
  s.visits.changeStatus(vRajeshDone.id, 'completed', undefined, inv1);

  // OTP issued and waiting. Seeded OTP code is DEMO_OTP, valid 30 days (direct SQL extends expiry for demo use).
  const vRajeshToday = visit(eRajesh, 'Week 3', at(0, 1));
  s.otp.issue(vRajeshToday.id, coord1, { code: DEMO_OTP });
  ctx.db.prepare(`UPDATE otp_records SET expires_at = ? WHERE visit_id = ? AND status = 'active'`).run(at(30), vRajeshToday.id);

  // Upcoming
  visit(eAmelia, 'Week 8', at(26));
  visit(eSofia, 'Screening', at(3));
  const vSofiaBase = visit(eSofia, 'Baseline', at(-10));
  verify(vSofiaBase, pu3);
  s.visits.changeStatus(vSofiaBase.id, 'completed', undefined, inv2);

  // Suspicious: Daniel's OTP is guessed until locked, then re-issued and verified only after more failures
  const vDanielLocked = visit(eDaniel, 'Week 2', at(-3));
  s.otp.issue(vDanielLocked.id, coord2, { code: '482913' });
  for (let i = 0; i < ctx.config.otp.maxAttempts; i++) {
    try { s.otp.verify(vDanielLocked.id, '000000', coord2); } catch (e) { if (!(e instanceof AppError)) throw e; }
  }
  const vDanielGuessy = visit(eDaniel, 'Week 4', at(-1));
  s.otp.issue(vDanielGuessy.id, coord2, { code: '735201' });
  for (const wrong of ['111111', '222222']) { try { s.otp.verify(vDanielGuessy.id, wrong, coord2); } catch (e) { if (!(e instanceof AppError)) throw e; } }
  s.otp.verify(vDanielGuessy.id, '735201', coord2);

  // Expired OTP example
  const vTomasExpired = visit(eTomas, 'Week 2', at(-1));
  s.otp.issue(vTomasExpired.id, coord2, { code: '246810' });
  ctx.db.prepare(`UPDATE otp_records SET expires_at = ? WHERE visit_id = ? AND status = 'active'`).run(at(0, -1), vTomasExpired.id);
  try { s.otp.verify(vTomasExpired.id, '246810', coord2); } catch (e) { if (!(e instanceof AppError)) throw e; } // late attempt -> recorded as expired

  // Tomas: unverified past visits (missing verification)
  visit(eTomas, 'Baseline', at(-5));
  visit(eTomas, 'Week 1', at(-3));

  // Mei-Ling: repeated missed visits
  for (const [type, d] of [['Baseline', -40], ['Week 2', -26]] as const) {
    const v = visit(eMei, type, at(d));
    s.visits.changeStatus(v.id, 'missed', 'Patient did not attend', coord1);
  }
  const vMeiCancel = visit(eMei, 'Week 4', at(-12));
  s.visits.changeStatus(vMeiCancel.id, 'cancelled', 'Rescheduled by site', coord1);
  visit(eMei, 'Week 6', at(5));
  log('visits & OTP');

  // ---- Reimbursements ------------------------------------------------------------------------
  const claim = (v: { id: string }, category: 'travel' | 'meals' | 'accommodation' | 'parking' | 'other', amountCents: number, by: Actor, description?: string) =>
    s.reimbursements.create({ visitId: v.id, category, amountCents, currency: 'USD', description }, by);

  const rPaid = claim(vAmeliaDone, 'travel', 4800, pu1, 'Train fare to Boston');
  s.reimbursements.approve(rPaid.id, 'Receipt verified', inv1);
  s.reimbursements.updatePayment(rPaid.id, { status: 'processing' }, admin);
  s.reimbursements.updatePayment(rPaid.id, { status: 'paid', transactionRef: 'TXN-20250001' }, admin);

  const rApproved = claim(vAmeliaDone, 'meals', 2200, pu1);
  s.reimbursements.approve(rApproved.id, undefined, admin);

  claim(vAmeliaWeek4, 'travel', 5100, pu1, 'Train fare');           // pending
  claim(vRajeshDone, 'accommodation', 18000, coord1, 'One night hotel (long-distance)');  // pending
  const rRejected = claim(vRajeshDone, 'other', 9500, coord1, 'Unspecified expense');
  s.reimbursements.reject(rRejected.id, 'No supporting receipt provided', inv2);
  const rCancelled = claim(vSofiaBase, 'parking', 1500, pu3);
  s.reimbursements.cancel(rCancelled.id, 'Submitted by mistake', pu3);
  const rFailed = claim(vSofiaBase, 'travel', 3900, pu3);
  s.reimbursements.approve(rFailed.id, undefined, inv2);
  s.reimbursements.updatePayment(rFailed.id, { status: 'processing' }, admin);
  s.reimbursements.updatePayment(rFailed.id, { status: 'failed', note: 'Bank rejected transfer' }, admin);

  // Daniel: duplicate claims + one huge claim on an unverified (locked) visit
  claim(vDanielGuessy, 'travel', 7500, coord2, 'Taxi to site');
  const rDup = claim(vDanielGuessy, 'travel', 7500, coord2, 'Taxi to site');
  const rBig = claim(vDanielLocked, 'accommodation', 95000, coord2, 'Hotel stay');
  log('reimbursements');

  // ---- Actions -------------------------------------------------------------------------------
  const act = (title: string, by: Actor, extra: Partial<Parameters<typeof s.actions.create>[0]> = {}) => s.actions.create({ title, priority: 'medium', ...extra }, by);
  const a1 = act('Follow up on locked OTP for Daniel Okafor', coord1, { priority: 'critical', dueDate: at(-1), assigneeId: coord2.id, patientId: daniel.id, visitId: vDanielLocked.id, trialId: onc.id, description: 'OTP locked after repeated incorrect attempts; confirm identity with the patient.' });
  const a2 = act('Review duplicate reimbursement requests', admin, { priority: 'high', dueDate: at(2), assigneeId: inv1.id, patientId: daniel.id, trialId: onc.id });
  s.actions.changeStatus(a2.id, 'in_progress', 'Started review', inv1);
  const a3 = act('Contact Mei-Ling Chen about missed visits', coord1, { priority: 'high', dueDate: at(-4), assigneeId: coord1.id, patientId: mei.id });
  s.actions.changeStatus(a3.id, 'in_progress', undefined, coord1);
  const a4 = act('Collect signed consent addendum v2.1', coord1, { priority: 'medium', dueDate: at(10), assigneeId: coord2.id, trialId: card.id });
  const a5 = act('Archive baseline source documents', coord2, { priority: 'low', dueDate: at(-8), assigneeId: coord2.id, trialId: onc.id });
  s.actions.changeStatus(a5.id, 'completed', 'Archived', coord2);
  act('Verify Tomas Herrera visits pending OTP verification', coord1, { priority: 'high', dueDate: at(1), assigneeId: coord1.id, patientId: tomas.id });
  void a1; void a4;
  log('actions');

  // ---- Failed logins (audit signal) -----------------------------------------------------------
  for (let i = 0; i < 10; i++) { try { await s.auth.login('admin@trialguard.demo', `wrong-password-${i}`); } catch (e) { if (!(e instanceof AppError)) throw e; } }

  // ---- Risk assessments & integrity scan -----------------------------------------------------
  await s.risk.assess({ entityType: 'patient', entityId: daniel.id }, admin);
  await s.risk.assess({ entityType: 'visit', entityId: vDanielLocked.id }, admin);
  await s.risk.assess({ entityType: 'reimbursement', entityId: rDup.id }, admin);
  await s.risk.assess({ entityType: 'reimbursement', entityId: rBig.id }, admin);
  await s.risk.assess({ entityType: 'patient', entityId: tomas.id }, admin);
  await s.risk.assess({ entityType: 'patient', entityId: mei.id }, admin);
  await s.risk.assess({ entityType: 'patient', entityId: amelia.id }, admin);
  const scan = await s.integrity.scan({ windowHours: 168 }, admin);
  const alertToAck = scan.alerts.find((a) => a.severity === 'high');
  if (alertToAck) s.integrity.updateStatus(alertToAck.id, 'acknowledged', 'Under review', inv1);
  log(`risk & integrity (${scan.newAlerts} alerts)`);

  const chain = s.audit.verify(admin);
  return {
    chain,
    counts: Object.fromEntries(['users', 'patients', 'trials', 'trial_sites', 'enrollments', 'visits', 'otp_records', 'reimbursements', 'actions',
      'risk_assessments', 'integrity_alerts', 'audit_logs'].map((t) => [t, (ctx.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c])),
    ids: { vRajeshToday: vRajeshToday.id, vDanielLocked: vDanielLocked.id, daniel: daniel.id },
  };
}

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    if (config.isProduction) { console.error('Refusing to seed demo data when NODE_ENV=production.'); process.exit(1); }
    if (process.argv.includes('--reset') && config.databasePath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databasePath + suffix, { force: true });
      console.log('Existing database removed.');
    }
    const ctx = buildContext(config, { logger: (await import('../config/logger')).createLogger('silent') });
    try {
      const out = await seed(ctx, (m) => console.log(`  seeded ${m}`));
      console.log('\nRow counts:', out.counts);
      console.log(`Audit chain valid: ${out.chain.valid} (${out.chain.eventsChecked} events)`);
      console.log(`\nDemo password for every account: ${DEMO_PASSWORD}`);
      console.log(`Visit with an active OTP (code ${DEMO_OTP}): ${out.ids.vRajeshToday}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      ctx.db.close();
    }
  })();
}
