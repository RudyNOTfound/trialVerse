import type { Ctx } from '../../context';
import { createLookups, entityLabels } from '../../utils/lookups';
import { nowIso } from '../../utils/db';

type Counts = Record<string, number>;

const VISIT_STATUSES = ['scheduled', 'otp_pending', 'verified', 'completed', 'missed', 'cancelled'] as const;
const OPEN_VISIT = `('scheduled', 'otp_pending', 'verified')`;
const LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Dashboard aggregates computed with SQL (GROUP BY / SUM). Nothing here loads entity collections into memory:
 * the frontend previously fetched list pages just to read `meta.total`.
 */
export function createStatsService(ctx: Ctx) {
  const { db } = ctx;
  const lookups = createLookups(db);

  /** `SELECT col, COUNT(*) ... GROUP BY col`, zero-filled so clients get stable keys. `table`/`col`/`where` are constants. */
  const countBy = (table: string, col: string, keys: readonly string[], where = '1=1', params: unknown[] = []): Counts => {
    const out: Counts = Object.fromEntries(keys.map((k) => [k, 0]));
    const rows = db.prepare(`SELECT ${col} AS k, COUNT(*) AS c FROM ${table} WHERE ${where} GROUP BY ${col}`).all(...params) as Array<{ k: string; c: number }>;
    for (const r of rows) out[r.k] = r.c;
    return out;
  };
  const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const one = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T;

  const reimbursementCounts = () => ({
    byStatus: countBy('reimbursements', 'status', ['pending', 'approved', 'rejected', 'cancelled']),
    byPaymentStatus: countBy('reimbursements', 'payment_status', ['none', 'unpaid', 'processing', 'paid', 'failed']),
  });

  return {
    /** Headline numbers for the site-operations dashboard. */
    operations() {
      const now = nowIso();
      const patients = countBy('patients', 'status', ['active', 'withdrawn', 'inactive'], 'deleted_at IS NULL');
      const trials = countBy('trials', 'status', ['draft', 'active', 'suspended', 'completed', 'terminated'], 'deleted_at IS NULL');
      const enrollments = countBy('enrollments', 'status', ['screening', 'enrolled', 'completed', 'withdrawn', 'screen_failed']);
      const visits = countBy('visits', 'status', VISIT_STATUSES);
      const actions = countBy('actions', 'status', ['pending', 'in_progress', 'completed', 'cancelled']);
      const overdue = one<{ c: number }>(`SELECT COUNT(*) c FROM actions WHERE status IN ('pending','in_progress') AND due_date IS NOT NULL AND due_date < ?`, now).c;
      const overdueVisits = one<{ c: number }>(`SELECT COUNT(*) c FROM visits WHERE status IN ('scheduled','otp_pending') AND scheduled_at < ?`, now).c;
      return {
        generatedAt: now,
        patients: { total: sum(patients), byStatus: patients },
        trials: { total: sum(trials), byStatus: trials },
        enrollments: { total: sum(enrollments), byStatus: enrollments },
        visits: { total: sum(visits), byStatus: visits, pastDueUnverified: overdueVisits },
        actions: { total: sum(actions), byStatus: actions, overdue },
        reimbursements: { total: sum(reimbursementCounts().byStatus), ...reimbursementCounts() },
      };
    },

    /** Visit status counts plus the next open visits (with embedded names). */
    visits(q: { limit: number; windowDays: number }) {
      const now = nowIso();
      const byStatus = countBy('visits', 'status', VISIT_STATUSES);
      const until = new Date(Date.now() + q.windowDays * 86_400_000).toISOString();
      const inWindow = one<{ c: number }>(`SELECT COUNT(*) c FROM visits WHERE status IN ${OPEN_VISIT} AND scheduled_at >= ? AND scheduled_at <= ?`, now, until).c;
      const rows = db.prepare(
        `SELECT id, visit_type, scheduled_at, status, patient_id, trial_id, trial_site_id FROM visits WHERE status IN ${OPEN_VISIT} AND scheduled_at >= ? ORDER BY scheduled_at ASC LIMIT ?`,
      ).all(now, q.limit) as Array<{ id: string; visit_type: string; scheduled_at: string; status: string; patient_id: string; trial_id: string; trial_site_id: string }>;
      const p = lookups.patients(rows.map((r) => r.patient_id));
      const t = lookups.trials(rows.map((r) => r.trial_id));
      const s = lookups.sites(rows.map((r) => r.trial_site_id));
      return {
        generatedAt: now,
        total: sum(byStatus), byStatus, windowDays: q.windowDays, upcomingInWindow: inWindow,
        upcoming: rows.map((r) => ({
          id: r.id, visitType: r.visit_type, scheduledAt: r.scheduled_at, status: r.status,
          patientId: r.patient_id, patientName: p.get(r.patient_id)?.name ?? null,
          trialId: r.trial_id, trialCode: t.get(r.trial_id)?.code ?? null, siteName: s.get(r.trial_site_id)?.name ?? null,
        })),
      };
    },

    /** Reimbursement counts by status / payment status, and money grouped by currency (never summed across currencies). */
    reimbursements() {
      const now = nowIso();
      const counts = reimbursementCounts();
      const byCategory = db.prepare(
        `SELECT category, currency, COUNT(*) AS count, SUM(amount_cents) AS amountCents FROM reimbursements GROUP BY category, currency ORDER BY currency, category`,
      ).all();
      const totals = db.prepare(
        `SELECT currency, COUNT(*) AS count, SUM(amount_cents) AS amountCents,
                SUM(CASE WHEN status = 'pending' THEN amount_cents ELSE 0 END) AS pendingAmountCents,
                SUM(CASE WHEN status = 'approved' THEN amount_cents ELSE 0 END) AS approvedAmountCents,
                SUM(CASE WHEN payment_status = 'paid' THEN amount_cents ELSE 0 END) AS paidAmountCents
         FROM reimbursements GROUP BY currency ORDER BY currency`,
      ).all();
      const oldest = one<{ at: string | null }>(`SELECT MIN(created_at) AS at FROM reimbursements WHERE status = 'pending'`).at;
      return { generatedAt: now, total: sum(counts.byStatus), ...counts, byCategory, totals, oldestPendingAt: oldest };
    },

    /** Risk / integrity / audit overview for sponsors. Risk figures use each entity's LATEST assessment, not every stored one. */
    sponsor(q: { topRisks: number }) {
      const now = nowIso();
      const trials = countBy('trials', 'status', ['draft', 'active', 'suspended', 'completed', 'terminated'], 'deleted_at IS NULL');

      const latest = `ra.rowid = (SELECT r2.rowid FROM risk_assessments r2 WHERE r2.entity_type = ra.entity_type AND r2.entity_id = ra.entity_id ORDER BY r2.assessed_at DESC, r2.rowid DESC LIMIT 1)`;
      const riskRows = db.prepare(`SELECT ra.entity_type AS t, ra.level AS l, COUNT(*) AS c FROM risk_assessments ra WHERE ${latest} GROUP BY ra.entity_type, ra.level`).all() as Array<{ t: string; l: string; c: number }>;
      const byEntity: Record<string, Counts> = {};
      const overall: Counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
      for (const r of riskRows) {
        (byEntity[r.t] ??= Object.fromEntries(LEVELS.map((l) => [l, 0])))[r.l] = r.c;
        overall[r.l] = (overall[r.l] ?? 0) + r.c;
      }
      const top = q.topRisks === 0 ? [] : (db.prepare(
        `SELECT ra.id, ra.entity_type, ra.entity_id, ra.score, ra.level, ra.assessed_at FROM risk_assessments ra WHERE ${latest} ORDER BY ra.score DESC, ra.assessed_at DESC LIMIT ?`,
      ).all(q.topRisks) as Array<{ id: string; entity_type: string; entity_id: string; score: number; level: string; assessed_at: string }>);
      const labels = entityLabels(db, top.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id })));

      const alertStatus = countBy('integrity_alerts', 'status', ['open', 'acknowledged', 'resolved', 'dismissed']);
      const openBySeverity = countBy('integrity_alerts', 'severity', LEVELS, `status = 'open'`);

      const audit = one<{ total: number; lastAt: string | null }>('SELECT COUNT(*) AS total, MAX(created_at) AS lastAt FROM audit_logs');
      const head = db.prepare('SELECT last_seq AS headSeq FROM audit_chain_head WHERE id = 1').get() as { headSeq: number } | undefined;

      return {
        generatedAt: now,
        trials: { total: sum(trials), byStatus: trials },
        risk: {
          basis: 'latest assessment per entity',
          assessedEntities: sum(overall), byLevel: overall, byEntityType: byEntity,
          highOrCritical: (overall.high ?? 0) + (overall.critical ?? 0),
          storedAssessments: one<{ c: number }>('SELECT COUNT(*) c FROM risk_assessments').c,
          top: top.map((r) => ({ id: r.id, entityType: r.entity_type, entityId: r.entity_id, entityName: labels.get(`${r.entity_type}:${r.entity_id}`) ?? null, score: r.score, level: r.level, assessedAt: r.assessed_at })),
        },
        integrity: { total: sum(alertStatus), byStatus: alertStatus, open: alertStatus.open ?? 0, openBySeverity },
        audit: { totalEvents: audit.total, headSeq: head?.headSeq ?? 0, lastEventAt: audit.lastAt },
      };
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
