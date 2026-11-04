import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeApi, page, type FakeReply } from '@/test/fakeApi';
import { renderWithApp } from '@/test/render';
import { CapturePanel, localToIso } from './CapturePanel';

const PID = '11111111-1111-4111-8111-111111111111';
const VISIT = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const me = (role: string) => ({ data: { id: 'u1', email: 'x@y.z', fullName: 'X', role, isActive: true } });
const visit = { id: VISIT, visitType: 'Week 4', scheduledAt: '2026-01-10T09:00:00.000Z', status: 'verified' };
const enrollment = { id: ENR, trialCode: 'GLU-301', siteName: 'Site A' };
const sentReminder = { id: 'r1', enrollmentId: ENR, patientId: PID, visitId: null, channel: 'sms', sentAt: '2026-01-09T09:00:00.000Z', outcome: 'sent', acknowledgedAt: null, outcomeRecordedAt: null };

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());
const routes = (role: string, over: Record<string, FakeReply | ((r: never) => FakeReply)> = {}) => ({
  'GET /auth/me': me(role),
  [`GET /patients/${PID}/measurements`]: page([]),
  [`GET /patients/${PID}/ecgs`]: page([]),
  [`GET /patients/${PID}/reminders`]: page([sentReminder]),
  [`GET /patients/${PID}/adverse-events`]: page([]),
  'GET /visits': page([visit]),
  'GET /enrollments': page([enrollment]),
  ...over,
}) as never;
const mount = (role: string, mode: 'staff' | 'participant', over = {}) => { api = installFakeApi(routes(role, over)); return renderWithApp(<CapturePanel patientId={PID} mode={mode} />, { token: 't' }); };

describe('CapturePanel', () => {
  it('staff: records a measurement through the real API client, as ISO-8601 with offset and only the filled fields', async () => {
    mount('coordinator', 'staff', { [`POST /patients/${PID}/measurements`]: { status: 201, data: { id: VISIT } } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /record measurement/i }));
    await user.selectOptions(await screen.findByLabelText('Visit'), VISIT);
    await user.type(screen.getByLabelText('Systolic BP (mmHg)'), '128');
    await user.type(screen.getByLabelText('Diastolic BP (mmHg)'), '82');
    await user.click(screen.getByRole('button', { name: /save measurement/i }));
    await waitFor(() => expect(api.called('POST', `/patients/${PID}/measurements`)).toHaveLength(1));
    const body = api.called('POST', `/patients/${PID}/measurements`)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ visitId: VISIT, systolicBp: 128, diastolicBp: 82 });
    expect(body.performedAt).toMatch(/Z$|[+-]\d\d:\d\d$/);
    expect(body).not.toHaveProperty('heartRate');          // blank means "not measured", never 0
  });

  it('validates before calling the API: no values, and an absolute ECG path are both rejected client-side', async () => {
    mount('investigator', 'staff');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /record measurement/i }));
    await user.selectOptions(await screen.findByLabelText('Visit'), VISIT);
    await user.click(screen.getByRole('button', { name: /save measurement/i }));
    expect(await screen.findByText('Enter at least one measurement')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(screen.getByRole('button', { name: /register ecg/i }));
    await user.selectOptions(await screen.findByLabelText('Visit'), VISIT);
    await user.type(screen.getByLabelText('File reference'), '/etc/passwd');
    await user.click(screen.getByRole('button', { name: /^register ecg$/i }));
    expect(await screen.findByText(/relative to the ECG directory/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows the API error inline when the server refuses (duplicate ECG for the visit)', async () => {
    mount('coordinator', 'staff', { [`POST /patients/${PID}/ecgs`]: { status: 409, error: { code: 'CONFLICT', message: 'This visit already has an ECG record' } } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /register ecg/i }));
    await user.selectOptions(await screen.findByLabelText('Visit'), VISIT);
    await user.type(screen.getByLabelText('File reference'), 'ecgs/SITE-A/P-A-001.png');
    await user.click(screen.getByRole('button', { name: /^register ecg$/i }));
    expect(await screen.findByText('This visit already has an ECG record')).toBeInTheDocument();
  });

  it('coordinator resolves a sent reminder; the 24-hour rule is explained and an empty history is not shown as zero', async () => {
    mount('coordinator', 'staff', { [`PATCH /reminders/r1`]: { data: { ...sentReminder, outcome: 'acknowledged' } } });
    const user = userEvent.setup();
    expect(await screen.findByText(/not acknowledged within 24 hours/)).toBeInTheDocument();
    expect(screen.getByText('No measurements recorded')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Acknowledged' }));
    await waitFor(() => expect(api.called('PATCH', '/reminders/r1')[0]?.body).toEqual({ outcome: 'acknowledged' }));
  });

  it('investigators cannot log reminders (admin/coordinator only); participants get only the symptom form and no storage details', async () => {
    mount('investigator', 'staff');
    expect(await screen.findByRole('button', { name: /record measurement/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log reminder/i })).not.toBeInTheDocument();
    api.restore();
    document.body.innerHTML = '';
    mount('patient', 'participant', { [`GET /patients/${PID}/ecgs`]: page([{ id: 'e1', visitId: VISIT, patientId: PID, recordedAt: null, createdAt: '2026-01-10T09:00:00.000Z' }]) });
    const panel = await screen.findAllByTestId('capture-panel');
    const last = within(panel[panel.length - 1]!);
    expect(await last.findByRole('button', { name: /report symptom/i })).toBeInTheDocument();
    expect(last.queryByRole('button', { name: /record measurement|register ecg|log reminder/i })).not.toBeInTheDocument();
    expect(last.queryByText('File reference')).not.toBeInTheDocument();
  });

  it('participant reports a symptom for their own enrollment', async () => {
    mount('patient', 'participant', { [`POST /patients/${PID}/adverse-events`]: { status: 201, data: { id: 'a1' } } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /report symptom/i }));
    await user.selectOptions(await screen.findByLabelText('Trial enrollment'), ENR);
    await user.click(screen.getByRole('button', { name: /submit report/i }));
    await waitFor(() => expect(api.called('POST', `/patients/${PID}/adverse-events`)).toHaveLength(1));
    expect(api.called('POST', `/patients/${PID}/adverse-events`)[0]!.body).toMatchObject({ enrollmentId: ENR });
  });

  it('localToIso yields an offset-bearing ISO string', () => { const iso = localToIso('2026-01-10T09:30'); expect(iso).toMatch(/Z$/); expect(new Date(iso).getTime()).toBe(new Date(2026, 0, 10, 9, 30).getTime()); });
});
