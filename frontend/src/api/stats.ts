import { get } from './client';
import type { OperationsStats, ReimbursementStats, SponsorStats, VisitStats } from '@/types/api';

/** Server-side aggregates. Staff only; `sponsor` is admin + investigator. */
export const statsApi = {
  operations: () => get<OperationsStats>('/stats/operations'),
  visits: (p: { limit?: number; windowDays?: number } = {}) => get<VisitStats>('/stats/visits', p),
  reimbursements: () => get<ReimbursementStats>('/stats/reimbursements'),
  sponsor: (p: { topRisks?: number } = {}) => get<SponsorStats>('/stats/sponsor', p),
};
