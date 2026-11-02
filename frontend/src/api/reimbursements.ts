import { get, getPage, patch, post } from './client';
import type { HistoryEntry, PaymentStatus, Reimbursement, ReimbursementCategory, ReimbursementStatus } from '@/types/api';

export interface ReimbursementFilters { page?: number; pageSize?: number; patientId?: string; visitId?: string; trialId?: string; status?: ReimbursementStatus; paymentStatus?: PaymentStatus; category?: ReimbursementCategory; sort?: 'createdAt' | 'amountCents'; order?: 'asc' | 'desc' }
export interface ReimbursementInput { visitId: string; category: ReimbursementCategory; amountCents: number; currency?: string; description?: string }

export const reimbursementsApi = {
  list: (f: ReimbursementFilters = {}) => getPage<Reimbursement>('/reimbursements', f),
  get: (id: string) => get<Reimbursement>(`/reimbursements/${id}`),
  history: (id: string) => get<HistoryEntry[]>(`/reimbursements/${id}/history`),
  create: (b: ReimbursementInput) => post<Reimbursement>('/reimbursements', b),
  update: (id: string, b: Partial<Pick<ReimbursementInput, 'category' | 'amountCents' | 'description'>>) => patch<Reimbursement>(`/reimbursements/${id}`, b),
  approve: (id: string, note?: string) => post<Reimbursement>(`/reimbursements/${id}/approve`, { note }),
  reject: (id: string, reason: string) => post<Reimbursement>(`/reimbursements/${id}/reject`, { reason }),
  cancel: (id: string, note?: string) => post<Reimbursement>(`/reimbursements/${id}/cancel`, { note }),
  payment: (id: string, b: { status: 'processing' | 'paid' | 'failed'; transactionRef?: string; note?: string }) => post<Reimbursement>(`/reimbursements/${id}/payment`, b),
};
