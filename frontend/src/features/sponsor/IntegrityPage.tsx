import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import { integrityApi } from '@/api/integrity';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { InlineError } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { formatDateTime, humanize, shortId } from '@/utils/format';
import { AlertDialog } from '@/features/integrity/AlertDialog';
import type { AlertStatus, IntegrityScanSummary, RiskLevel } from '@/types/api';

export default function IntegrityPage() {
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const filters = { page, pageSize: 15, status: (status || undefined) as AlertStatus | undefined, severity: (severity || undefined) as RiskLevel | undefined, sort: 'severity' as const, order: 'desc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['alerts', filters], queryFn: () => integrityApi.alerts(filters), placeholderData: (p) => p });
  const entityName = (a: { entityName?: string | null; entityType: string; entityId: string }) => a.entityName ?? `${humanize(a.entityType)} ${shortId(a.entityId)}`;

  return (
    <>
      <PageHeader title="Integrity alerts" description="Findings from the integrity rules over audit events and records."
        actions={<Button onClick={() => setScanOpen(true)}><ScanSearch className="h-4 w-4" />Run scan</Button>} />
      <FilterBar>
        <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['open', 'acknowledged', 'resolved', 'dismissed']} allLabel="All statuses" label="Filter by status" />
        <FilterSelect value={severity} onChange={(v) => { setSeverity(v); setPage(1); }} options={['low', 'medium', 'high', 'critical']} allLabel="All severities" label="Filter by severity" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(a) => a.id} onRowClick={(a) => setSelected(a.id)}
        emptyTitle="No alerts" emptyDescription="No alerts match these filters. Run a scan to check for new issues."
        columns={[
          { header: 'Severity', cell: (a) => <StatusBadge value={a.severity} /> },
          { header: 'Alert', cell: (a) => <div className="max-w-md"><p className="font-medium">{a.message}</p><p className="text-xs text-muted">{humanize(a.ruleId.replace(/^integrity\./, ''))}</p></div> },
          { header: 'Affected', cell: (a) => <span className="text-slate-700">{entityName(a)}</span>, hideOnMobile: true },
          { header: 'Detected', cell: (a) => formatDateTime(a.detectedAt), hideOnMobile: true },
          { header: 'Status', cell: (a) => <StatusBadge value={a.status} /> },
        ]} />
      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} />
      <AlertDialog id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function ScanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [hours, setHours] = useState('168');
  const [result, setResult] = useState<IntegrityScanSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: () => integrityApi.scan(Number(hours)),
    onSuccess: (r) => { setResult(r); setError(null); qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['sponsor'] }); },
    onError: setError,
  });
  const valid = Number.isInteger(Number(hours)) && Number(hours) >= 1 && Number(hours) <= 720;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) { setResult(null); setError(null); } onOpenChange(o); }}>
      <DialogContent title="Run integrity scan" description="Scans recent audit events and records. Repeated findings are de-duplicated, not re-raised.">
        {result ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat k="Events scanned" v={result.eventsScanned} /><Stat k="Findings" v={result.findings} /><Stat k="New alerts" v={result.newAlerts} /><Stat k="Already known" v={result.existingAlerts} />
            </dl>
            <p className="text-xs text-muted">Engine {result.engine.name} v{result.engine.version}{result.fallback.used ? ` · ML fallback used${result.fallback.reason ? ` (${result.fallback.reason})` : ''}` : ''}</p>
            <div className="flex justify-end"><Button onClick={() => onOpenChange(false)}>Done</Button></div>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Look-back window (hours)" hint="1–720 hours. Default is 168 (7 days)." error={valid ? undefined : 'Enter a whole number from 1 to 720'}><Input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
            <InlineError error={error} />
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>Run scan</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
const Stat = ({ k, v }: { k: string; v: number }) => <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-muted">{k}</dt><dd className="text-2xl font-semibold tabular-nums">{v}</dd></div>;
