import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { patientsApi } from '@/api/patients';

/** Registered participant accounts that are still unlinked (admin + coordinator). */
export function useLinkableAccounts(enabled = true) {
  return useQuery({
    queryKey: ['linkable-accounts'],
    queryFn: () => fetchAll((page) => patientsApi.linkableAccounts({ page, pageSize: 100 })),
    enabled, staleTime: 15_000,
  });
}
