import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, ShieldAlert, ShieldCheck } from 'lucide-react';
import { auditApi } from '@/api/audit';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar } from '@/components/common/FilterBar';
import { InlineError } from '@/components/common/States';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useDirectory } from '@/hooks/useDirectory';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { formatDateTime, humanize, shortId } from '@/utils/format';
import type { AuditEvent, ChainVerification } from '@/types/api';

const hashShort = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export default function AuditPage() {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const dAction = useDebounce(action);
  const dType = useDebounce(entityType);
  const filters = {
    page, pageSize: 20, order: 'desc' as const, action: dAction, entityType: dType,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
  };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['audit', filters], queryFn: () => auditApi.list(filters), placeholderData: (p) => p });

  const [result, setResult] = useState<ChainVerification | null>(null);
  const verify = useMutation({
    mutationFn: () => auditApi.verify(),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['audit'] }); }, // verification itself is recorded as a new audit event
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <>
      <PageHeader title="Audit log" description="Append-only, hash-chained record of every change."
        actions={<Button variant="navy" loading={verify.isPending} onClick={() => verify.mutate()}><ShieldCheck className="h-4 w-4" />Verify chain</Button>} />

      {(result || verify.error) && (
        <Card className={cn('mb-6 border-2', verify.error ? 'border-red-200' : result?.valid ? 'border-emerald-200' : 'border-red-300')}>
          <CardContent className="space-y-3">
            {verify.error ? <InlineError error={verify.error} /> : result && (
              <>
                <div className="flex items-start gap-3">
                  {result.valid ? <CheckCircle2 className="mt-0.5 h-6 w-6 text-emerald-600" /> : <ShieldAlert className="mt-0.5 h-6 w-6 text-red-600" />}
                  <div>
                    <p className={cn('font-semibold', result.valid ? 'text-emerald-800' : 'text-red-700')}>{result.valid ? 'Audit chain is intact' : 'Audit chain verification FAILED'}</p>
                    <p className="text-sm text-muted">{result.eventsChecked} events checked · head #{result.headSeq} · verified {formatDateTime(result.verifiedAt)}</p>
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-muted">Head hash (record this externally to anchor the chain)</p><HashText value={result.headHash} full /></div>
                {!result.valid && (
                  <ul className="space-y-1 text-sm text-red-700">
                    {result.errors.map((e, i) => <li key={i}><span className="font-mono text-xs">{e.type}{e.seq != null ? ` @#${e.seq}` : ''}</span> — {e.message}</li>)}
                    {result.errorsTruncated && <li className="text-xs text-muted">More errors exist than are shown.</li>}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <FilterBar>
        <Input className="w-full sm:w-56" placeholder="Action, e.g. otp.verified" value={action} onChange={(e) => reset(setAction)(e.target.value)} aria-label="Filter by action" />
        <Input className="w-full sm:w-44" placeholder="Entity type" value={entityType} onChange={(e) => reset(setEntityType)(e.target.value)} aria-label="Filter by entity type" />
        <Input className="w-auto" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} aria-label="From date" />
        <Input className="w-auto" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} aria-label="To date" />
      </FilterBar>

      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(e) => e.id} onRowClick={setSelected}
        emptyTitle="No audit events match" emptyDescription="Adjust the filters."
        columns={[
          { header: '#', cell: (e) => <span className="font-mono text-xs text-slate-500">{e.seq}</span> },
          { header: 'When', cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.createdAt)}</span> },
          { header: 'Action', cell: (e) => <span className="font-mono text-xs font-medium">{e.action}</span> },
          { header: 'Actor', cell: (e) => dir.userName(e.actorId), hideOnMobile: true },
          { header: 'Entity', cell: (e) => <span className="text-slate-600">{humanize(e.entityType)} <span className="font-mono text-xs text-muted">{shortId(e.entityId)}</span></span>, hideOnMobile: true },
          { header: 'Hash', cell: (e) => <span className="font-mono text-xs text-slate-500">{hashShort(e.hash)}</span>, hideOnMobile: true },
        ]} />

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent title={`Event #${selected?.seq ?? ''}`} description={selected?.action} className="max-w-xl">
          {selected && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-2 gap-3">
                <div><dt className="text-xs text-muted">Timestamp</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt className="text-xs text-muted">Actor</dt><dd>{dir.userName(selected.actorId)}</dd></div>
                <div><dt className="text-xs text-muted">Entity</dt><dd>{humanize(selected.entityType)}</dd></div>
                <div><dt className="text-xs text-muted">Entity id</dt><dd className="break-all font-mono text-xs">{selected.entityId}</dd></div>
              </dl>
              <div><p className="mb-1 text-xs text-muted">Previous hash</p><HashText value={selected.prevHash} full /></div>
              <div><p className="mb-1 text-xs text-muted">This event's hash</p><HashText value={selected.hash} full /></div>
              <div><p className="mb-1 text-xs text-muted">Metadata</p><pre className="max-h-48 overflow-auto rounded-lg bg-navy-950 p-3 text-xs text-blue-100">{JSON.stringify(selected.metadata, null, 2)}</pre></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function HashText({ value, full }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code className="break-all font-mono text-xs text-slate-700">{full ? value : hashShort(value)}</code>
      <button type="button" aria-label="Copy hash" className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
