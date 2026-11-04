import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ParticipantVisitDetail } from '@/features/participant/ParticipantVisits';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/components/ui/toast';
import { tokenStore } from '@/api/client';
import { installFakeApi } from '@/test/fakeApi';
import { newQueryClient } from '@/test/render';
import { WORKSPACE_ROLES } from '@/utils/roles';
import type { Role, User } from '@/types/api';
import { RequireAuth } from './guards';
import { router } from './index';

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());

const user = (role: Role): User => ({ id: `${role}-id`, email: `${role}@demo.test`, fullName: `Demo ${role}`, role, isActive: true, createdAt: '', updatedAt: '', lastLoginAt: null } as unknown as User);
function mount(initial: string, guard: Role[] | undefined, role: Role | null) {
  api = installFakeApi({ 'GET /auth/me': role ? { data: user(role) } : { status: 401, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } } });
  if (role) tokenStore.set('token'); else tokenStore.clear();
  return render(
    <QueryClientProvider client={newQueryClient()}><ToastProvider><AuthProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<RequireAuth roles={guard} />}><Route path="/area" element={<p>PROTECTED AREA</p>} /></Route>
          <Route path="/forbidden" element={<p>FORBIDDEN PAGE</p>} /><Route path="/login" element={<p>LOGIN PAGE</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider></ToastProvider></QueryClientProvider>,
  );
}

describe('role-based route protection (the real guard + real AuthProvider)', () => {
  it('anonymous visitors are sent to the login page', async () => {
    mount('/area', WORKSPACE_ROLES.sponsor, null);
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
  });
  it.each<[Role, 'operations' | 'sponsor' | 'participant', boolean]>([
    ['patient', 'sponsor', false], ['patient', 'operations', false], ['patient', 'participant', true],
    ['coordinator', 'sponsor', false], ['coordinator', 'operations', true], ['coordinator', 'participant', false],
    ['investigator', 'sponsor', true], ['investigator', 'operations', true],
    ['admin', 'sponsor', true], ['admin', 'operations', true], ['admin', 'participant', false],
  ])('%s -> %s workspace: allowed = %s', async (role, workspace, allowed) => {
    mount('/area', WORKSPACE_ROLES[workspace], role);
    expect(await screen.findByText(allowed ? 'PROTECTED AREA' : 'FORBIDDEN PAGE')).toBeInTheDocument();
  });
});

/** Walks the REAL route table and returns the guard roles in force for a path. */
type R = { path?: string; element?: { type?: unknown; props?: { roles?: Role[] } }; children?: R[] };
function guardFor(routes: R[], target: string, inherited?: Role[]): Role[] | 'missing' | undefined {
  for (const r of routes) {
    const roles = r.element?.type === RequireAuth ? r.element.props?.roles : inherited;
    if (r.path === target) return roles ?? undefined;
    if (r.children) { const found = guardFor(r.children, target, roles); if (found !== 'missing') return found; }
  }
  return 'missing';
}
describe('the real route table', () => {
  const routes = router.routes as unknown as R[];
  it('operations pages are staff-only and the participant area is patient-only', () => {
    expect(guardFor(routes, '/app')).toEqual(WORKSPACE_ROLES.operations);
    expect(guardFor(routes, '/me')).toEqual(['patient']);
    expect(WORKSPACE_ROLES.operations).not.toContain('patient');
  });
  it('integrity and the sponsor workspace are admin + investigator only: a coordinator cannot open them (the backend refuses the same role)', () => {
    expect(guardFor(routes, '/sponsor')).toEqual(['admin', 'investigator']);
    expect(WORKSPACE_ROLES.sponsor).not.toContain('coordinator');
    expect(WORKSPACE_ROLES.sponsor).not.toContain('patient');
  });
  it('the new pages exist under those guards', () => {
    const find = (rs: R[], p: string): boolean => rs.some((r) => r.path === p || (r.children ? find(r.children, p) : false));
    for (const p of ['risk', 'participant-risk', 'integrity', 'integrity/alerts']) expect(find(routes, p), p).toBe(true);
  });
});

describe('participant isolation', () => {
  const sources = import.meta.glob(['/src/features/participant/**/*.{ts,tsx}', '/src/layouts/ParticipantLayout.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  it('participant screens never reference the risk or integrity APIs, scores, or factors', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/riskApi|integrityApi|\/risk\b|\/integrity\b|triggeredRules|fingerprint|recommendedReviewAction|ml:/);
    }
  });
  it('the participant navigation has no risk or integrity entry', () => {
    const nav = sources['/src/layouts/ParticipantLayout.tsx']!;
    expect(nav).not.toMatch(/risk|integrity/i);
  });
  it('opening another participant\'s visit (the API answers 403) shows no data, only the access message', async () => {
    api = installFakeApi({ 'GET /visits/:id': { status: 403, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' } } });
    render(
      <QueryClientProvider client={newQueryClient()}><MemoryRouter initialEntries={['/me/visits/someone-elses-visit']}><Routes><Route path="/me/visits/:id" element={<ParticipantVisitDetail />} /></Routes></MemoryRouter></QueryClientProvider>,
    );
    expect(await screen.findByText('You do not have access to this data')).toBeInTheDocument();
    await waitFor(() => expect(api.called('GET', '/visits/someone-elses-visit')).toHaveLength(1));
    expect(screen.queryByText(/Baseline|Week/)).not.toBeInTheDocument();
  });
});
