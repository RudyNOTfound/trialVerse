import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/api/fetchAll';
import { riskApi } from '@/api/risk';
import { enrollmentsApi, trialsApi } from '@/api/trials';
import { latestByEntity } from '@/lib/ml';
import type { Trial } from '@/types/api';

/** A trial counts as synthetic demo data only if the data itself says so (the ML demo importer's sponsor / title). */
export const isSyntheticTrial = (t?: Pick<Trial, 'sponsor' | 'title'> | null) => !!t && (/synthetic/i.test(t.sponsor) || /synthetic/i.test(t.title));

export function useTrials() {
  return useQuery({ queryKey: ['trials', 'all'], queryFn: () => fetchAll((page) => trialsApi.list({ page, pageSize: 100 })), staleTime: 60_000 });
}

/** Everyone enrolled in the trial, as returned by GET /enrollments?trialId=. */
export function useRoster(trialId: string | undefined) {
  return useQuery({ queryKey: ['roster', trialId], enabled: !!trialId, queryFn: () => fetchAll((page) => enrollmentsApi.list({ trialId, page, pageSize: 100 })) });
}

/** Each patient's most recent stored assessment (GET /risk/assessments?entityType=patient, newest first). */
export function useLatestPatientRisk() {
  const q = useQuery({
    queryKey: ['risk', 'latest-patient'],
    queryFn: () => fetchAll((page) => riskApi.list({ entityType: 'patient', sort: 'assessedAt', order: 'desc', page, pageSize: 100 })),
  });
  const latest = useMemo(() => latestByEntity(q.data ?? []), [q.data]);
  // A fallback result is not a risk judgment (the model was not consulted), so it must not replace the last real one.
  const latestValid = useMemo(() => latestByEntity((q.data ?? []).filter((a) => !a.fallback.used)), [q.data]);
  return { ...q, latest, latestValid };
}
