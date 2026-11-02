import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { reimbursementsApi } from '@/api/reimbursements';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState, ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ReimbursementFormDialog } from '@/features/reimbursements/ReimbursementFormDialog';
import { formatDate, formatDateTime, formatMoney, humanize } from '@/utils/format';
import type { Reimbursement } from '@/types/api';
import { useMyPatient, useMyReimbursements } from './hooks';

export default function ParticipantReimbursements() {
  const list = useMyReimbursements();
  const patient = useMyPatient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Reimbursement | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Reimbursements</h1><Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New claim</Button></div>
      {list.isLoading ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : list.error ? <Card><ErrorState error={list.error} onRetry={() => list.refetch()} /></Card>
        : !list.data?.items.length ? <Card><EmptyState title="No claims yet" description="Submit a claim for travel or other expenses related to a visit." /></Card>
        : list.data.items.map((r) => (
          <button key={r.id} className="block w-full text-left" onClick={() => setSelected(r)}>
            <Card className="flex items-center justify-between gap-3 p-4 transition-shadow hover:shadow-md">
              <div><p className="text-sm font-medium capitalize">{r.category}</p><p className="text-xs text-muted">{formatDate(r.createdAt)}</p></div>
              <div className="text-right"><p className="text-sm font-semibold tabular-nums">{formatMoney(r.amountCents, r.currency)}</p><StatusBadge value={r.status === 'approved' ? r.paymentStatus === 'none' ? 'approved' : r.paymentStatus : r.status} /></div>
            </Card>
          </button>
        ))}
      <ReimbursementFormDialog open={creating} onOpenChange={(o) => { setCreating(o); if (!o) list.refetch(); }} patientId={patient.data?.id} />
      <ClaimDialog claim={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function ClaimDialog({ claim, onClose }: { claim: Reimbursement | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const history = useQuery({ queryKey: ['reimbursement-history', claim?.id], queryFn: () => reimbursementsApi.history(claim!.id), enabled: !!claim });
  const cancel = useMutation({
    mutationFn: () => reimbursementsApi.cancel(claim!.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me', 'reimbursements'] }); onClose(); },
    onError: setError,
  });
  return (
    <>
      <Dialog open={!!claim && !editing} onOpenChange={(o) => { if (!o) { setError(null); onClose(); } }}>
        <DialogContent title="Claim details">
          {claim && (
            <div className="space-y-4">
              <div className="flex items-end justify-between"><p className="text-3xl font-semibold tabular-nums">{formatMoney(claim.amountCents, claim.currency)}</p><div className="flex gap-2"><StatusBadge value={claim.status} />{claim.status === 'approved' && <StatusBadge value={claim.paymentStatus} />}</div></div>
              <p className="text-sm capitalize text-slate-700">{claim.category}{claim.description ? ` · ${claim.description}` : ''}</p>
              {claim.rejectionReason && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">Reason: {claim.rejectionReason}</p>}
              {claim.transactionRef && <p className="text-xs text-muted">Payment reference: <span className="font-mono">{claim.transactionRef}</span></p>}
              {claim.status === 'pending' && (
                <div className="flex gap-2"><Button variant="outline" onClick={() => setEditing(true)}>Edit</Button><Button variant="danger-outline" loading={cancel.isPending} onClick={() => { if (window.confirm('Cancel this claim?')) cancel.mutate(); }}>Cancel claim</Button></div>
              )}
              <InlineError error={error} />
              <ol className="space-y-2 border-l border-line pl-4">
                {(history.data ?? []).map((h) => <li key={h.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />{humanize(h.toStatus)}<span className="block text-xs text-muted">{formatDateTime(h.createdAt)}</span></li>)}
              </ol>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {claim && <ReimbursementFormDialog open={editing} existing={claim} onOpenChange={(o) => { setEditing(o); if (!o) { qc.invalidateQueries({ queryKey: ['me', 'reimbursements'] }); onClose(); } }} />}
    </>
  );
}
