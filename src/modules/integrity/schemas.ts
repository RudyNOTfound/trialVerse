import { z } from 'zod';
import { pageQuery } from '../../utils/http';

const severity = z.enum(['low', 'medium', 'high', 'critical']);
const alertStatus = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);

export const scanBody = z.object({
  /** Look-back window for audit events, default 7 days, max 30 days. */
  windowHours: z.number().int().min(1).max(720).default(168),
  /** Limit the trial-level checks (visits, sites, ECGs) to one trial. Default: every trial that has participants. */
  trialId: z.string().uuid().optional(),
});

export const listAlertsQuery = z.object({
  ...pageQuery,
  status: alertStatus.optional(),
  severity: severity.optional(),
  ruleId: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  sort: z.enum(['detectedAt', 'severity']).default('detectedAt'),
});

export const updateAlertBody = z.object({
  status: alertStatus,
  note: z.string().trim().max(1000).optional(),
});
