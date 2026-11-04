import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import riskJson from '@/test/fixtures/risk-ramesh.json';
import rosterJson from '@/test/fixtures/roster.json';
import trialJson from '@/test/fixtures/trial.json';
import { installFakeApi, page, type FakeReply } from '@/test/fakeApi';
import { renderWithApp } from '@/test/render';
import type { RiskAssessment } from '@/types/api';
import ParticipantRiskPage from './ParticipantRiskPage';
import { RiskDetailPanel } from './RiskDetailPanel';

const ramesh = riskJson as unknown as RiskAssessment;
let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());
const baseRoutes = (over: Record<string, FakeReply | ((r: never) => FakeReply | Promise<FakeReply>)> = {}) => ({
  'GET /trials': page([trialJson]),
  'GET /enrollments': (req: { params?: Record<string, unknown> }) => page(rosterJson, Number(req.params?.page ?? 1), Number(req.params?.pageSize ?? 100)),
  'GET /risk/assessments': (req: { params?: Record<string, unknown> }) => page([ramesh], Number(req.params?.page ?? 1), Number(req.params?.pageSize ?? 100)),
  'POST /risk/assessments': { status: 201, data: ramesh },
  ...over,
}) as never;
const rowOf = (text: string) => screen.getByText(text).closest('tr')!;

