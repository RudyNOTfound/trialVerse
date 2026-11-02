import { get, getPage, post } from './client';
import type { RiskAssessment, RiskEntityType, RiskLevel, RiskRulesConfig } from '@/types/api';

export interface RiskFilters { page?: number; pageSize?: number; entityType?: RiskEntityType; entityId?: string; level?: RiskLevel; minScore?: number; sort?: 'assessedAt' | 'score'; order?: 'asc' | 'desc' }

export const riskApi = {
  list: (f: RiskFilters = {}) => getPage<RiskAssessment>('/risk/assessments', f),
  get: (id: string) => get<RiskAssessment>(`/risk/assessments/${id}`),
  assess: (entityType: RiskEntityType, entityId: string) => post<RiskAssessment>('/risk/assessments', { entityType, entityId }),
  rules: () => get<RiskRulesConfig>('/risk/rules'),
};
