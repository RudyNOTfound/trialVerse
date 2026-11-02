import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reimbursementsApi } from '@/api/reimbursements';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { formatDateTime, formatMoney, humanize } from '@/utils/format';
import { ReimbursementFormDialog } from './ReimbursementFormDialog';

/** Detail + workflow actions. Buttons mirror backend rules; the server remains authoritative (e.g. reviewer must differ from requester). */
export function ReimbursementDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { user, hasRole } = useAuth();
  const dir = useDirectory();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<'reject' | 'paid' | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const r = useQuery({ queryKey: ['reimbursement', id], queryFn: () => reimbursementsApi.get(id!), enabled: !!id });
  const history = useQuery({ queryKey: ['reimbursement-history', id], queryFn: () => reimbursementsApi.history(id!), enabled: !!id });

  const done = () => {
    setError(null); setMode(null); setText('');
    for (const k of ['reimbursement', 'reimbursement-history', 'reimbursements', 'overview']) qc.invalidateQueries({ queryKey: [k] });
  };
  const run = <A,>(fn: (a: A) => Promise<unknown>) => useMutation({ mutationFn: fn, onSuccess: () => { toast.success('Reimbursement updated'); done(); }, onError: setError });
  const approve = run(() => reimbursementsApi.approve(id!));
  const reject = run((reason: string) => reimbursementsApi.reject(id!, reason));
  const cancel = run(() => reimbursementsApi.cancel(id!));
  const pay = run((b: { status: 'processing' | 'paid' | 'failed'; transactionRef?: string }) => reimbursementsApi.payment(id!, b));

  const d = r.data;
  const isReviewer = hasRole('admin', 'investigator');
  const ownRequest = d && user && d.requestedBy === user.id;
  const busy = approve.isPending || reject.isPending || cancel.isPending || pay.isPending;

  return (
    <>
      <Dialog open={!!id && !editing} onOpenChange={(o) => { if (!o) { setMode(null); setError(null); onClose(); } }}>
        <DialogContent title="Reimbursement" description={d ? `${dir.patientName(d.patientId)} · ${dir.trialCode(d.trialId)}` : undefined} className="max-w-xl">
          {r.isLoading ? <Skeleton className="h-48" /> : r.error || !d ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : (
            <div className="space-y-5">
              <div className="flex items-end justify-between">
                <p className="text-3xl font-semibold tabular-nums">{formatMoney(d.amountCents, d.currency)}</p>
                <div className="flex gap-2"><StatusBadge value={d.status} /><StatusBadge value={d.paymentStatus} /></div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Item k="Category" v={<span className="capitalize">{d.category}</span>} /><Item k="Submitted" v={formatDateTime(d.createdAt)} />
                <Item k="Requested by" v={dir.userName(d.requestedBy)} /><Item k="Reviewed by" v={d.reviewedBy ? `${dir.userName(d.reviewedBy)} · ${formatDateTime(d.reviewedAt)}` : '—'} />
                {d.description && <div className="col-span-2"><Item k="Description" v={d.description} /></div>}
                {d.rejectionReason && <div className="col-span-2"><Item k="Rejection reason" v={<span className="text-red-700">{d.rejectionReason}</span>} /></div>}
                {d.transactionRef && <Item k="Transaction ref" v={<span className="font-mono text-xs">{d.transactionRef}</span>} />}
                {d.paidAt && <Item k="Paid" v={formatDateTime(d.paidAt)} />}
              </dl>

              {mode === 'reject' && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3"><Input autoFocus placeholder="Reason for rejection (min 3 characters)" value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="flex gap-2"><Button size="sm" variant="danger" disabled={text.trim().length < 3} loading={reject.isPending} onClick={() => reject.mutate(text.trim())}>Confirm rejection</Button><Button size="sm" variant="ghost" onClick={() => setMode(null)}>Back</Button></div></div>
              )}
              {mode === 'paid' && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3"><Input autoFocus placeholder="Transaction reference (required)" value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="flex gap-2"><Button size="sm" disabled={text.trim().length < 3} loading={pay.isPending} onClick={() => pay.mutate({ status: 'paid', transactionRef: text.trim() })}>Mark as paid</Button><Button size="sm" variant="ghost" onClick={() => setMode(null)}>Back</Button></div></div>
              )}

              {!mode && (
                <div className="flex flex-wrap gap-2">
                  {d.status === 'pending' && isReviewer && (
                    <>
                      <Button disabled={busy || !!ownRequest} loading={approve.isPending} onClick={() => approve.mutate(undefined)} title={ownRequest ? 'You cannot approve your own request' : undefined}>Approve</Button>
                      <Button variant="danger-outline" disabled={busy} onClick={() => { setText(''); setMode('reject'); }}>Reject</Button>
                    </>
                  )}
                  {d.status === 'pending' && hasRole('admin', 'coordinator') && <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Edit</Button>}
                  {(d.status === 'pending' || (d.status === 'approved' && (d.paymentStatus === 'unpaid' || d.paymentStatus === 'failed'))) && hasRole('admin', 'coordinator') && (
                    <Button variant="ghost" disabled={busy} loading={cancel.isPending} onClick={() => { if (window.confirm('Cancel this claim?')) cancel.mutate(undefined); }}>Cancel claim</Button>
                  )}
                  {d.status === 'approved' && hasRole('admin') && (
                    <>
                      {(d.paymentStatus === 'unpaid' || d.paymentStatus === 'failed') && <Button variant="navy" disabled={busy} loading={pay.isPending} onClick={() => pay.mutate({ status: 'processing' })}>Start payment</Button>}
                      {d.paymentStatus === 'processing' && <><Button variant="navy" disabled={busy} onClick={() => { setText(''); setMode('paid'); }}>Mark paid</Button><Button variant="danger-outline" disabled={busy} onClick={() => pay.mutate({ status: 'failed' })}>Mark failed</Button></>}
                    </>
                  )}
                </div>
              )}
              {ownRequest && isReviewer && d.status === 'pending' && <p className="text-xs text-muted">You submitted this claim, so a different reviewer must approve it.</p>}
              <InlineError error={error} />

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</p>
                {history.isLoading ? <Skeleton className="h-12" /> : (
                  <ol className="space-y-2 border-l border-line pl-4">
                    {(history.data ?? []).map((h) => (
                      <li key={h.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500" />
                        <span className="font-medium">{humanize(h.field)}:</span> {h.fromStatus ? `${humanize(h.fromStatus)} → ` : ''}{humanize(h.toStatus)}
                        <span className="block text-xs text-muted">{formatDateTime(h.createdAt)} · {dir.userName(h.actorId)}{h.note ? ` · ${h.note}` : ''}</span></li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {d && <ReimbursementFormDialog open={editing} onOpenChange={(o) => { setEditing(o); if (!o) done(); }} existing={d} />}
    </>
  );
}

const Item = ({ k, v }: { k: string; v: React.ReactNode }) => <div><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5 font-medium text-ink">{v}</dd></div>;
