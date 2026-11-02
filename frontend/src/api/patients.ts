import { del, get, getPage, patch, post } from './client';
import type { LinkableAccount, Patient, PatientStatus, Sex } from '@/types/api';

export interface PatientFilters { page?: number; pageSize?: number; search?: string; status?: PatientStatus; trialId?: string; sort?: 'createdAt' | 'lastName' | 'subjectCode'; order?: 'asc' | 'desc' }
export interface PatientInput {
  subjectCode?: string; firstName: string; lastName: string; dateOfBirth: string; sex: Sex; email?: string; phone?: string;
}

export const patientsApi = {
  list: (f: PatientFilters = {}) => getPage<Patient>('/patients', f),
  get: (id: string) => get<Patient>(`/patients/${id}`),
  me: () => get<Patient>('/patients/me'),
  create: (b: PatientInput) => post<Patient>('/patients', b),
  update: (id: string, b: Partial<PatientInput> & { status?: PatientStatus; userId?: string | null }) => patch<Patient>(`/patients/${id}`, b),
  /** Admin + coordinator: registered patient accounts not yet linked to a record. */
  linkableAccounts: (f: { page?: number; pageSize?: number; search?: string } = {}) => getPage<LinkableAccount>('/patients/linkable-accounts', f),
  linkAccount: (id: string, userId: string) => post<Patient>(`/patients/${id}/account`, { userId }),
  unlinkAccount: (id: string) => del<Patient>(`/patients/${id}/account`),
  /** Admin only. Soft delete; 409 if the patient has enrollments. */
  remove: (id: string) => del(`/patients/${id}`),
};
