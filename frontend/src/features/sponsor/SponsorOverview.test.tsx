import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import opsJson from '@/test/fixtures/stats-operations.json';
import siteAlertsJson from '@/test/fixtures/site-alerts-open.json';
import sponsorJson from '@/test/fixtures/stats-sponsor.json';
import { installFakeApi, page, type FakeReply } from '@/test/fakeApi';
import { renderWithApp } from '@/test/render';
import SponsorOverview from './SponsorOverview';

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());
const routes = (over: Record<string, FakeReply> = {}) => ({
  'GET /stats/sponsor': { data: sponsorJson },
  'GET /stats/operations': { data: opsJson },
  'GET /integrity/alerts': (req: { params?: Record<string, unknown> }) => (req.params?.entityType === 'site' ? page(siteAlertsJson) : page([])),
  ...over,
}) as never;

describe('SponsorOverview', () => {
  it('shows aggregate counts exactly as the backend reports them', async () => {
    api = installFakeApi(routes());
    renderWithApp(<SponsorOverview />);
    const high = (await screen.findByText('High / critical risk')).closest('div.p-5')!;
    await waitFor(() => expect(high).toHaveTextContent(String(sponsorJson.risk.highOrCritical)));
    const openAlerts = (await screen.findByText('Open integrity alerts')).closest('div.p-5')!;
    await waitFor(() => expect(openAlerts).toHaveTextContent(String(sponsorJson.integrity.open)));
    const assessed = Object.values(sponsorJson.risk.byEntityType.patient ?? {}).reduce((n: number, c) => n + (c as number), 0);
    expect(await screen.findByText(new RegExp(`${assessed} of ${opsJson.patients.total} patients assessed`))).toBeInTheDocument();
  });

  it('lists the sites with open site-level findings, Site C first, grouped by the site code the alert carries', async () => {
    api = installFakeApi(routes());
    renderWithApp(<SponsorOverview />);
    const list = await screen.findByTestId('site-concerns');
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('SITE-C');
    expect(items[0]).toHaveTextContent('High');
    const siteCCount = siteAlertsJson.filter((a) => a.details.siteCode === 'SITE-C').length;
    expect(items[0]).toHaveTextContent(`${siteCCount} open`);
    expect(api.called('GET', '/integrity/alerts').some((c) => c.params?.entityType === 'site' && c.params?.status === 'open')).toBe(true);
  });

  it('with no open site findings it says so and does not invent any', async () => {
    api = installFakeApi(routes({ 'GET /integrity/alerts': page([]) as never }));
    renderWithApp(<SponsorOverview />);
    expect(await screen.findByText(/No open site-level findings/)).toBeInTheDocument();
    expect(screen.queryByTestId('site-concerns')).not.toBeInTheDocument();
  });

  it('shows the statistics error instead of zeros when the aggregate request fails', async () => {
    api = installFakeApi(routes({ 'GET /stats/sponsor': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'stats down' } } }));
    renderWithApp(<SponsorOverview />);
    expect(await screen.findByText(/Could not load statistics: stats down/)).toBeInTheDocument();
  });
});
