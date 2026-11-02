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
import type { Patient } from '@/types/api';

const schema = z.object({
  firstName: z.string().trim().min(1, 'Required').max(80),
  lastName: z.string().trim().min(1, 'Required').max(80),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date').refine((d) => new Date(d) <= new Date(), 'Must be in the past'),
  sex: z.enum(['female', 'male', 'other', 'unknown']),
  email: z.union([z.literal(''), z.string().email('Enter a valid email')]),
  phone: z.string().max(30),
});
type Values = z.infer<typeof schema>;
const EMPTY: Values = { firstName: '', lastName: '', dateOfBirth: '', sex: 'unknown', email: '', phone: '' };

export function PatientFormDialog({ open, onOpenChange, patient, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; patient?: Patient; onCreated?: (p: Patient) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  useEffect(() => {
    if (open) { setError(null); reset(patient ? { firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: patient.dateOfBirth, sex: patient.sex, email: patient.email ?? '', phone: patient.phone ?? '' } : EMPTY); }
  }, [open, patient, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => {
      const body = { ...v, email: v.email || undefined, phone: v.phone || undefined };
      return patient ? patientsApi.update(patient.id, body) : patientsApi.create(body);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['patients'] });
      qc.invalidateQueries({ queryKey: ['directory', 'patients'] });
      qc.invalidateQueries({ queryKey: ['patient', p.id] });
      onOpenChange(false);
      if (!patient) onCreated?.(p);
    },
    onError: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={patient ? 'Edit patient' : 'New patient'} description={patient ? undefined : 'A subject code is generated automatically.'}>
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
          </div>
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
