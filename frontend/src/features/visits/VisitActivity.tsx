import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { visitsApi } from '@/api/visits';
import { Skeleton } from '@/components/common/States';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, humanize } from '@/utils/format';
import type { VisitHistoryEntry } from '@/types/api';

function detail(e: VisitHistoryEntry): string | null {
  const parts: string[] = [];
  if (e.changedFields?.length) parts.push(`changed ${e.changedFields.map(humanize).join(', ').toLowerCase()}`);
  if (e.scheduledAt) parts.push(`${formatDateTime(e.scheduledAt.from)} → ${formatDateTime(e.scheduledAt.to)}`);
  if (e.from && e.to) parts.push(`${humanize(e.from)} → ${humanize(e.to)}`);
  if (e.reason) parts.push(`${humanize(e.reason)}${e.attempt ? ` (attempt ${e.attempt}/${e.maxAttempts})` : ''}`);
  if (e.note) parts.push(e.note);
  return parts.length ? parts.join(' · ') : null;
}

/** Visit history from the dedicated, staff-readable endpoint (`GET /visits/:id/history`). */
export function VisitActivity({ visitId }: { visitId: string }) {
  const q = useQuery({ queryKey: ['visit-activity', visitId], queryFn: () => visitsApi.history(visitId) });
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4 text-brand-600" />Visit history</CardTitle></CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-24" />
          : q.error ? <p className="text-sm text-red-600">Could not load history: {(q.error as Error).message}</p>
          : !q.data?.length ? <p className="text-sm text-muted">No recorded events yet.</p> : (
            <ol className="space-y-3 border-l border-line pl-4">
              {q.data.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />
                  <span className="font-medium">{e.label}</span>{detail(e) && <span className="text-slate-600"> — {detail(e)}</span>}
                  <span className="block text-xs text-muted">{formatDateTime(e.at)} · {e.actor?.name ?? 'System'}</span>
                </li>
              ))}
            </ol>
          )}
      </CardContent>
    </Card>
  );
}
