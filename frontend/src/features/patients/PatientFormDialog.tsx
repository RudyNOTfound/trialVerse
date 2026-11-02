import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { patientsApi } from '@/api/patients';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { InlineError } from '@/components/common/States';
import { useToast } from '@/components/ui/toast';
import { useDirectory } from '@/hooks/useDirectory';
import { useUsersByRole } from '@/hooks/useUsersByRole';
import type { Patient, PatientStatus } from '@/types/api';

const schema = z.object({
  firstName: z.string().trim().min(1, 'Required').max(80),
  lastName: z.string().trim().min(1, 'Required').max(80),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date').refine((d) => new Date(d) <= new Date(), 'Must be in the past'),
  sex: z.enum(['female', 'male', 'other', 'unknown']),
  email: z.union([z.literal(''), z.string().email('Enter a valid email')]),
  phone: z.string().max(30),
  status: z.enum(['active', 'withdrawn', 'inactive']),
  userId: z.string(),
});
type Values = z.infer<typeof schema>;
const EMPTY: Values = { firstName: '', lastName: '', dateOfBirth: '', sex: 'unknown', email: '', phone: '', status: 'active', userId: '' };

/** Create or edit a patient. Admins can also link/unlink the participant's portal account (picker needs the admin-only user list). */
export function PatientFormDialog({ open, onOpenChange, patient, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; patient?: Patient; onCreated?: (p: Patient) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory();
  const accounts = useUsersByRole('patient', open);
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  useEffect(() => {
    if (open) {
      setError(null);
      reset(patient ? { firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: patient.dateOfBirth, sex: patient.sex, email: patient.email ?? '', phone: patient.phone ?? '', status: patient.status, userId: patient.userId ?? '' } : EMPTY);
    }
  }, [open, patient, reset]);

  const linkedElsewhere = new Set(dir.patients.filter((p) => p.userId && p.id !== patient?.id).map((p) => p.userId as string));
  const available = (accounts.data ?? []).filter((u) => !linkedElsewhere.has(u.id));

  const m = useMutation({
    mutationFn: (v: Values) => {
      const common = { firstName: v.firstName, lastName: v.lastName, dateOfBirth: v.dateOfBirth, sex: v.sex, email: v.email || undefined, phone: v.phone || undefined };
      if (!patient) return patientsApi.create({ ...common, ...(accounts.isAdmin && v.userId ? { userId: v.userId } : {}) } as Parameters<typeof patientsApi.create>[0]);
      return patientsApi.update(patient.id, { ...common, status: v.status as PatientStatus, ...(accounts.isAdmin ? { userId: v.userId || null } : {}) });
    },
    onSuccess: (p) => {
      toast.success(patient ? 'Patient updated' : `Patient ${p.subjectCode} created`);
      for (const k of ['patients', 'directory', 'patient', 'me']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
      if (!patient) onCreated?.(p);
    },
    onError: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={patient ? 'Edit patient' : 'New patient'} description={patient ? `Subject ${patient.subjectCode}` : 'A subject code is generated automatically.'}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" error={errors.firstName?.message}><Input {...register('firstName')} /></Field>
            <Field label="Last name" error={errors.lastName?.message}><Input {...register('lastName')} /></Field>
            <Field label="Date of birth" error={errors.dateOfBirth?.message}><Input type="date" {...register('dateOfBirth')} /></Field>
            <Field label="Sex" error={errors.sex?.message}>
              <Select {...register('sex')}><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option></Select>
            </Field>
            <Field label="Email (optional)" error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
            <Field label="Phone (optional)" error={errors.phone?.message}><Input {...register('phone')} /></Field>
            {patient && <Field label="Status" error={errors.status?.message}><Select {...register('status')}><option value="active">Active</option><option value="withdrawn">Withdrawn</option><option value="inactive">Inactive</option></Select></Field>}
          </div>
          {accounts.isAdmin ? (
            <Field label="Portal account" hint="Links this record to a participant's login so they can see their own data.">
              <Select {...register('userId')} disabled={accounts.isLoading}>
                <option value="">Not linked</option>
                {available.map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>)}
              </Select>
            </Field>
          ) : patient && <p className="text-xs text-muted">Portal account: {patient.userId ? 'linked' : 'not linked'}. Only administrators can change the link.</p>}
          <InlineError error={error} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={m.isPending}>{patient ? 'Save changes' : 'Create patient'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
