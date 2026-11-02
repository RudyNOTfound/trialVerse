import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import { usersApi } from '@/api/users';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect, SearchBox } from '@/components/common/FilterBar';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { RowActions } from '@/components/common/RowActions';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate, formatDateTime } from '@/utils/format';
import { ROLE_LABEL } from '@/utils/roles';
import type { Role, User } from '@/types/api';
import { UserDetailDialog } from './UserDetailDialog';
import { UserFormDialog } from './UserFormDialog';

const ROLES: Role[] = ['admin', 'coordinator', 'investigator', 'patient'];

export default function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<{ open: boolean; user?: User }>({ open: false });
  const [viewing, setViewing] = useState<string | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  const debounced = useDebounce(search);
  const filters = { page, pageSize: 15, search: debounced, role: (role || undefined) as Role | undefined, isActive: (active || undefined) as 'true' | 'false' | undefined };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['users', filters], queryFn: () => usersApi.list(filters), placeholderData: (p) => p });

  const toggle = useMutation({
    mutationFn: (u: User) => usersApi.update(u.id, { isActive: !u.isActive }),
    onSuccess: (u) => { toast.success(`${u.fullName} ${u.isActive ? 'activated' : 'deactivated'}`); for (const k of ['users', 'user', 'users-by-role', 'directory']) qc.invalidateQueries({ queryKey: [k] }); },
  });

  return (
    <>
      <PageHeader title="User management" description="Staff and participant accounts. Administrator access only."
        actions={<Button onClick={() => setForm({ open: true })}><Plus className="h-4 w-4" />New user</Button>} />
      <FilterBar>
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name or email" />
        <FilterSelect value={role} onChange={(v) => { setRole(v); setPage(1); }} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} allLabel="All roles" label="Filter by role" />
        <FilterSelect value={active} onChange={(v) => { setActive(v); setPage(1); }} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Deactivated' }]} allLabel="Any status" label="Filter by status" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(u) => u.id} onRowClick={(u) => setViewing(u.id)}
        emptyTitle="No users found" emptyDescription="Try changing your filters."
        columns={[
          { header: 'Name', cell: (u) => <div><p className="font-medium text-ink">{u.fullName}{u.id === me?.id && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}</p><p className="text-xs text-muted">{u.email}</p></div> },
          { header: 'Role', cell: (u) => <Badge tone={u.role === 'admin' ? 'violet' : u.role === 'patient' ? 'neutral' : 'blue'}>{ROLE_LABEL[u.role]}</Badge> },
          { header: 'Status', cell: (u) => <Badge tone={u.isActive ? 'green' : 'neutral'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge> },
          { header: 'Last login', cell: (u) => formatDateTime(u.lastLoginAt), hideOnMobile: true },
          { header: 'Created', cell: (u) => formatDate(u.createdAt), hideOnMobile: true },
          { header: '', className: 'w-10 text-right', cell: (u) => (
            <RowActions label={`Actions for ${u.fullName}`} actions={[
              { label: 'View', icon: <Eye className="h-4 w-4" />, onSelect: () => setViewing(u.id) },
              { label: 'Edit', icon: <Pencil className="h-4 w-4" />, onSelect: () => setForm({ open: true, user: u }) },
              { label: u.isActive ? 'Deactivate' : 'Activate', icon: u.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />, danger: u.isActive, hidden: u.id === me?.id,
                onSelect: () => (u.isActive ? setToggling(u) : toggle.mutate(u, { onError: (e) => toast.error((e as Error).message) })) },
            ]} />
          ) },
        ]} />
      <UserFormDialog open={form.open} user={form.user} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} />
      <UserDetailDialog id={viewing} onClose={() => setViewing(null)} onEdit={(u) => { setViewing(null); setForm({ open: true, user: u }); }} />
      <ConfirmDialog open={!!toggling} onOpenChange={(o) => !o && setToggling(null)} title={`Deactivate ${toggling?.fullName ?? 'user'}?`}
        description="They will be signed out of all requests immediately and cannot log in until reactivated. Their records are kept." confirmLabel="Deactivate"
        onConfirm={() => toggle.mutateAsync(toggling!)} />
    </>
  );
}
