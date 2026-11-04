import { useQuery } from '@tanstack/react-query';
import { patientsApi } from '@/api/patients';
import { enrollmentsApi } from '@/api/trials';
import { visitsApi } from '@/api/visits';
import { reimbursementsApi } from '@/api/reimbursements';

// All of these endpoints are scoped server-side to the signed-in patient; no patient id is ever sent by the client.
export const useMyPatient = () => useQuery({ queryKey: ['me', 'patient'], queryFn: patientsApi.me });
export const useMyEnrollments = () => useQuery({ queryKey: ['me', 'enrollments'], queryFn: () => enrollmentsApi.list({ pageSize: 100 }) });
export const useMyVisits = () => useQuery({ queryKey: ['me', 'visits'], queryFn: () => visitsApi.list({ pageSize: 100, sort: 'scheduledAt', order: 'asc' }) });
export const useMyReimbursements = () => useQuery({ queryKey: ['me', 'reimbursements'], queryFn: () => reimbursementsApi.list({ pageSize: 100, sort: 'createdAt', order: 'desc' }) });
