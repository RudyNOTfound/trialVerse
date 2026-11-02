import { get, getPage, patch, post } from './client';
import type { DemoOtp, OtpIssueResult, OtpStatus, Visit, VisitStatus } from '@/types/api';

export interface VisitFilters { page?: number; pageSize?: number; patientId?: string; trialId?: string; trialSiteId?: string; enrollmentId?: string; status?: VisitStatus; from?: string; to?: string; sort?: 'scheduledAt' | 'createdAt'; order?: 'asc' | 'desc' }

export const visitsApi = {
  list: (f: VisitFilters = {}) => getPage<Visit>('/visits', f),
  get: (id: string) => get<Visit>(`/visits/${id}`),
  create: (b: { enrollmentId: string; visitType: string; scheduledAt: string; notes?: string }) => post<Visit>('/visits', b),
  update: (id: string, b: { visitType?: string; scheduledAt?: string; notes?: string }) => patch<Visit>(`/visits/${id}`, b),
  /** `completed` requires a verified visit and an investigator/admin; the backend enforces both. */
  setStatus: (id: string, status: 'completed' | 'missed' | 'cancelled', note?: string) => post<Visit>(`/visits/${id}/status`, { status, note }),
  issueOtp: (id: string) => post<OtpIssueResult>(`/visits/${id}/otp`),
  otpStatus: (id: string) => get<OtpStatus>(`/visits/${id}/otp`),
  verifyOtp: (id: string, code: string) => post<Visit>(`/visits/${id}/otp/verify`, { code }),
  /** DEV ONLY and staff-only: exists only when the backend runs with DEMO_OTP_ENABLED=true. */
  devOtp: (id: string) => get<DemoOtp>(`/dev/visits/${id}/otp`),
};
