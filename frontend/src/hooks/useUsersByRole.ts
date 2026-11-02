import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { usersApi } from '@/api/users';
import { useAuth } from '@/contexts/AuthContext';
import type { Role } from '@/types/api';

/** Active users of a role, for pickers (principal investigator, assignee, portal-account link). `/users` is admin-only, so non-admins get an empty, disabled result. */
export function useUsersByRole(role: Role, enabled = true) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  return { isAdmin, ...useQuery({
    queryKey: ['users-by-role', role],
    queryFn: () => fetchAll((page) => usersApi.list({ page, pageSize: 100, role, isActive: 'true' })),
    enabled: isAdmin && enabled,
    staleTime: 60_000,
  }) };
}
