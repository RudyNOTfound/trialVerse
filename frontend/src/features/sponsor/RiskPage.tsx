import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { riskApi } from '@/api/risk';
import { visitsApi } from '@/api/visits';
import { reimbursementsApi } from '@/api/reimbursements';
import { ScoreBar } from '@/components/charts/Charts';
import { PageHeader } from '@/components/common/PageHeader';
import { FilterBar, FilterSelect } from '@/components/common/FilterBar';
import { ErrorState, InlineError, Skeleton } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { RiskDetailPanel } from '@/features/risk/RiskDetailPanel';
import { useDirectory } from '@/hooks/useDirectory';
import { riskSource, SOURCE_LABEL } from '@/lib/ml';
import { formatDate, formatDateTime, formatMoney, humanize, shortId } from '@/utils/format';
import type { RiskAssessment, RiskEntityType, RiskLevel } from '@/types/api';

const entityLabel = (a: Pick<RiskAssessment, 'entityType' | 'entityId' | 'entityName'>) => a.entityName ?? `${humanize(a.entityType)} ${shortId(a.entityId)}`;

export default function RiskPage() {
  const [level, setLevel] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const filters = { page, pageSize: 15, level: (level || undefined) as RiskLevel | undefined, entityType: (entityType || undefined) as RiskEntityType | undefined, sort: 'score' as const, order: 'desc' as const };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['risk', filters], queryFn: () => riskApi.list(filters), placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Risk assessments" description="Every stored risk assessment, with the engine that produced it and the factors behind the score."
        actions={<Button onClick={() => setRunning(true)}><Play className="h-4 w-4" />Run assessment</Button>} />
      <FilterBar>
        <FilterSelect value={level} onChange={(v) => { setLevel(v); setPage(1); }} options={['low', 'medium', 'high', 'critical']} allLabel="All levels" label="Filter by level" />
        <FilterSelect value={entityType} onChange={(v) => { setEntityType(v); setPage(1); }} options={['patient', 'visit', 'reimbursement']} allLabel="All entity types" label="Filter by entity type" />
      </FilterBar>
      <DataTable rows={data?.items} meta={data?.meta} onPageChange={setPage} loading={isLoading} error={error} onRetry={() => refetch()} rowKey={(a) => a.id} onRowClick={(a) => setSelected(a.id)}
        emptyTitle="No risk assessments" emptyDescription="Run an assessment for a patient, visit or reimbursement."
        columns={[
          { header: 'Entity', cell: (a) => <div><p className="font-medium">{entityLabel(a)}</p><p className="text-xs capitalize text-muted">{a.entityType}</p></div> },
          { header: 'Score', cell: (a) => <ScoreBar score={a.score} level={a.level} /> },
          { header: 'Level', cell: (a) => <StatusBadge value={a.level} /> },
          { header: 'Engine', cell: (a) => <span className="text-xs text-slate-600">{SOURCE_LABEL[riskSource(a)]}</span>, hideOnMobile: true },
          { header: 'Assessed', cell: (a) => formatDateTime(a.assessedAt), hideOnMobile: true },
        ]} />
      <RunDialog open={running} onOpenChange={setRunning} onDone={(id) => setSelected(id)} />
      <DetailDialog id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function DetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const a = useQuery({ queryKey: ['risk-assessment', id], queryFn: () => riskApi.get(id!), enabled: !!id });
  const d = a.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Risk assessment" description={d ? `${entityLabel(d)} · ${humanize(d.entityType)}` : undefined} className="max-w-xl">
        {a.isLoading ? <Skeleton className="h-48" /> : a.error || !d ? <ErrorState error={a.error} onRetry={() => a.refetch()} /> : <RiskDetailPanel assessment={d} subject={entityLabel(d)} />}
      </DialogContent>
    </Dialog>
  );
}

function RunDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [type, setType] = useState<RiskEntityType>('patient');
  const [entityId, setEntityId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const visits = useQuery({ queryKey: ['visits', 'risk-picker'], enabled: open && type === 'visit', queryFn: () => visitsApi.list({ pageSize: 100, order: 'desc' }) });
  const reimbs = useQuery({ queryKey: ['reimbursements', 'risk-picker'], enabled: open && type === 'reimbursement', queryFn: () => reimbursementsApi.list({ pageSize: 100 }) });
  const m = useMutation({
    mutationFn: () => riskApi.assess(type, entityId),
    onSuccess: (a) => { qc.invalidateQueries({ queryKey: ['risk'] }); qc.invalidateQueries({ queryKey: ['sponsor'] }); setEntityId(''); onOpenChange(false); onDone(a.id); },
    onError: setError,
  });
  const options = type === 'patient' ? dir.patients.map((p) => ({ id: p.id, label: `${p.subjectCode} · ${p.firstName} ${p.lastName}` }))
    : type === 'visit' ? (visits.data?.items ?? []).map((v) => ({ id: v.id, label: `${v.patientName ?? '—'} · ${v.visitType} · ${formatDate(v.scheduledAt)}` }))
    : (reimbs.data?.items ?? []).map((r) => ({ id: r.id, label: `${r.patientName ?? '—'} · ${r.category} · ${formatMoney(r.amountCents, r.currency)}` }));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title="Run risk assessment" description="Evaluates the current data with the active risk engine (the ML model when it is enabled) and stores the result.">
        <div className="space-y-4">
          <Field label="Entity type"><Select value={type} onChange={(e) => { setType(e.target.value as RiskEntityType); setEntityId(''); }}><option value="patient">Patient</option><option value="visit">Visit</option><option value="reimbursement">Reimbursement</option></Select></Field>
          <Field label="Entity"><Select value={entityId} onChange={(e) => setEntityId(e.target.value)}><option value="">Select…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!entityId} loading={m.isPending} onClick={() => m.mutate()}>Run assessment</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
