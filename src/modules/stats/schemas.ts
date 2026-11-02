import { z } from 'zod';

export const visitStatsQuery = z.object({
  /** How many upcoming open visits to list. */
  limit: z.coerce.number().int().min(1).max(50).default(8),
  /** Window for `upcomingInWindow`. */
  windowDays: z.coerce.number().int().min(1).max(365).default(7),
});

export const sponsorStatsQuery = z.object({
  /** How many highest-scoring entities to list. */
  topRisks: z.coerce.number().int().min(0).max(20).default(5),
});
