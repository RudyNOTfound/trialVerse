import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ClipboardCheck, Play, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { riskApi } from '@/api/risk';
import { CountBars, LEVEL_COLORS, ScoreBar } from '@/components/charts/Charts';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterBar, FilterSelect, SearchBox } from '@/components/common/FilterBar';
import { PageHeader } from '@/components/common/PageHeader';
import { StatCard } from '@/components/common/StatCard';
import { ErrorState } from '@/components/common/States';
import { StatusBadge } from '@/components/common/StatusBadge';
import { DataTable } from '@/components/tables/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { needsAttention, RISK_LEVELS, riskSource, SOURCE_LABEL } from '@/lib/ml';
import { formatDateTime } from '@/utils/format';
import type { Enrollment, RiskAssessment } from '@/types/api';
import { RiskDetailPanel } from './RiskDetailPanel';
import { isSyntheticTrial, useLatestPatientRisk, useRoster, useTrials } from './hooks';

const PAGE_SIZE = 25;
/** Ranked and counted only when a real result exists: a fallback result says the model was NOT consulted. */
const isScored = (r: { risk?: RiskAssessment }) => !!r.risk && !r.risk.fallback.used;

/** `risk` = what the participant is ranked and counted by (latest non-fallback result, else the latest fallback). `newest` = the most recent attempt of any kind. */
interface Row { enrollment: Enrollment; risk?: RiskAssessment; newest?: RiskAssessment }

/**
 * Participants of one trial with their latest stored risk assessment (GET /enrollments + GET /risk/assessments).
 * Running an assessment calls POST /risk/assessments, which the backend forwards to the ML service; this page never talks to Python.
 * `patientBase` (e.g. "/app/patients") turns participant names into links where that workspace has patient pages.
 */
