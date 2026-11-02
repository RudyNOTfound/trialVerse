import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { visitsApi } from '@/api/visits';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import type { Visit } from '@/types/api';

const schema = z.object({ visitType: z.string().trim().min(1, 'Required').max(60), scheduledAt: z.string().min(1, 'Pick a date and time'), notes: z.string().max(2000) });
type Values = z.infer<typeof schema>;

/** ISO instant -> value for <input type="datetime-local"> in the browser's local zone. */
const toLocalInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Edit/reschedule a visit. The backend only allows this while the visit is scheduled or otp_pending (409 otherwise). */
export function VisitEditDialog({ visit, open, onOpenChange }: { visit: Visit; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema) });
  useEffect(() => { if (open) { setError(null); reset({ visitType: visit.visitType, scheduledAt: toLocalInput(visit.scheduledAt), notes: visit.notes ?? '' }); } }, [open, visit, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => {
      const body: { visitType?: string; scheduledAt?: string; notes?: string } = {};
      if (v.visitType !== visit.visitType) body.visitType = v.visitType;
      const iso = new Date(v.scheduledAt).toISOString();
      if (iso !== new Date(visit.scheduledAt).toISOString()) body.scheduledAt = iso;
      if (v.notes !== (visit.notes ?? '')) body.notes = v.notes;
      if (!Object.keys(body).length) throw new Error('No changes to save.');
      return visitsApi.update(visit.id, body);
    },
    onSuccess: () => {
      toast.success('Visit updated');
      for (const k of ['visit', 'visits', 'overview', 'audit', 'visit-activity']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Edit visit" description="Rescheduling does not affect an OTP that was already issued.">
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visit type" error={errors.visitType?.message}><Input {...register('visitType')} /></Field>
            <Field label="Date & time" error={errors.scheduledAt?.message}><Input type="datetime-local" {...register('scheduledAt')} /></Field>
          </div>
          <Field label="Notes" error={errors.notes?.message}><Textarea {...register('notes')} /></Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>Save changes</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
