import { get, getPage, patch, post } from './client';
import type { Enrollment, EnrollmentStatus, Trial, TrialPhase, TrialSite, TrialStatus } from '@/types/api';

export interface TrialFilters { page?: number; pageSize?: number; status?: TrialStatus; phase?: TrialPhase; search?: string; sort?: 'createdAt' | 'code' | 'title' | 'startDate'; order?: 'asc' | 'desc' }
export interface TrialInput { code: string; title: string; description?: string; sponsor: string; phase: TrialPhase; startDate?: string; endDate?: string }
export interface SiteInput { siteCode: string; name: string; city?: string; country: string }
export interface EnrollmentFilters { page?: number; pageSize?: number; trialId?: string; patientId?: string; trialSiteId?: string; status?: EnrollmentStatus }

export const trialsApi = {
  list: (f: TrialFilters = {}) => getPage<Trial>('/trials', f),
  get: (id: string) => get<Trial>(`/trials/${id}`),
  create: (b: TrialInput) => post<Trial>('/trials', b),
  update: (id: string, b: Partial<Omit<TrialInput, 'code'>> & { status?: TrialStatus }) => patch<Trial>(`/trials/${id}`, b),
  sites: (id: string) => get<TrialSite[]>(`/trials/${id}/sites`),
  addSite: (id: string, b: SiteInput) => post<TrialSite>(`/trials/${id}/sites`, b),
};

export const enrollmentsApi = {
  list: (f: EnrollmentFilters = {}) => getPage<Enrollment>('/enrollments', f),
  get: (id: string) => get<Enrollment>(`/enrollments/${id}`),
  create: (b: { patientId: string; trialId: string; trialSiteId: string; arm?: string }) => post<Enrollment>('/enrollments', b),
  setStatus: (id: string, status: EnrollmentStatus) => patch<Enrollment>(`/enrollments/${id}`, { status }),
};
