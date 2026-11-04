import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrityApi } from '@/api/integrity';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useDirectory } from '@/hooks/useDirectory';
import { entityLabel } from '@/lib/ml';
import { formatDateTime, humanize } from '@/utils/format';
import { ALERT_NEXT } from '@/utils/transitions';
import type { AlertStatus } from '@/types/api';
import { EvidenceView } from './EvidenceView';

const ACTION_LABEL: Record<AlertStatus, string> = { open: 'Reopen', acknowledged: 'Acknowledge', resolved: 'Resolve', dismissed: 'Dismiss' };

/** Alert detail with the evidence and the status workflow. `siteName` resolves site ids (the trial monitor passes its sites). */
export function AlertDialog({ id, onClose, siteName }: { id: string | null; onClose: () => void; siteName?: (siteId: string) => string | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const a = useQuery({ queryKey: ['alert', id], queryFn: () => integrityApi.alert(id!), enabled: !!id });
  const change = useMutation({
    mutationFn: (status: AlertStatus) => integrityApi.updateAlert(id!, status, note.trim() || undefined),
    onSuccess: () => { setError(null); setNote(''); toast.success('Alert updated'); for (const k of ['alert', 'alerts', 'sponsor']) qc.invalidateQueries({ queryKey: [k] }); },
    onError: setError,
  });
  const d = a.data;
  const dir = useDirectory({ enabled: !!id });
  const patientLabel = useMemo(() => new Map(dir.patients.map((p) => [p.id, `${p.subjectCode} · ${p.firstName} ${p.lastName}`])), [dir.patients]);
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) { setError(null); setNote(''); onClose(); } }}>
      <DialogContent title="Integrity alert" className="max-w-xl">
        {a.isLoading ? <Skeleton className="h-48" /> : a.error || !d ? <ErrorState error={a.error} onRetry={() => a.refetch()} /> : (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2"><StatusBadge value={d.severity} /><StatusBadge value={d.status} /></div>
            <p className="text-sm font-medium text-ink">{d.message}</p>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted">Category / rule</dt><dd className="font-mono text-xs">{d.ruleId}</dd></div>
              <div><dt className="text-xs text-muted">Affected</dt><dd className="font-medium" data-testid="affected">{entityLabel(d, siteName)}</dd></div>
              <div><dt className="text-xs text-muted">Detected</dt><dd>{formatDateTime(d.detectedAt)}</dd></div>
              <div><dt className="text-xs text-muted">Source</dt><dd>{d.source}</dd></div>
              {d.resolvedAt && <div className="col-span-2"><dt className="text-xs text-muted">{humanize(d.status)} {formatDateTime(d.resolvedAt)} by {d.resolvedByName ?? 'Unknown'}</dt>{d.resolutionNote && <dd className="mt-0.5">{d.resolutionNote}</dd>}</div>}
            </dl>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Evidence</p>
              <EvidenceView alert={d} names={{ participant: (pid) => patientLabel.get(pid), site: siteName }} />
              <p className="mt-2 break-all font-mono text-[11px] text-slate-500">fingerprint {d.fingerprint}</p>
            </div>
            <div className="space-y-2 border-t border-line pt-4">
              <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-16" />
              <div className="flex flex-wrap gap-2">
                {ALERT_NEXT[d.status].map((s) => <Button key={s} size="sm" variant={s === 'resolved' ? 'primary' : s === 'dismissed' ? 'danger-outline' : 'outline'} loading={change.isPending && change.variables === s} onClick={() => change.mutate(s)}>{ACTION_LABEL[s]}</Button>)}
              </div>
              <InlineError error={error} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
