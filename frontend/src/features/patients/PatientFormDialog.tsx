import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { InlineError } from '@/components/common/States';
import { useToast } from '@/components/ui/toast';
import { useLinkableAccounts } from '@/hooks/useLinkableAccounts';
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

/** Create or edit a patient. Admins and coordinators can link/unlink the participant's portal account from the list of unlinked registrations. */
export function PatientFormDialog({ open, onOpenChange, patient, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; patient?: Patient; onCreated?: (p: Patient) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useLinkableAccounts(open);
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  useEffect(() => {
    if (open) {
      setError(null);
      reset(patient ? { firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: patient.dateOfBirth, sex: patient.sex, email: patient.email ?? '', phone: patient.phone ?? '', status: patient.status, userId: patient.userId ?? '' } : EMPTY);
    }
  }, [open, patient, reset]);

  const available = accounts.data ?? [];

  const m = useMutation({
    mutationFn: async (v: Values) => {
      const common = { firstName: v.firstName, lastName: v.lastName, dateOfBirth: v.dateOfBirth, sex: v.sex, email: v.email || undefined, phone: v.phone || undefined };
      const saved = patient ? await patientsApi.update(patient.id, { ...common, status: v.status as PatientStatus }) : await patientsApi.create(common);
      // Linking goes through the dedicated endpoints (validated + audited separately), after the record itself is saved.
      const wanted = v.userId || null;
      const current = patient?.userId ?? null;
      if (wanted !== current) {
        try {
          let result = saved;
          if (current) result = await patientsApi.unlinkAccount(saved.id);
          if (wanted) result = await patientsApi.linkAccount(saved.id, wanted);
          return result;
        } catch (e) {
          throw new Error(`The patient was ${patient ? 'saved' : 'created'}, but the portal account could not be ${wanted ? 'linked' : 'unlinked'}: ${errorMessage(e)}`);
        }
      }
      return saved;
    },
    onSuccess: (p) => {
      toast.success(patient ? 'Patient updated' : `Patient ${p.subjectCode} created`);
      onOpenChange(false);
      if (!patient) onCreated?.(p);
    },
    onError: setError,
    // Refresh on partial failures as well: the record may have changed even if the link step failed.
    onSettled: () => { for (const k of ['patients', 'directory', 'patient', 'me', 'linkable-accounts']) qc.invalidateQueries({ queryKey: [k] }); },
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
          <Field label="Portal account" hint="Links this record to a registered participant login so they can see their own data. Only unlinked registrations are listed.">
            <Select {...register('userId')} disabled={accounts.isLoading}>
              <option value="">Not linked</option>
              {patient?.userId && <option value={patient.userId}>{patient.portalAccountName ?? 'Linked account'} (currently linked)</option>}
              {available.map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>)}
            </Select>
          </Field>
          {!accounts.isLoading && !available.length && !patient?.userId && <p className="-mt-2 text-xs text-muted">No registered accounts are waiting to be linked.</p>}
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
