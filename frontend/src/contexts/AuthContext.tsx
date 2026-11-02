import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/api/auth';
import { setUnauthorizedHandler, tokenStore } from '@/api/client';
import type { Role, User } from '@/types/api';

interface AuthState {
  user: User | null;
  /** True while a stored token is being validated against /auth/me on first load. */
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!tokenStore.get());

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    qc.clear();
  }, [qc]);

  // Restore the session. Authorization is always decided by the server: the stored token is verified via /auth/me.
  useEffect(() => {
    if (!tokenStore.get()) return;
    let cancelled = false;
    authApi.me()
      .then((u) => { if (!cancelled) setUser(u); })
      .catch(() => { if (!cancelled) tokenStore.clear(); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // A 401 anywhere (expired / revoked token) drops the session.
  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); qc.clear(); });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    tokenStore.set(res.token);
    qc.clear();
    setUser(res.user);
    return res.user;
  }, [qc]);

  const value = useMemo<AuthState>(() => ({
    user, loading, login, logout,
    hasRole: (...roles) => !!user && roles.includes(user.role),
  }), [user, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