describe('RiskDetailPanel', () => {
  it('shows Ramesh\'s real result: score, level, ML-model source, every factor with its sign, and the engine\'s own explanation', () => {
    renderWithApp(<RiskDetailPanel assessment={ramesh} subject="Ramesh Verma" synthetic />);
    expect(screen.getByTestId('risk-score')).toHaveTextContent('69.2');
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByTestId('engine-banner')).toHaveAttribute('data-source', 'model');
    expect(screen.getByTestId('engine-banner')).toHaveTextContent('retention-dropout-risk');
    const factors = screen.getAllByTestId('factor');
    expect(factors).toHaveLength(ramesh.triggeredRules.length);
    expect(within(factors[0]!).getByText('Missed reminders')).toBeInTheDocument();
    expect(within(factors[0]!).getByText('+10.54')).toBeInTheDocument();
    expect(screen.getByText('-2.19')).toBeInTheDocument();                       // a factor that lowers the score is shown as such
    expect(screen.getByText(/Missed reminders: 2 raises the model's risk score by 10.5 points/)).toBeInTheDocument();
    expect(screen.getByTestId('risk-explanation')).toHaveTextContent(ramesh.explanation);
    expect(screen.getByText('Synthetic demo data')).toBeInTheDocument();
  });

  it('a fallback result is labelled as such, with the reason the backend gave (variant of the real fixture: fallback + baseline engine)', () => {
    const fb = { ...ramesh, engine: { name: 'baseline-rules', version: '1.0.0' }, fallback: { used: true, reason: 'unavailable: Model service is unreachable' } };
    renderWithApp(<RiskDetailPanel assessment={fb} />);
    const banner = screen.getByTestId('engine-banner');
    expect(banner).toHaveAttribute('data-source', 'fallback');
    expect(banner).toHaveTextContent('ML service unavailable');
    expect(banner).toHaveTextContent('unavailable: Model service is unreachable');
  });

  it('a fallback result is shown as "No ML result" (muted score, no level badge), and the last real result is named', () => {
    const fb = { ...ramesh, id: 'fb', score: 0, level: 'low' as const, triggeredRules: [], engine: { name: 'baseline-rules', version: '1.0.0' }, fallback: { used: true, reason: 'unavailable: Model service is unreachable' }, assessedAt: '2026-11-04T08:00:00.000Z' };
    renderWithApp(<RiskDetailPanel assessment={fb} lastValid={ramesh} />);
    expect(screen.getByText('No ML result')).toBeInTheDocument();
    expect(screen.getByText('Rule-engine score (not a model prediction)')).toBeInTheDocument();
    expect(screen.getByTestId('risk-score')).toHaveClass('text-slate-400');
    expect(screen.queryByText('Low')).not.toBeInTheDocument();                       // never presented as a reassuring risk level
    expect(screen.getByTestId('last-valid')).toHaveTextContent('69.2');
    expect(screen.getByTestId('last-valid')).toHaveTextContent('High');
  });

  it('a rule-engine result with ML switched off says so and does not claim ML', () => {
    const base = { ...ramesh, engine: { name: 'baseline-rules', version: '1.0.0' }, fallback: { used: false, reason: null }, triggeredRules: [] };
    renderWithApp(<RiskDetailPanel assessment={base} />);
    expect(screen.getByTestId('engine-banner')).toHaveAttribute('data-source', 'baseline');
    expect(screen.queryByText(/Scored by the ML model/)).not.toBeInTheDocument();
    expect(screen.getByText(/returned no contributing factors/)).toBeInTheDocument();     // nothing is made up
  });
});

describe('ParticipantRiskPage', () => {
  it('shows a loading indicator, then the roster with Ramesh\'s stored high-risk result and "Not assessed" for the rest', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    api = installFakeApi(baseRoutes({ 'GET /enrollments': async () => { await gate; return page(rosterJson); } }));
    renderWithApp(<ParticipantRiskPage patientBase="/app/patients" />);
    expect(await screen.findAllByRole('status', { name: 'Loading' })).not.toHaveLength(0);
    release();
    const row = await waitFor(() => rowOf('Ramesh Verma'));
    expect(within(row).getByText('69.2')).toBeInTheDocument();
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(within(row).getByText('ML model')).toBeInTheDocument();
    expect(screen.getAllByText('Not assessed')).toHaveLength(rosterJson.length - 1);
    expect(api.called('GET', '/enrollments')[0]!.params).toMatchObject({ trialId: trialJson.id });
    expect(screen.getByText(/Synthetic demo data/)).toBeInTheDocument();
  });

  // variants of the real fixture: a NEWER assessment where the ML service was unavailable (rule engine answered, score 0, level low)
  const newerFallback = { ...ramesh, id: 'fb-newer', score: 0, level: 'low' as const, triggeredRules: [], engine: { name: 'baseline-rules', version: '1.0.0' }, fallback: { used: true, reason: 'unavailable: Model service is unreachable' }, assessedAt: '2099-01-01T00:00:00.000Z' };

  it('an outage does not demote a real high-risk participant: ranking, counts and "needs attention" keep the last real result', async () => {
    api = installFakeApi(baseRoutes({ 'GET /risk/assessments': page([newerFallback, ramesh]) }));
    renderWithApp(<ParticipantRiskPage />);
    const row = await waitFor(() => rowOf('Ramesh Verma'));
    expect(within(row).getByText('69.2')).toBeInTheDocument();
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(within(row).getByTestId('newer-fallback')).toHaveTextContent('Latest attempt used the rule engine (ML unavailable)');
    const attention = screen.getByText('Needs attention').closest('div.p-5')!;
    expect(attention).toHaveTextContent('1');
    const assessed = screen.getByText('Assessed', { selector: 'p' }).closest('div.p-5')!;
    expect(assessed).toHaveTextContent('1');
    await userEvent.click(row);
    const dialog = await screen.findByRole('dialog');                                // the dialog shows the NEWEST attempt, honestly labelled ...
    expect(within(dialog).getByTestId('engine-banner')).toHaveAttribute('data-source', 'fallback');
    expect(within(dialog).getByText('No ML result')).toBeInTheDocument();
    expect(within(dialog).getByTestId('last-valid')).toHaveTextContent('69.2');      // ... and names the last real one
  });

  it('a participant whose only result is a fallback is not counted as assessed and shows "ML unavailable"', async () => {
    const other = rosterJson.find((r) => r.patientId !== ramesh.entityId)!;
    const only = { ...newerFallback, id: 'only-fb', entityId: other.patientId, entityName: other.patientName };
    api = installFakeApi(baseRoutes({ 'GET /risk/assessments': page([only]) }));
    renderWithApp(<ParticipantRiskPage />);
    const row = await waitFor(() => rowOf(other.patientName!));
    expect(within(row).getByText('ML unavailable')).toBeInTheDocument();
    expect(within(row).queryByText('Low')).not.toBeInTheDocument();
    expect(screen.getByText('Assessed', { selector: 'p' }).closest('div.p-5')).toHaveTextContent('0');
    expect(screen.getByText(/Includes 1 where the ML service was unavailable/)).toBeInTheDocument();
  });

  it('"Needs attention" keeps only participants whose latest level is high or critical', async () => {
    api = installFakeApi(baseRoutes());
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'attention');
    expect(screen.getByText('Ramesh Verma')).toBeInTheDocument();
    expect(screen.queryByText('Not assessed')).not.toBeInTheDocument();
  });

  it('opens a participant to show the factors behind the score, and re-runs the assessment through the backend', async () => {
    api = installFakeApi(baseRoutes());
    renderWithApp(<ParticipantRiskPage patientBase="/app/patients" />);
    await userEvent.click(await screen.findByText('Ramesh Verma'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('risk-score')).toHaveTextContent('69.2');
    expect(within(dialog).getAllByTestId('factor')).toHaveLength(ramesh.triggeredRules.length);
    expect(within(dialog).getByRole('link', { name: /Open participant record/ })).toHaveAttribute('href', `/app/patients/${ramesh.entityId}`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Re-run assessment' }));
    await waitFor(() => expect(api.called('POST', '/risk/assessments')).toHaveLength(1));
    expect(api.called('POST', '/risk/assessments')[0]!.body).toEqual({ entityType: 'patient', entityId: ramesh.entityId });
  });

  it('assesses a not-yet-assessed participant from the row', async () => {
    api = installFakeApi(baseRoutes());
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    const other = rosterJson.find((r) => r.patientId !== ramesh.entityId)!;
    await userEvent.click(within(rowOf(other.patientName!)).getByRole('button', { name: 'Assess' }));
    await waitFor(() => expect(api.called('POST', '/risk/assessments')).toHaveLength(1));
    expect(api.called('POST', '/risk/assessments')[0]!.body).toEqual({ entityType: 'patient', entityId: other.patientId });
  });

  it('bulk assessment asks for confirmation first, then assesses each unassessed participant on the page', async () => {
    api = installFakeApi(baseRoutes());
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    const n = rosterJson.length - 1;
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`Assess ${n} unassessed`) }));
    expect(api.called('POST', '/risk/assessments')).toHaveLength(0);                       // nothing happens before confirming
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run assessments' }));
    await waitFor(() => expect(api.called('POST', '/risk/assessments')).toHaveLength(n));
  });

  it('bulk assessment stopped by a failure says exactly how many were stored, never reports success, and still refreshes the stored results', async () => {
    let posts = 0;
    api = installFakeApi(baseRoutes({ 'POST /risk/assessments': () => (++posts === 3 ? { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Simulated failure' } } : { status: 201, data: ramesh }) }));
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    const n = rosterJson.length - 1;
    const listCalls = () => api.called('GET', '/risk/assessments').length;
    const before = listCalls();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`Assess ${n} unassessed`) }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run assessments' }));
    const msg = await screen.findByText(/Assessed 2 of \d+ before an error: Simulated failure/);
    expect(msg).toHaveTextContent('2 results were stored');
    expect(msg).toHaveTextContent(`the other ${n - 2} (including the one that failed) were not assessed`);
    expect(screen.queryByText(/^Assessed \d+ participants?$/)).not.toBeInTheDocument();       // no success toast
    expect(api.called('POST', '/risk/assessments')).toHaveLength(3);                           // stopped at the failure, did not keep going
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));                          // the stored results were re-read
    expect(screen.queryByTestId('bulk-progress')).not.toBeInTheDocument();
  });

  it('shows progress while a bulk run is in flight', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    api = installFakeApi(baseRoutes({ 'POST /risk/assessments': async () => { await gate; return { status: 201, data: ramesh }; } }));
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    const n = rosterJson.length - 1;
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`Assess ${n} unassessed`) }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run assessments' }));
    expect(await screen.findByTestId('bulk-progress')).toHaveTextContent(`Assessing 0 of ${n}`);
    release();
    await waitFor(() => expect(screen.queryByTestId('bulk-progress')).not.toBeInTheDocument());
  });

  it('shows an actionable error when the roster cannot be loaded, and retries', async () => {
    let fail = true;
    api = installFakeApi(baseRoutes({ 'GET /enrollments': () => (fail ? { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } } : page(rosterJson)) }));
    renderWithApp(<ParticipantRiskPage />);
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
    expect(screen.getByText('Unexpected error')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ramesh Verma')).toBeInTheDocument();
  });

  it('reports an unreachable ML/backend path to the user when an assessment cannot run', async () => {
    api = installFakeApi(baseRoutes({ 'POST /risk/assessments': { networkError: true } }));
    renderWithApp(<ParticipantRiskPage />);
    await userEvent.click(within(await waitFor(() => rowOf('Ramesh Verma'))).getByRole('button', { name: 'Re-assess' }));
    expect(await screen.findByText(/Cannot reach the TrialVerse API/)).toBeInTheDocument();
  });

  it('the bulk button never shows a blank count: with nothing to assess it says so and is disabled', async () => {
    api = installFakeApi(baseRoutes({ 'GET /risk/assessments': page(rosterJson.map((r, i) => ({ ...ramesh, id: `a${i}`, entityId: r.patientId, entityName: r.patientName }))) }));
    renderWithApp(<ParticipantRiskPage />);
    await screen.findByText('Ramesh Verma');
    const btn = await screen.findByRole('button', { name: 'No unassessed participants on this page' });
    expect(btn).toBeDisabled();
  });

  it('an empty trial says so instead of showing an empty table', async () => {
    api = installFakeApi(baseRoutes({ 'GET /enrollments': page([]) }));
    renderWithApp(<ParticipantRiskPage />);
    expect(await screen.findByText('No participants in this trial')).toBeInTheDocument();
  });

  it('a stored-assessments failure is shown without hiding the roster', async () => {
    api = installFakeApi(baseRoutes({ 'GET /risk/assessments': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'boom' } } }));
    renderWithApp(<ParticipantRiskPage />);
    expect(await screen.findByText(/Could not load stored risk assessments: boom/)).toBeInTheDocument();
    expect(await screen.findByText('Ramesh Verma')).toBeInTheDocument();
  });
});
