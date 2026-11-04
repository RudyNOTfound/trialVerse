import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import alertsJson from '@/test/fixtures/alerts.json';
import historyJson from '@/test/fixtures/scan-history.json';
import scanJson from '@/test/fixtures/scan.json';
import sitesJson from '@/test/fixtures/sites.json';
import trialJson from '@/test/fixtures/trial.json';
import { installFakeApi, page, type FakeReply } from '@/test/fakeApi';
import { renderWithApp } from '@/test/render';
import { alertSiteIds, scopeAlerts } from '@/lib/ml';
import type { IntegrityAlert, IntegrityScanSummary, TrialSite } from '@/types/api';
import { EvidenceView } from './EvidenceView';
import { ScanResult } from './ScanResult';
import TrialIntegrityPage from './TrialIntegrityPage';

const alerts = alertsJson as unknown as IntegrityAlert[];
const sites = sitesJson as unknown as TrialSite[];
const scan = scanJson as unknown as IntegrityScanSummary;
const siteC = sites.find((s) => s.siteCode === 'SITE-C')!;
const { trial: trialAlerts, platform: platformAlerts } = scopeAlerts(alerts, sites.map((s) => s.id));
const names = (id: string) => sites.find((s) => s.id === id)?.siteCode ?? id.slice(0, 8);

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());

const routes = (over: Record<string, FakeReply | ((r: never) => FakeReply | Promise<FakeReply>)> = {}) => ({
  'GET /trials': page([trialJson]),
  'GET /trials/:id/sites': { data: sites },
  'GET /integrity/alerts': (req: { params?: Record<string, unknown> }) => page(alerts, Number(req.params?.page ?? 1), Number(req.params?.pageSize ?? 100)),
  'GET /integrity/alerts/:id': (req: { path: string }) => ({ data: alerts.find((a) => req.path.endsWith(a.id)) }),
  'GET /audit': (req: { params?: Record<string, unknown> }) => page(historyJson, Number(req.params?.page ?? 1), Number(req.params?.pageSize ?? 10)),
  'GET /patients': page([]),
  'POST /integrity/scans': { status: 201, data: scan },
  ...over,
}) as never;

describe('ScanResult keeps "failed", "fallback", "clean" and "findings" apart', () => {
  const sn = (id: string) => names(id);
  it('failure: says nothing was checked and that it is not the same as no findings, with the server message', () => {
    render(<ScanResult error={Object.assign(new Error('The model service timed out'), { name: 'Error' })} siteName={sn} />);
    expect(screen.getByTestId('scan-failed')).toHaveTextContent('nothing was checked');
    expect(screen.getByTestId('scan-failed')).toHaveTextContent('The model service timed out');
    expect(screen.getByTestId('scan-failed')).toHaveTextContent('not the same as "no findings"');
    expect(screen.queryByTestId('scan-clean')).not.toBeInTheDocument();
  });
  it('clean: a completed scan with zero findings', () => {
    render(<ScanResult result={{ ...scan, findings: 0, newAlerts: 0, existingAlerts: 0, alerts: [] }} siteName={sn} />);
    expect(screen.getByTestId('scan-clean')).toHaveTextContent('Scan completed with no findings');
    expect(screen.queryByTestId('scan-failed')).not.toBeInTheDocument();
  });
  it('findings: counts new vs already known, and names the engine that ran', () => {
    render(<ScanResult result={scan} siteName={sn} />);
    expect(screen.getByTestId('scan-summary')).toHaveTextContent(`${scan.findings} findings`);
    expect(screen.getByTestId('scan-summary')).toHaveTextContent(`${scan.newAlerts} new alerts raised, ${scan.existingAlerts} already known`);
    expect(screen.getByTestId('scan-summary')).toHaveTextContent('trialguard-integrity');
  });
  it('fallback: warns that the ML checks did not run, with the reason (variant of the real result: fallback.used = true)', () => {
    render(<ScanResult result={{ ...scan, engine: { name: 'baseline-integrity-rules', version: '1.0.0' }, fallback: { used: true, reason: 'unavailable: Model service is unreachable' } }} siteName={sn} />);
    expect(screen.getByTestId('scan-fallback')).toHaveTextContent('unavailable: Model service is unreachable');
    expect(screen.getByTestId('scan-fallback')).toHaveTextContent('were not performed');
  });
  it('ML not enabled (baseline without fallback) is explained, not hidden', () => {
    render(<ScanResult result={{ ...scan, engine: { name: 'baseline-integrity-rules', version: '1.0.0' }, coverage: { ...scan.coverage!, trialsScanned: 0 } }} siteName={sn} />);
    expect(screen.getByTestId('scan-baseline')).toHaveTextContent('ML integrity analysis is not enabled');
    expect(screen.queryByTestId('scan-nodata')).not.toBeInTheDocument();
  });
  it('coverage gaps are called out: skipped sites by name, truncated data', () => {
    render(<ScanResult result={{ ...scan, coverage: { ...scan.coverage!, sitesSkippedNoTimezone: [siteC.id], truncated: [{ trialId: trialJson.id, visits: 40 }] } }} siteName={sn} />);
    expect(screen.getByTestId('scan-skipped')).toHaveTextContent('SITE-C');
    expect(screen.getByTestId('scan-skipped')).toHaveTextContent('no valid timezone');
    expect(screen.getByTestId('scan-truncated')).toHaveTextContent('40 oldest visits');
  });
});

