import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ShieldCheck, Activity, Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Logo } from '@/components/common/Logo';
import { InlineError } from '@/components/common/States';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/api/client';
import { homePathFor } from '@/utils/roles';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type Values = z.infer<typeof schema>;

// Development convenience only: compiled out of production builds (import.meta.env.DEV is false there).
const DEV_ACCOUNTS = [
  ['Admin', 'admin@trialguard.demo'], ['Coordinator', 'coordinator1@trialguard.demo'],
  ['Investigator', 'investigator1@trialguard.demo'], ['Participant', 'patient1@trialguard.demo'],
] as const;

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

  if (user) return <Navigate to={homePathFor(user.role)} replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const u = await login(v.email, v.password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : homePathFor(u.role), { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? new Error('Incorrect email or password.') : e);
    }
  });

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-navy-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-brand-400/10 blur-3xl" />
        <Logo dark className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Clinical trial operations you can verify.</h2>
          <p className="mt-4 text-slate-300">One platform for site teams, participants and sponsors, with OTP-verified visits and a tamper-evident audit trail.</p>
          <ul className="mt-8 space-y-4 text-sm text-slate-200">
            {[[ShieldCheck, 'OTP-verified visit attendance'], [Activity, 'Explainable risk and integrity monitoring'], [Fingerprint, 'Hash-chained audit log']].map(([Icon, text]) => {
              const I = Icon as typeof ShieldCheck;
              return <li key={text as string} className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10"><I className="h-4 w-4" /></span>{text as string}</li>;
            })}
          </ul>
        </div>
        <p className="relative text-xs text-slate-400">TrialVerse</p>
      </aside>

      <main className="flex items-center justify-center bg-white p-6">
        <div className="w-full max-w-sm">
          <Logo className="mb-8 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Use your TrialVerse account to continue.</p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            <Field label="Email" error={errors.email?.message}>
              <Input type="email" autoComplete="username" placeholder="you@organisation.org" aria-invalid={!!errors.email} {...register('email')} />
            </Field>
            <Field label="Password" error={errors.password?.message}>
              <Input type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />
            </Field>
            <InlineError error={error} />
            <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>Sign in</Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">Participating in a trial? <Link to="/register" className="font-medium text-brand-700 hover:underline">Create an account</Link></p>

          {import.meta.env.DEV && (
            <div className="mt-8 rounded-lg border border-dashed border-line p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Development only · fill demo account</p>
              <div className="flex flex-wrap gap-2">
                {DEV_ACCOUNTS.map(([label, email]) => (
                  <button key={email} type="button" className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
                    onClick={() => { setValue('email', email); setValue('password', 'DemoPass#2025'); }}>{label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
