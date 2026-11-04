import { get, getPage, patch, post } from './client';
import type { AlertStatus, IntegrityAlert, IntegrityRulesConfig, IntegrityScanSummary, RiskLevel } from '@/types/api';

export interface AlertFilters { page?: number; pageSize?: number; status?: AlertStatus; severity?: RiskLevel; ruleId?: string; entityType?: string; entityId?: string; sort?: 'detectedAt' | 'severity'; order?: 'asc' | 'desc' }

export const integrityApi = {
  alerts: (f: AlertFilters = {}) => getPage<IntegrityAlert>('/integrity/alerts', f),
  alert: (id: string) => get<IntegrityAlert>(`/integrity/alerts/${id}`),
  updateAlert: (id: string, status: AlertStatus, note?: string) => patch<IntegrityAlert>(`/integrity/alerts/${id}`, { status, note }),
  /** `trialId` limits the trial-data checks (sites, visits, ECGs) to one trial; audit-based checks always cover the whole platform. */
  scan: (windowHours?: number, trialId?: string) => post<IntegrityScanSummary>('/integrity/scans', { ...(windowHours ? { windowHours } : {}), ...(trialId ? { trialId } : {}) }),
  rules: () => get<IntegrityRulesConfig>('/integrity/rules'),
};
