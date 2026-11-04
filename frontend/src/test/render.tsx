import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthProvider } from '@/contexts/AuthContext';
import { tokenStore } from '@/api/client';

export const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 }, mutations: { retry: false } } });

/** Renders `ui` inside the real providers (query cache, toasts, auth, router). Pass `token` to start with a stored session. */
export function renderWithApp(ui: ReactElement, opts: { route?: string; path?: string; token?: string } = {}) {
  if (opts.token) tokenStore.set(opts.token);
  const client = newQueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[opts.route ?? '/']}>
            <Routes>
              <Route path={opts.path ?? '*'} element={ui} />
              <Route path="/forbidden" element={<p>FORBIDDEN PAGE</p>} />
              <Route path="/login" element={<p>LOGIN PAGE</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