export default function ParticipantRiskPage({ patientBase }: { patientBase?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const trials = useTrials();
  const [trialPick, setTrialPick] = useState('');
  const trial = (trials.data ?? []).find((t) => t.id === trialPick) ?? (trials.data ?? []).find((t) => t.status === 'active') ?? trials.data?.[0];
  const roster = useRoster(trial?.id);
  const risk = useLatestPatientRisk();
  const [search, setSearch] = useState('');
  const [view, setView] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);   // patientId
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => (roster.data ?? []).map((enrollment) => {
    const newest = risk.latest.get(enrollment.patientId);
    return { enrollment, newest, risk: risk.latestValid.get(enrollment.patientId) ?? newest };
  }), [roster.data, risk.latest, risk.latestValid]);
  const q = search.trim().toLowerCase();
  const filtered = rows
    .filter((r) => !q || `${r.enrollment.patientName ?? ''} ${r.enrollment.patientCode ?? ''} ${r.enrollment.siteName ?? ''}`.toLowerCase().includes(q))
    .filter((r) => view === 'attention' ? isScored(r) && needsAttention(r.risk!.level) : view === 'unassessed' ? !isScored(r) : view === 'assessed' ? isScored(r) : true)
    // highest score first, unassessed last
    .sort((a, b) => (isScored(b) ? b.risk!.score : -1) - (isScored(a) ? a.risk!.score : -1) || (a.enrollment.patientCode ?? '').localeCompare(b.enrollment.patientCode ?? ''));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pages) - 1) * PAGE_SIZE, Math.min(page, pages) * PAGE_SIZE);

  const assessed = rows.filter(isScored);                                  // a fallback result is NOT counted as assessed
  const fallbackOnly = rows.filter((r) => r.risk && !isScored(r));
  const attention = assessed.filter((r) => needsAttention(r.risk!.level));
  const byLevel = Object.fromEntries(RISK_LEVELS.map((l) => [l, assessed.filter((r) => r.risk!.level === l).length]));

  const assess = useMutation({
    mutationFn: (patientId: string) => riskApi.assess('patient', patientId),
    onMutate: (id) => setBusyId(id),
    onSettled: () => setBusyId(null),
    onSuccess: (a) => { qc.invalidateQueries({ queryKey: ['risk'] }); qc.invalidateQueries({ queryKey: ['sponsor'] }); setSelected(a.entityId); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  /**
   * Sequential on purpose: each call may reach the ML service. Reports exactly how many were stored; a failure stops the run, the
   * stored results are always shown (the cache is refreshed in `finally`), and the message says what was and was not assessed.
   */
  const runBulk = async () => {
    const targets = visible.filter((r) => !isScored(r)).map((r) => r.enrollment.patientId);
    let done = 0;
    setBulk({ done, total: targets.length });
    try {
      for (const id of targets) { await riskApi.assess('patient', id); done++; setBulk({ done, total: targets.length }); }
    } catch (e) {
      throw new Error(`Assessed ${done} of ${targets.length} before an error: ${errorMessage(e)}. ${done} result${done === 1 ? ' was' : 's were'} stored; the other ${targets.length - done} (including the one that failed) ${targets.length - done === 1 ? 'was' : 'were'} not assessed.`);
    } finally {
      setBulk(null);
      await qc.invalidateQueries({ queryKey: ['risk'] });
    }
    toast.success(`Assessed ${targets.length} participant${targets.length === 1 ? '' : 's'}`);
  };
  const unassessedOnPage = visible.filter((r) => !isScored(r)).length;
  const selectedRow = rows.find((r) => r.enrollment.patientId === selected);
  const nameOf = (r: Row) => r.enrollment.patientName ?? r.enrollment.patientCode ?? 'Participant';
  const synthetic = isSyntheticTrial(trial);

  return (
    <>
      <PageHeader title="Participant risk" description="Dropout risk for each participant in a trial, scored by the retention model through the TrialVerse backend."
        actions={<Button variant="outline" disabled={unassessedOnPage === 0} onClick={() => setBulkOpen(true)}><Play className="h-4 w-4" />{unassessedOnPage ? `Assess ${unassessedOnPage} unassessed on this page` : 'No unassessed participants on this page'}</Button>} />

      <FilterBar>
        <Select className="w-auto min-w-56" value={trial?.id ?? ''} onChange={(e) => { setTrialPick(e.target.value); setPage(1); }} aria-label="Trial" disabled={!trials.data?.length}>
          {(trials.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}
        </Select>
        {synthetic && <Badge tone="violet">Synthetic demo data: not real participants</Badge>}
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name, code or site" />
        <FilterSelect value={view} onChange={(v) => { setView(v); setPage(1); }} allLabel="All participants" label="Show"
          options={[{ value: 'attention', label: 'Needs attention (high / critical)' }, { value: 'assessed', label: 'Assessed' }, { value: 'unassessed', label: 'Not yet assessed' }]} />
      </FilterBar>

      {bulk && <p role="status" className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900" data-testid="bulk-progress">Assessing {bulk.done} of {bulk.total}…</p>}
      {trials.error && <Card className="mb-4"><ErrorState error={trials.error} onRetry={() => trials.refetch()} /></Card>}
      {risk.error && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Could not load stored risk assessments: {errorMessage(risk.error)}</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Participants" value={roster.data?.length} icon={Users} loading={roster.isLoading} hint={trial ? `Enrolled in ${trial.code}` : undefined} />
        <StatCard label="Assessed" value={assessed.length} icon={ClipboardCheck} tone="green" loading={roster.isLoading || risk.isLoading} hint="Latest stored assessment" />
        <StatCard label="Needs attention" value={attention.length} icon={AlertTriangle} tone="red" loading={roster.isLoading || risk.isLoading} hint="High or critical level" />
        <StatCard label="Not yet assessed" value={rows.length - assessed.length} icon={Activity} tone="amber" loading={roster.isLoading || risk.isLoading} hint={fallbackOnly.length ? `Includes ${fallbackOnly.length} where the ML service was unavailable` : undefined} />
      </div>

      {assessed.length > 0 && (
        <Card className="mt-6">
          <CardHeader><div><CardTitle>Assessed participants by risk level</CardTitle><CardDescription>Counts of the latest assessment per participant ({assessed.length} of {rows.length} assessed)</CardDescription></div></CardHeader>
          <div className="p-4"><CountBars data={RISK_LEVELS.map((name) => ({ name, value: byLevel[name] ?? 0 }))} colors={LEVEL_COLORS} height={160} /></div>
        </Card>
      )}

      <div className="mt-6">
        <DataTable rows={visible} rowKey={(r) => r.enrollment.patientId} loading={roster.isLoading || trials.isLoading} error={roster.error} onRetry={() => roster.refetch()}
          onRowClick={(r) => setSelected(r.enrollment.patientId)} meta={{ page: Math.min(page, pages), pageSize: PAGE_SIZE, total: filtered.length, totalPages: pages }} onPageChange={setPage}
          emptyTitle={rows.length === 0 ? 'No participants in this trial' : 'No participants match'} emptyDescription={rows.length === 0 ? 'Enrol participants first.' : 'Change the search or the filter.'}
          columns={[
            { header: 'Participant', cell: (r) => <div><p className="font-medium">{nameOf(r)}</p><p className="text-xs text-muted">{r.enrollment.patientCode}</p></div> },
            { header: 'Site', cell: (r) => r.enrollment.siteName ?? '—', hideOnMobile: true },
            { header: 'Enrollment', cell: (r) => <StatusBadge value={r.enrollment.status} />, hideOnMobile: true },
            { header: 'Risk', cell: (r) => isScored(r) ? <ScoreBar score={r.risk!.score} level={r.risk!.level} /> : r.risk ? <Badge tone="amber">ML unavailable</Badge> : <span className="text-sm text-muted">Not assessed</span> },
            { header: 'Level', cell: (r) => isScored(r) ? <StatusBadge value={r.risk!.level} /> : '—' },
            { header: 'Source', cell: (r) => r.risk ? (
              <div className="text-xs"><span className="text-slate-600">{SOURCE_LABEL[riskSource(r.risk)]}</span>
                {r.newest && r.newest.fallback.used && r.risk !== r.newest && <p className="mt-0.5 text-amber-700" data-testid="newer-fallback">Latest attempt used the rule engine (ML unavailable)</p>}</div>
            ) : '—', hideOnMobile: true },
            { header: 'Assessed', cell: (r) => (r.risk ? formatDateTime(r.risk.assessedAt) : '—'), hideOnMobile: true },
            { header: '', cell: (r) => (
              <Button size="sm" variant="outline" loading={busyId === r.enrollment.patientId} onClick={(e) => { e.stopPropagation(); assess.mutate(r.enrollment.patientId); }}>
                {r.risk ? 'Re-assess' : 'Assess'}
              </Button>
            ) },
          ]} />
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent title="Participant risk assessment" description={selectedRow ? `${nameOf(selectedRow)} · ${selectedRow.enrollment.patientCode ?? ''}` : undefined} className="max-w-xl">
          {selectedRow?.newest ?? selectedRow?.risk ? (
            <div className="space-y-4">
              <RiskDetailPanel assessment={(selectedRow!.newest ?? selectedRow!.risk)!} subject={nameOf(selectedRow!)} synthetic={synthetic} lastValid={selectedRow!.risk && selectedRow!.risk !== selectedRow!.newest && !selectedRow!.risk.fallback.used ? selectedRow!.risk : undefined} />
              <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
                {patientBase ? <Link className="text-sm text-brand-700 hover:underline" to={`${patientBase}/${selectedRow.enrollment.patientId}`}>Open participant record</Link> : <span />}
                <Button variant="outline" loading={assess.isPending && busyId === selectedRow.enrollment.patientId} onClick={() => assess.mutate(selectedRow.enrollment.patientId)}>Re-run assessment</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-slate-700">This participant has no stored assessment yet.</p>
              <div className="flex justify-end"><Button loading={assess.isPending} onClick={() => selectedRow && assess.mutate(selectedRow.enrollment.patientId)}>Run assessment</Button></div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={bulkOpen} onOpenChange={setBulkOpen} title={`Assess ${unassessedOnPage} participant${unassessedOnPage === 1 ? '' : 's'}?`}
        description="Each participant is scored one after another through the backend (and the ML service when it is enabled). Every result is stored with the audit trail. This can take a while." confirmLabel="Run assessments" confirmVariant="primary" onConfirm={runBulk} />
    </>
  );
}
