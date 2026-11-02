import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api/users';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { passwordRules } from '@/features/auth/passwordRules';
import { ROLE_LABEL } from '@/utils/roles';
import type { Role, User } from '@/types/api';

const ROLES: Role[] = ['admin', 'coordinator', 'investigator', 'patient'];
const base = { fullName: z.string().trim().min(1, 'Required').max(120), role: z.enum(['admin', 'coordinator', 'investigator', 'patient']) };
const createSchema = z.object({ ...base, email: z.string().email('Enter a valid email').max(254), password: passwordRules });
const editSchema = z.object({ ...base, email: z.string(), password: z.string() });
type Values = z.infer<typeof createSchema>;

/** Create (all fields) or edit (name and role only; the API does not allow changing email or password). */
export function UserFormDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange: (o: boolean) => void; user?: User }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const editing = !!user;
  const isSelf = user?.id === me?.id;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(editing ? editSchema : createSchema), defaultValues: { fullName: '', email: '', password: '', role: 'coordinator' } });
  useEffect(() => { if (open) { setError(null); reset(user ? { fullName: user.fullName, email: user.email, password: '', role: user.role } : { fullName: '', email: '', password: '', role: 'coordinator' }); } }, [open, user, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => (user ? usersApi.update(user.id, { fullName: v.fullName, ...(v.role !== user.role ? { role: v.role } : {}) }) : usersApi.create(v)),
    onSuccess: (u) => {
      toast.success(editing ? `${u.fullName} updated` : `Account created for ${u.fullName}`);
      for (const k of ['users', 'user', 'users-by-role', 'directory']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
    },
    onError: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={editing ? 'Edit user' : 'New user'} description={editing ? 'Email and password cannot be changed here.' : 'Create a staff or participant account.'}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Full name" error={errors.fullName?.message}><Input {...register('fullName')} /></Field>
          <Field label="Email" error={errors.email?.message}><Input type="email" disabled={editing} {...register('email')} /></Field>
          {!editing && <Field label="Temporary password" error={errors.password?.message} hint="At least 10 characters, with a letter and a digit."><Input type="password" autoComplete="new-password" {...register('password')} /></Field>}
          <Field label="Role" error={errors.role?.message} hint={isSelf ? 'You cannot change your own role.' : editing ? 'Role changes apply immediately and are recorded in the audit log.' : undefined}>
            <Select disabled={isSelf} {...register('role')}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
          </Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>{editing ? 'Save changes' : 'Create user'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
