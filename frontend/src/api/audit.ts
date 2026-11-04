import { get, getPage } from './client';
import type { AuditEvent, ChainVerification } from '@/types/api';

export interface AuditFilters { page?: number; pageSize?: number; actorId?: string; action?: string; entityType?: string; entityId?: string; from?: string; to?: string; order?: 'asc' | 'desc' }

export const auditApi = {
  list: (f: AuditFilters = {}) => getPage<AuditEvent>('/audit', f),
  get: (id: string) => get<AuditEvent>(`/audit/${id}`),
  /** Recomputes the whole chain. The attempt itself is recorded by the backend. */
  verify: () => get<ChainVerification>('/audit/verify'),
};
