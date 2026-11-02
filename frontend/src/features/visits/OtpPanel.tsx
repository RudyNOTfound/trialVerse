import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Eye, KeyRound, Lock, Mail, ShieldCheck, Timer } from 'lucide-react';
import { visitsApi } from '@/api/visits';
import { ApiError } from '@/api/client';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/utils/format';
import type { Visit } from '@/types/api';
import { describeOtpError, type OtpFailure } from './otpErrors';

function useCountdown(expiresAt?: string, active?: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

/** Whole seconds until `iso` (0 when past or unset); re-renders every second while it is in the future. */
function useSecondsUntil(iso: string | null | undefined): number {
  const target = iso ? new Date(iso).getTime() : 0;
  const [now, setNow] = useState(Date.now());
  const left = Math.max(0, Math.ceil((target - now) / 1000));
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

const mmss = (s: number) => s >= 86_400 ? `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** OTP issue / status / verify. Shows only what the signed-in role may do; the server enforces the same rules. */
export function OtpPanel({ visit, mode }: { visit: Visit; mode: 'staff' | 'participant' }) {
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const toast = useToast();
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null); // set from a 429 so the button stays disabled
  const [lastDelivery, setLastDelivery] = useState<{ channel: string; recipientHint: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<OtpFailure | null>(null);
  const [devCode, setDevCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [devUnavailable, setDevUnavailable] = useState(false);
  const canIssue = mode === 'staff' && hasRole('admin', 'coordinator', 'investigator') && (visit.status === 'scheduled' || visit.status === 'otp_pending');

  const hasOtp = visit.status !== 'scheduled' || !!visit.otpIssuedAt;
  const otp = useQuery({
    queryKey: ['otp', visit.id],
    queryFn: async () => { try { return await visitsApi.otpStatus(visit.id); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; } },
    enabled: hasOtp,
    // Participants keep polling while the visit awaits verification, so a code re-sent by staff after a lock/expiry appears on its own.
    refetchInterval: (q) => (mode === 'participant' && visit.status === 'otp_pending' ? 8_000 : q.state.data?.status === 'active' ? 15_000 : false),
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['visit', visit.id] });
    qc.invalidateQueries({ queryKey: ['otp', visit.id] });
    qc.invalidateQueries({ queryKey: ['visits'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
    qc.invalidateQueries({ queryKey: ['visit-activity', visit.id] });
  };

  const issue = useMutation({
    mutationFn: () => visitsApi.issueOtp(visit.id),
    onSuccess: (r) => {
      setDevCode(r.demoOtp ? { code: r.demoOtp, expiresAt: r.expiresAt } : null); setDevUnavailable(false); setFailure(null); setCode('');
      setCooldownUntil(r.delivery?.resendAvailableAt ?? null);
      setLastDelivery(r.delivery ? { channel: r.delivery.channel, recipientHint: r.delivery.recipientHint } : null);
      // Staff are told where the code went, never what it is.
      if (r.delivery?.channel === 'email') toast.success(`Code emailed to ${r.delivery.recipientHint ?? 'the participant'}`);
      else if (r.delivery?.channel === 'demo') toast.success('Demo mode: no email was sent');
      refreshAll();
    },
    onError: (e) => {
      const f = describeOtpError(e);
      setFailure(f);
      if (f.retryAfterSeconds) setCooldownUntil(new Date(Date.now() + f.retryAfterSeconds * 1000).toISOString());
    },
  });
  const verify = useMutation({
    mutationFn: () => visitsApi.verifyOtp(visit.id, code.trim()),
    onSuccess: () => { setFailure(null); setCode(''); setDevCode(null); refreshAll(); },
    onError: (e) => { setFailure(describeOtpError(e)); setCode(''); qc.invalidateQueries({ queryKey: ['otp', visit.id] }); qc.invalidateQueries({ queryKey: ['visit', visit.id] }); },
  });
  const revealDev = useMutation({
    mutationFn: () => visitsApi.devOtp(visit.id),
    onSuccess: (d) => { setDevCode(d); setDevUnavailable(false); },
    onError: () => setDevUnavailable(true),
  });

  const status = otp.data;
  const channel = status?.delivery.channel ?? lastDelivery?.channel;
  const recipientHint = status?.delivery.recipientHint ?? lastDelivery?.recipientHint ?? null;
  const emailMode = channel === 'email';
  const demoMode = channel === 'demo';
  const resendLeft = useSecondsUntil(cooldownUntil && status?.delivery.resendAvailableAt ? (cooldownUntil > status.delivery.resendAvailableAt ? cooldownUntil : status.delivery.resendAvailableAt) : cooldownUntil ?? status?.delivery.resendAvailableAt);
  const active = status?.status === 'active';
  const remaining = useCountdown(status?.expiresAt, active);
  const verified = visit.status === 'verified' || visit.status === 'completed';
  const closed = visit.status === 'missed' || visit.status === 'cancelled';
  const locked = status?.status === 'locked';
  // In email mode the participant enters the code in their own portal; staff never see or relay it.
  const canVerify = !verified && !closed && visit.status === 'otp_pending' && active && (mode === 'participant' || !emailMode);
  const attemptsLeft = status ? status.maxAttempts - status.attempts : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-brand-600" />One-time passcode</CardTitle>
        {status && <StatusBadge value={status.status} />}
      </CardHeader>
      <CardContent className="space-y-4">
        {verified && (
          <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <div><p className="text-sm font-medium">Attendance verified</p><p className="text-xs">Verified {formatDateTime(visit.verifiedAt)}. {visit.status === 'verified' ? 'An investigator can now complete the visit.' : 'Visit completed.'}</p></div>
          </div>
        )}
        {closed && <p className="rounded-lg bg-slate-50 p-3 text-sm text-muted">This visit is {visit.status}; OTP verification is no longer available.</p>}

        {!verified && !closed && !hasOtp && <p className="text-sm text-muted">{mode === 'staff' ? "No code has been sent yet. Issue one when the participant arrives for check-in; it is emailed to their registered address." : 'Your clinic will email you a one-time code when you check in for this visit. This page updates automatically.'}</p>}

        {active && !verified && !closed && emailMode && (
          <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-blue-900">
            <Mail className="mt-0.5 h-4 w-4 shrink-0" />
            {mode === 'participant'
              ? <div><p className="text-sm font-medium">We emailed you a 6-digit code</p><p className="text-xs">Sent to {recipientHint ?? 'your registered email'}. Check your spam folder if you don't see it. Didn't get it? Ask clinic staff to send a new code.</p></div>
              : <div><p className="text-sm font-medium">Code emailed to {recipientHint ?? 'the participant'}</p><p className="text-xs">The participant enters it in their portal. You cannot see the code.</p></div>}
          </div>
        )}

        {status && !verified && !closed && (
          <dl className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-center text-xs">
            <div><dt className="text-muted">Attempts left</dt><dd className={cn('mt-0.5 text-base font-semibold', attemptsLeft === 0 && 'text-red-600')}>{attemptsLeft ?? '—'}<span className="text-xs font-normal text-muted"> / {status.maxAttempts}</span></dd></div>
            <div><dt className="text-muted">Expires</dt><dd className="mt-0.5 flex items-center justify-center gap-1 text-base font-semibold">{active && remaining != null ? <><Timer className="h-3.5 w-3.5 text-slate-400" />{remaining === 0 ? 'Expired' : mmss(remaining)}</> : '—'}</dd></div>
            <div><dt className="text-muted">Issued</dt><dd className="mt-0.5 text-sm font-medium">{formatDateTime(status.createdAt)}</dd></div>
          </dl>
        )}
        {locked && <Notice icon={Lock} tone="error" title="Code locked">Too many incorrect attempts. {canIssue ? 'Send a new code to continue.' : 'Ask clinic staff to send a new code.'}</Notice>}
        {status?.status === 'expired' && !verified && <Notice icon={Timer} tone="warn" title="Code expired">{canIssue ? 'Send a new code to continue.' : 'Ask clinic staff to send a new code.'}</Notice>}
        {status?.status === 'used' && !verified && !closed && <Notice icon={ShieldCheck} tone="warn" title="Code already used">This code was consumed. If the visit is not verified, {canIssue ? 'send a new code' : 'ask clinic staff to send a new code'}.</Notice>}

        {canIssue && (
          <div className="space-y-1.5">
            <Button variant={status && active ? 'outline' : 'primary'} loading={issue.isPending} disabled={resendLeft > 0} onClick={() => issue.mutate()}>
              {resendLeft > 0 ? <>Resend in {resendLeft}s</> : hasOtp && status ? <>{emailMode ? <Mail className="h-4 w-4" /> : null}Resend code</> : 'Issue OTP'}
            </Button>
            {status && active && <p className="text-xs text-muted">Sending a new code replaces the current one{status.delivery.cooldownSeconds ? `; you can resend once every ${status.delivery.cooldownSeconds} seconds` : ''}.</p>}
            {!status && <p className="text-xs text-muted">The code is emailed to the participant's registered address.</p>}
          </div>
        )}

        {/* Development flow: the backend only returns/serves codes when DEMO_OTP_ENABLED=true and delivery is not yet implemented. */}
        {mode === 'staff' && demoMode && (devCode || (active && !devUnavailable)) && (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700">Development only · demo OTP</p>
            {devCode ? (
              <p className="font-mono text-2xl font-semibold tracking-[0.3em] text-amber-900" aria-label="Demo OTP code">{devCode.code}</p>
            ) : (
              <Button size="sm" variant="outline" loading={revealDev.isPending} onClick={() => revealDev.mutate()}><Eye className="h-4 w-4" />Reveal demo OTP</Button>
            )}
            <p className="mt-1 text-xs text-amber-800/80">This panel exists only in development (demo mode). With email delivery on, staff never see the code.</p>
          </div>
        )}
        {mode === 'staff' && demoMode && devUnavailable && <p className="text-xs text-muted">Demo OTP is not available for this visit (not issued by the current server process, or demo mode is disabled).</p>}

        {canVerify && (
          <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) verify.mutate(); }} className="space-y-3">
            <div>
              <label htmlFor="otp-code" className="mb-1.5 block text-xs font-medium text-slate-600">{mode === 'participant' ? (emailMode ? 'Enter the code from your email' : 'Enter the code you received') : 'Enter the code from the participant'}</label>
              <Input id="otp-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d*" maxLength={10} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••"
                className="h-12 text-center font-mono text-xl tracking-[0.4em]" aria-invalid={failure?.tone === 'warn' || undefined} />
            </div>
            <Button type="submit" className="w-full" size="lg" loading={verify.isPending} disabled={code.length < 4}>Verify code</Button>
          </form>
        )}

        {failure && (
          <div role="alert" className={cn('flex items-start gap-3 rounded-lg border p-3', failure.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div><p className="text-sm font-medium">{failure.title}</p><p className="text-xs">{failure.message}</p></div>
          </div>
        )}
        {otp.error && !verified && <p className="text-xs text-red-600">Could not load OTP status: {(otp.error as Error).message}</p>}
      </CardContent>
    </Card>
  );
}

function Notice({ icon: Icon, tone, title, children }: { icon: typeof Lock; tone: 'warn' | 'error'; title: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-3', tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">{title}</p><p className="text-xs">{children}</p></div>
    </div>
  );
}
