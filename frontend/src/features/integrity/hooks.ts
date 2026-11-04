import { useQuery } from '@tanstack/react-query';
import { auditApi } from '@/api/audit';
import { fetchAll } from '@/api/fetchAll';
import { integrityApi } from '@/api/integrity';
import { trialsApi } from '@/api/trials';

export const useTrialSites = (trialId: string | undefined) =>
  useQuery({ queryKey: ['trial-sites', trialId], enabled: !!trialId, queryFn: () => trialsApi.sites(trialId!) });

/** Every stored alert (all trials). Scoping to a trial happens in `scopeAlerts`, because the API has no trial filter on alerts. */
export const useAllAlerts = () =>
  useQuery({ queryKey: ['alerts', 'all'], queryFn: () => fetchAll((page) => integrityApi.alerts({ page, pageSize: 100, sort: 'detectedAt', order: 'desc' })) });

/** Scan history is the audit trail's `integrity.scan_completed` events; there is no dedicated endpoint. */
export const useScanHistory = () =>
  useQuery({ queryKey: ['scan-history'], queryFn: () => auditApi.list({ action: 'integrity.scan_completed', pageSize: 10, order: 'desc' }) });
