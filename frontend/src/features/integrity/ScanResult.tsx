import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '@/api/client';
import { cn } from '@/lib/utils';
import type { IntegrityScanSummary } from '@/types/api';

type Tone = 'ok' | 'info' | 'warn' | 'fail';
const TONE: Record<Tone, { box: string; icon: typeof Info }> = {
  ok: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2 },
  info: { box: 'border-brand-200 bg-brand-50 text-brand-900', icon: Info },
  warn: { box: 'border-amber-300 bg-amber-50 text-amber-900', icon: AlertTriangle },
  fail: { box: 'border-red-200 bg-red-50 text-red-800', icon: XCircle },
};
function Note({ tone, title, children, testId }: { tone: Tone; title: string; children?: ReactNode; testId?: string }) {
  const t = TONE[tone];
  return (
    <div role={tone === 'fail' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-lg border p-3 text-sm', t.box)} data-testid={testId} data-tone={tone}>
      <t.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0"><p className="font-medium">{title}</p>{children && <div className="mt-1 space-y-1 text-xs">{children}</div>}</div>
    </div>
  );
}

/**
 * The outcome of one scan, built only from the POST /integrity/scans response (or its error).
 * Keeps three situations apart that are easy to confuse: the scan FAILED, the scan ran on the fallback engine, and the scan ran and found NOTHING.
 */
export function ScanResult({ result, error, siteName }: { result?: IntegrityScanSummary | null; error?: unknown; siteName: (siteId: string) => string }) {
  if (error) {
    return <Note tone="fail" title="The scan failed, so nothing was checked" testId="scan-failed"><p>{errorMessage(error)}</p><p>This is not the same as "no findings". Existing alerts are unchanged. Try again.</p></Note>;
  }
  if (!result) return null;
  const c = result.coverage;
  const skipped = [...(c?.sitesSkippedNoTimezone ?? []), ...(c?.sitesSkippedInvalidTimezone ?? [])];
  const truncated = c?.truncated ?? [];
  const mlEngine = !result.engine.name.startsWith('baseline');
  return (
    <div className="space-y-2" data-testid="scan-result">
      {result.fallback.used ? (
        <Note tone="warn" title="The ML integrity service was unavailable: the rule-based checks ran instead" testId="scan-fallback">
          {result.fallback.reason && <p>Reason reported: {result.fallback.reason}</p>}
          <p>Site, visit and ECG checks come from the ML service, so they were not performed in this scan.</p>
        </Note>
      ) : result.findings === 0 ? (
        <Note tone="ok" title="Scan completed with no findings" testId="scan-clean"><p>{result.eventsScanned} audit events were checked by {result.engine.name} v{result.engine.version}.</p></Note>
      ) : (
        <Note tone="info" title={`Scan completed: ${result.findings} finding${result.findings === 1 ? '' : 's'}`} testId="scan-summary">
          <p>{result.newAlerts} new alert{result.newAlerts === 1 ? '' : 's'} raised, {result.existingAlerts} already known. {result.eventsScanned} audit events checked by {result.engine.name} v{result.engine.version}.</p>
        </Note>
      )}
      {!result.fallback.used && !mlEngine && <Note tone="info" title="ML integrity analysis is not enabled" testId="scan-baseline"><p>Only the platform's rule-based checks ran. Site, visit and ECG analysis needs the ML integrity service.</p></Note>}
      {skipped.length > 0 && <Note tone="warn" title={`${skipped.length} site${skipped.length === 1 ? ' was' : 's were'} not analysed`} testId="scan-skipped"><p>{skipped.map(siteName).join(', ')}: no valid timezone is configured, so entry times cannot be judged on the site's local clock.</p></Note>}
      {c && c.trialsScanned === 0 && !result.fallback.used && mlEngine && <Note tone="warn" title="No trial data was analysed" testId="scan-nodata"><p>The selected trial had no participants or sites the service could analyse.</p></Note>}
      {truncated.length > 0 && <Note tone="warn" title="Part of the trial was left out (size limit)" testId="scan-truncated"><p>{truncated.map((t) => [t.visits && `${t.visits} oldest visits`, t.ecgs && `${t.ecgs} oldest ECGs`, t.participants && `${t.participants} participants`].filter(Boolean).join(', ')).join('; ')}.</p></Note>}
    </div>
  );
}
