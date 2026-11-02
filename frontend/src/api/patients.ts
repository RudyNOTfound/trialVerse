import { get, getPage, patch, post } from './client';
import type { Patient, PatientStatus, Sex } from '@/types/api';

export interface PatientFilters { page?: number; pageSize?: number; search?: string; status?: PatientStatus; trialId?: string; sort?: 'createdAt' | 'lastName' | 'subjectCode'; order?: 'asc' | 'desc' }
export interface PatientInput {
  subjectCode?: string; firstName: string; lastName: string; dateOfBirth: string; sex: Sex; email?: string; phone?: string;
}

export const patientsApi = {
  list: (f: PatientFilters = {}) => getPage<Patient>('/patients', f),
  get: (id: string) => get<Patient>(`/patients/${id}`),
  me: () => get<Patient>('/patients/me'),
  create: (b: PatientInput) => post<Patient>('/patients', b),
  update: (id: string, b: Partial<PatientInput> & { status?: PatientStatus }) => patch<Patient>(`/patients/${id}`, b),
};
