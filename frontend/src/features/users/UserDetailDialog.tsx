import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { usersApi } from '@/api/users';
import { ErrorState, Skeleton } from '@/components/common/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { formatDateTime } from '@/utils/format';
import { ROLE_LABEL } from '@/utils/roles';
import type { User } from '@/types/api';

export function UserDetailDialog({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (u: User) => void }) {
  const q = useQuery({ queryKey: ['user', id], queryFn: () => usersApi.get(id!), enabled: !!id });
  const u = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={u?.fullName ?? 'User'} description={u?.email}>
        {q.isLoading ? <Skeleton className="h-32" /> : q.error || !u ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <div className="space-y-4">
            <div className="flex gap-2"><Badge tone="blue">{ROLE_LABEL[u.role]}</Badge><Badge tone={u.isActive ? 'green' : 'neutral'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge></div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted">Last login</dt><dd className="font-medium">{formatDateTime(u.lastLoginAt)}</dd></div>
              <div><dt className="text-xs text-muted">Created</dt><dd className="font-medium">{formatDateTime(u.createdAt)}</dd></div>
              <div><dt className="text-xs text-muted">Updated</dt><dd className="font-medium">{formatDateTime(u.updatedAt)}</dd></div>
              <div><dt className="text-xs text-muted">User id</dt><dd className="break-all font-mono text-xs">{u.id}</dd></div>
            </dl>
            <div className="flex justify-end"><Button variant="outline" onClick={() => onEdit(u)}><Pencil className="h-4 w-4" />Edit</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
