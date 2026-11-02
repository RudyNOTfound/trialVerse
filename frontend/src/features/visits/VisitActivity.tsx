import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { auditApi } from '@/api/audit';
import { Skeleton } from '@/components/common/States';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDateTime, humanize } from '@/utils/format';
import type { AuditEvent } from '@/types/api';

function detail(e: AuditEvent): string | null {
  const m = e.metadata as { changedFields?: string[]; scheduledAt?: { from: string; to: string }; from?: string; to?: string; reason?: string; attempt?: number; maxAttempts?: number };
  if (e.action === 'visit.updated' && m.changedFields) {
    const parts = [`changed ${m.changedFields.map(humanize).join(', ').toLowerCase()}`];
    if (m.scheduledAt) parts.push(`${formatDateTime(m.scheduledAt.from)} → ${formatDateTime(m.scheduledAt.to)}`);
    return parts.join(' · ');
  }
  if (m.from && m.to) return `${humanize(m.from)} → ${humanize(m.to)}`;
  if (e.action === 'otp.verify_failed') return `${humanize(m.reason ?? 'failed')}${m.attempt ? ` (attempt ${m.attempt}/${m.maxAttempts})` : ''}`;
  return null;
}

/** Visit history from the audit log. The audit API is admin/investigator only, so coordinators get an explanatory note instead of a failing request. */
export function VisitActivity({ visitId }: { visitId: string }) {
  const { hasRole } = useAuth();
  const dir = useDirectory();
  const allowed = hasRole('admin', 'investigator');
  const q = useQuery({ queryKey: ['visit-activity', visitId], queryFn: () => auditApi.list({ entityType: 'visit', entityId: visitId, order: 'asc', pageSize: 100 }), enabled: allowed });
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4 text-brand-600" />Visit history</CardTitle></CardHeader>
      <CardContent>
        {!allowed ? <p className="text-sm text-muted">The detailed audit trail is available to investigators and administrators.</p>
          : q.isLoading ? <Skeleton className="h-24" />
          : q.error ? <p className="text-sm text-red-600">Could not load history: {(q.error as Error).message}</p>
          : !q.data?.items.length ? <p className="text-sm text-muted">No recorded events yet.</p> : (
            <ol className="space-y-3 border-l border-line pl-4">
              {q.data.items.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />
                  <span className="font-medium">{humanize(e.action)}</span>{detail(e) && <span className="text-slate-600"> — {detail(e)}</span>}
                  <span className="block text-xs text-muted">{formatDateTime(e.createdAt)} · {dir.userName(e.actorId)}</span>
                </li>
              ))}
            </ol>
          )}
      </CardContent>
    </Card>
  );
}