describe('EvidenceView', () => {
  const siteAlert = alerts.find((a) => a.ruleId === 'site.bp_digit_preference')!;
  const multi = alerts.find((a) => a.ruleId === 'visit.multiple_integrity_signals')!;
  it('explains a site-level statistical finding from the evidence the API carries', () => {
    render(<EvidenceView alert={siteAlert} />);
    const ev = screen.getByTestId('evidence');
    expect(ev).toHaveTextContent('Suspicious pattern');
    expect(ev).toHaveTextContent('SITE-C');
    expect(ev).toHaveTextContent('Suggested review');
    expect(ev).toHaveTextContent(String(siteAlert.details.recommendedReviewAction));
    expect(ev).toHaveTextContent(/Share ending 0 or 5\s*88\.5%/);          // 0.885 rendered as a percentage
    expect(ev).toHaveTextContent(/P value\s*3\.9e-230/);                    // tiny p-values in exponent form
  });
  it('lists every signal of a multi-signal visit with its own evidence, and resolves the participant name', () => {
    const pid = (multi.details.participantId as string);
    render(<EvidenceView alert={multi} names={{ participant: (id) => (id === pid ? 'P-C-017 · Latha Nair' : undefined) }} />);
    const signals = screen.getAllByTestId('signal');
    expect(signals).toHaveLength((multi.details.signals as string[]).length);
    expect(signals.map((s) => s.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Missing OTP'), expect.stringContaining('Night entry')]));
    expect(screen.getByText('P-C-017 · Latha Nair')).toBeInTheDocument();
  });
  it('raw evidence is one click away and starts hidden', async () => {
    render(<EvidenceView alert={siteAlert} />);
    expect(screen.queryByText(/"share_ending_0_or_5"/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show raw evidence/ }));
    expect(screen.getByText(/"share_ending_0_or_5"/)).toBeInTheDocument();
  });
  it('an alert with no recognised evidence still renders without inventing any', () => {
    render(<EvidenceView alert={{ ...siteAlert, details: {} }} />);
    expect(screen.queryByText('Suggested review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signal')).not.toBeInTheDocument();
  });
});

describe('TrialIntegrityPage', () => {
  const openTrial = trialAlerts.filter((a) => a.status === 'open');
  it('shows the trial\'s sites with Site C first and flagged, and only its own findings', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const cards = await screen.findAllByTestId('site-card');
    expect(cards).toHaveLength(sites.length);
    expect(cards[0]).toHaveAttribute('data-site', 'SITE-C');
    expect(within(cards[0]!).getByText('High')).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('Duplicate image ×6');                 // the six reused-ECG clusters
    expect(cards[0]).toHaveTextContent('Multiple integrity signals (visit)');
    expect(cards[0]).toHaveTextContent(/\+\d+ more/);                         // the card shows the top three rules only
    expect(screen.getByText('Multiple integrity signals (site)')).toBeInTheDocument();   // site-level and visit-level rules are distinguishable
    expect(screen.getByText(/Synthetic demo data/)).toBeInTheDocument();
    // findings table lists only trial findings; platform-wide ones are behind a toggle and counted separately
    expect(await screen.findByText(/Show platform-wide alerts/)).toHaveTextContent(`(${platformAlerts.length})`);
    expect(screen.queryByText(/active claims for the same visit/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show platform-wide alerts/ }));
    expect(screen.getAllByText(/Duplicate reimbursement|Actor activity outlier|Otp failure burst|OTP failure burst|Patient unverified visits/i).length).toBeGreaterThan(0);
  });

  it('site cards are top-aligned columns (not vertically centred buttons) and the platform stat says it counts open alerts', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    for (const c of await screen.findAllByTestId('site-card')) { expect(c).toHaveClass('flex', 'flex-col', 'justify-start'); }
    const stat = screen.getByText('Open platform-wide alerts').closest('div.p-5')!;
    await waitFor(() => expect(stat).toHaveTextContent(String(platformAlerts.filter((a) => a.status === 'open').length)));
  });

  it('selecting a site card narrows the findings to that site', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const c = (await screen.findAllByTestId('site-card'))[0]!;
    await userEvent.click(c);
    const rows = within(screen.getByRole('region', { name: 'Findings' }) ?? document.body).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveTextContent('SITE-C');
  });

  it('runs a scan only after confirmation, scoped to the selected trial, and reports the real result', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Run integrity scan/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Run an integrity scan on ${trialJson.code}?`)).toBeInTheDocument();
    expect(api.called('POST', '/integrity/scans')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run scan' }));
    await waitFor(() => expect(api.called('POST', '/integrity/scans')).toHaveLength(1));
    expect(api.called('POST', '/integrity/scans')[0]!.body).toEqual({ windowHours: 168, trialId: trialJson.id });
    expect(await screen.findByTestId('scan-summary')).toHaveTextContent(`${scan.findings} findings`);
  });

  it('a failed scan is reported as a failure, never as "no findings"', async () => {
    api = installFakeApi(routes({ 'POST /integrity/scans': { status: 503, error: { code: 'INTERNAL_ERROR', message: 'Scan could not complete' } } }));
    renderWithApp(<TrialIntegrityPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Run integrity scan/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run scan' }));
    expect(await screen.findByTestId('scan-failed')).toHaveTextContent('Scan could not complete');
    expect(screen.queryByTestId('scan-clean')).not.toBeInTheDocument();
  });

  it('a completed scan with zero findings is reported as such', async () => {
    api = installFakeApi(routes({ 'GET /integrity/alerts': page([]), 'POST /integrity/scans': { status: 201, data: { ...scan, findings: 0, newAlerts: 0, existingAlerts: 0, alerts: [] } } }));
    renderWithApp(<TrialIntegrityPage />);
    expect(await screen.findByText('No findings recorded for this trial')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Run integrity scan/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run scan' }));
    expect(await screen.findByTestId('scan-clean')).toBeInTheDocument();
    expect(screen.getAllByText('No findings')).toHaveLength(sites.length);        // every site card says so
  });

  it('opens a finding and shows its evidence and suggested review', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const row = (await screen.findByText(/Site SITE-C shows 7 independent integrity signals/)).closest('tr')!;
    await userEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('evidence')).toBeInTheDocument();
    expect(within(dialog).getByText('Suggested review')).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('signal').length).toBeGreaterThan(0);
  });

  it('the finding dialog names what an ECG-cluster alert is about in words, with no internal key or raw type', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const row = (await screen.findAllByText(/ECG images are identical/))[0]!.closest('tr')!;
    await userEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    const affected = await within(dialog).findByTestId('affected');
    expect(affected).toHaveTextContent(/^ECG image cluster \(\d+ visits?\)$/);
    expect(dialog).not.toHaveTextContent(/Ecg_cluster/);
  });

  it('lists recent scans from the audit trail', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const list = await screen.findByTestId('scan-history');
    expect(within(list).getAllByRole('listitem')).toHaveLength(historyJson.length);
    expect(list).toHaveTextContent('trialguard-integrity');
    expect(api.called('GET', '/audit')[0]!.params).toMatchObject({ action: 'integrity.scan_completed' });
  });

  it('shows the error when alerts cannot be loaded, and a "no access" message for a role the backend refuses (403)', async () => {
    api = installFakeApi(routes({ 'GET /integrity/alerts': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Database unavailable' } } }));
    renderWithApp(<TrialIntegrityPage />);
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    api.restore();
    api = installFakeApi(routes({ 'GET /integrity/alerts': { status: 403, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' } } }));
    renderWithApp(<TrialIntegrityPage />);
    expect(await screen.findByText('You do not have access to this data')).toBeInTheDocument();
  });

  it('open-finding counts come from the alerts, not from a constant', async () => {
    api = installFakeApi(routes());
    renderWithApp(<TrialIntegrityPage />);
    const card = (await screen.findByText('Open findings')).closest('div.p-5')!;
    await waitFor(() => expect(card).toHaveTextContent(String(openTrial.length)));
    expect(alertSiteIds(openTrial[0]!).length).toBeGreaterThan(0);
  });
});
