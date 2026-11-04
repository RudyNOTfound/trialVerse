import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { usersApi } from '@/api/users';
import type { StaffEntry } from '@/types/api';

/** Active staff for pickers (principal investigator, assignee). Uses the staff-readable directory, so it works for coordinators and investigators too. */
export function useStaffDirectory(opts: { role?: StaffEntry['role']; enabled?: boolean } = {}) {
  const { role, enabled = true } = opts;
  return useQuery({
    queryKey: ['staff-directory', role ?? 'all'],
    queryFn: () => fetchAll((page) => usersApi.directory({ page, pageSize: 100, role })),
    enabled, staleTime: 60_000,
  });
}
