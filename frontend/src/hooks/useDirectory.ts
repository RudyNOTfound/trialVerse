import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { patientsApi } from '@/api/patients';
import { trialsApi } from '@/api/trials';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Patient and trial option lists for pickers and filters. Display names no longer come from here: the API embeds
 * them in every response (patientName, trialCode, siteName, actorName ...). Pass `enabled: false` where no picker is shown.
 */
export function useDirectory(opts: { enabled?: boolean } = {}) {
  const { hasRole } = useAuth();
  const enabled = (opts.enabled ?? true) && !hasRole('patient'); // participants cannot list patients/trials (403)
  const patientsQ = useQuery({ queryKey: ['directory', 'patients'], queryFn: () => fetchAll((page) => patientsApi.list({ page, pageSize: 100 })), enabled, staleTime: 60_000 });
  const trialsQ = useQuery({ queryKey: ['directory', 'trials'], queryFn: () => fetchAll((page) => trialsApi.list({ page, pageSize: 100 })), enabled, staleTime: 60_000 });
  return useMemo(() => ({
    loading: patientsQ.isLoading || trialsQ.isLoading,
    patients: patientsQ.data ?? [],
    trials: trialsQ.data ?? [],
  }), [patientsQ.data, trialsQ.data, patientsQ.isLoading, trialsQ.isLoading]);
}
export type Directory = ReturnType<typeof useDirectory>;
