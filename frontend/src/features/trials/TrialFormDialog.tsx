import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trialsApi } from '@/api/trials';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import type { Trial, TrialPhase } from '@/types/api';

const PHASES: TrialPhase[] = ['I', 'I/II', 'II', 'II/III', 'III', 'IV'];
const schema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{3,30}$/, '3–30 letters, digits or dashes'),
  title: z.string().trim().min(3, 'At least 3 characters').max(200),
  sponsor: z.string().trim().min(1, 'Required').max(120),
  phase: z.enum(['I', 'I/II', 'II', 'II/III', 'III', 'IV']),
  description: z.string().max(5000),
  startDate: z.string(), endDate: z.string(),
}).refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: 'End date must not be before start date', path: ['endDate'] });
type Values = z.infer<typeof schema>;
const EMPTY: Values = { code: '', title: '', sponsor: '', phase: 'I', description: '', startDate: '', endDate: '' };

/** Create a trial, or edit one (the trial code is immutable). Status changes are handled separately via the state machine. */
export function TrialFormDialog({ open, onOpenChange, trial, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; trial?: Trial; onCreated?: (t: Trial) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  useEffect(() => {
    if (open) { setError(null); reset(trial ? { code: trial.code, title: trial.title, sponsor: trial.sponsor, phase: trial.phase, description: trial.description ?? '', startDate: trial.startDate ?? '', endDate: trial.endDate ?? '' } : EMPTY); }
  }, [open, trial, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => {
      const body = { title: v.title, sponsor: v.sponsor, phase: v.phase, description: v.description || undefined, startDate: v.startDate || undefined, endDate: v.endDate || undefined };
      return trial ? trialsApi.update(trial.id, body) : trialsApi.create({ code: v.code, ...body });
    },
    onSuccess: (t) => {
      toast.success(trial ? 'Trial updated' : `Trial ${t.code} created`);
      for (const k of ['trials', 'trial', 'directory']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
      if (!trial) onCreated?.(t);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={trial ? 'Edit trial' : 'New trial'} description={trial ? 'The trial code cannot be changed. Dates and description can be changed but not cleared.' : 'Trials start in draft status.'}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trial code" error={errors.code?.message}><Input placeholder="TG-ONC-201" disabled={!!trial} {...register('code')} /></Field>
            <Field label="Phase" error={errors.phase?.message}><Select {...register('phase')}>{PHASES.map((p) => <option key={p} value={p}>Phase {p}</option>)}</Select></Field>
          </div>
          <Field label="Title" error={errors.title?.message}><Input {...register('title')} /></Field>
          <Field label="Sponsor" error={errors.sponsor?.message}><Input {...register('sponsor')} /></Field>
          <Field label="Description (optional)" error={errors.description?.message}><Textarea {...register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" error={errors.startDate?.message}><Input type="date" {...register('startDate')} /></Field>
            <Field label="End date" error={errors.endDate?.message}><Input type="date" {...register('endDate')} /></Field>
          </div>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>{trial ? 'Save changes' : 'Create trial'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
