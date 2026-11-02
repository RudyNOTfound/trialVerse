import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { patientsApi } from '@/api/patients';
import { trialsApi } from '@/api/trials';
import { fetchAll } from '@/api/fetchAll';
import { usersApi } from '@/api/users';
import { useAuth } from '@/contexts/AuthContext';
import type { Patient, Trial, TrialSite } from '@/types/api';
import { fullName, shortId } from '@/utils/format';

/**
 * The API returns flat records (patientId, trialId, trialSiteId ...). Staff screens resolve those IDs to
 * human-readable names from these cached lists instead of showing UUIDs.
 */
export function useDirectory() {
  const { hasRole } = useAuth();
  // Participants cannot list patients/trials (403); their screens never need the directory.
  const staff = !hasRole('patient');
  const patientsQ = useQuery({ queryKey: ['directory', 'patients'], queryFn: () => fetchAll((page) => patientsApi.list({ page, pageSize: 100 })), enabled: staff, staleTime: 60_000 });
  const trialsQ = useQuery({ queryKey: ['directory', 'trials'], queryFn: () => fetchAll((page) => trialsApi.list({ page, pageSize: 100 })), enabled: staff, staleTime: 60_000 });
  const siteQs = useQueries({
    queries: (trialsQ.data ?? []).map((t) => ({ queryKey: ['trial-sites', t.id], queryFn: () => trialsApi.sites(t.id), staleTime: 60_000 })),
  });
  // /users is admin-only; other roles simply fall back to short ids for actors / assignees.
  const isAdmin = hasRole('admin');
  const usersQ = useQuery({ queryKey: ['directory', 'users'], queryFn: () => fetchAll((page) => usersApi.list(page)), enabled: isAdmin, staleTime: 60_000 });

  const siteData = siteQs.map((q) => q.data);
  // Fixed-length dependency signature (the number of site queries changes as trials load).
  const siteSig = siteQs.map((q) => `${q.dataUpdatedAt}:${q.isLoading ? 1 : 0}`).join('|');
  return useMemo(() => {
    const patients = patientsQ.data ?? [];
    const trials = trialsQ.data ?? [];
    const sites: TrialSite[] = siteData.flatMap((d) => d ?? []);
    const patientMap = new Map<string, Patient>(patients.map((p) => [p.id, p]));
    const trialMap = new Map<string, Trial>(trials.map((t) => [t.id, t]));
    const siteMap = new Map<string, TrialSite>(sites.map((s) => [s.id, s]));
    const userMap = new Map((usersQ.data ?? []).map((u) => [u.id, u]));
    return {
      loading: patientsQ.isLoading || trialsQ.isLoading || siteQs.some((q) => q.isLoading),
      patients, trials, sites, patientMap, trialMap, siteMap,
      patientName: (id?: string | null) => (id ? (patientMap.has(id) ? fullName(patientMap.get(id)) : shortId(id)) : '—'),
      patientCode: (id?: string | null) => (id ? patientMap.get(id)?.subjectCode ?? shortId(id) : '—'),
      trialCode: (id?: string | null) => (id ? trialMap.get(id)?.code ?? shortId(id) : '—'),
      siteName: (id?: string | null) => (id ? siteMap.get(id)?.name ?? shortId(id) : '—'),
      userName: (id?: string | null) => (id ? userMap.get(id)?.fullName ?? shortId(id) : 'System'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientsQ.data, trialsQ.data, usersQ.data, patientsQ.isLoading, trialsQ.isLoading, siteSig]);
}
export type Directory = ReturnType<typeof useDirectory>;
