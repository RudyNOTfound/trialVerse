import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { usersApi } from '@/api/users';
import { useAuth } from '@/contexts/AuthContext';

/** Active staff accounts (everyone except patients). Admin-only data; others get an empty, disabled result. */
export function useStaffUsers(enabled = true) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const q = useQuery({
    queryKey: ['users-by-role', 'staff'],
    queryFn: async () => (await fetchAll((page) => usersApi.list({ page, pageSize: 100, isActive: 'true' }))).filter((u) => u.role !== 'patient'),
    enabled: isAdmin && enabled, staleTime: 60_000,
  });
  return { isAdmin, ...q };
}
