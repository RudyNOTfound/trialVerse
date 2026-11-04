import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Logo } from '@/components/common/Logo';
import { InlineError } from '@/components/common/States';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/api/client';
import { homePathFor } from '@/utils/roles';
import { passwordRules } from './passwordRules';

const schema = z.object({
  fullName: z.string().trim().min(1, 'Required').max(120),
  email: z.string().min(1, 'Required').email('Enter a valid email').max(254),
  password: passwordRules,
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });
type Values = z.infer<typeof schema>;

/** Participant self-registration. The API creates a `patient` account only; a clinic coordinator must link it to a patient record. */
export default function RegisterPage() {
  const { user, register: signUp } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });
  if (user) return <Navigate to={homePathFor(user.role)} replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const u = await signUp({ fullName: v.fullName, email: v.email, password: v.password });
      navigate(homePathFor(u.role), { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? new Error('An account with this email already exists. Try signing in instead.') : e);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-8 shadow-sm">
        <Logo className="mb-6" />
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Create your account</h1>
        <p className="mt-1 text-sm text-muted">For trial participants. After registering, your clinic links your account to your participant record.</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <Field label="Full name" error={errors.fullName?.message}><Input autoComplete="name" aria-invalid={!!errors.fullName} {...register('fullName')} /></Field>
          <Field label="Email" error={errors.email?.message}><Input type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} /></Field>
          <Field label="Password" error={errors.password?.message} hint="At least 10 characters, with a letter and a digit."><Input type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} /></Field>
          <Field label="Confirm password" error={errors.confirm?.message}><Input type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} /></Field>
          <InlineError error={error} />
          <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>Create account</Button>
        </form>
        <p className="mt-6 text-center text-sm text-muted">Already registered? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link></p>
      </div>
    </div>
  );
}
