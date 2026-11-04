import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { reimbursementsApi } from '@/api/reimbursements';
import { visitsApi } from '@/api/visits';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { formatDate } from '@/utils/format';
import type { Reimbursement } from '@/types/api';

const CATEGORIES = ['travel', 'meals', 'accommodation', 'parking', 'other'] as const;
const schema = z.object({
  visitId: z.string().min(1, 'Select a visit'),
  category: z.enum(CATEGORIES),
  amount: z.string().refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'Enter an amount greater than 0 (max 2 decimals)').refine((v) => Number(v) <= 100000, 'Maximum is 100,000'),
  description: z.string().max(1000),
});
type Values = z.infer<typeof schema>;

/** Create (staff, or a participant for their own visit) or edit a pending reimbursement. */
export function ReimbursementFormDialog({ open, onOpenChange, existing, patientId }: { open: boolean; onOpenChange: (o: boolean) => void; existing?: Reimbursement; patientId?: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const visits = useQuery({ queryKey: ['visits', 'claimable', patientId ?? 'all'], enabled: open && !existing, queryFn: () => visitsApi.list({ pageSize: 100, patientId, order: 'desc' }) });
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { visitId: '', category: 'travel', amount: '', description: '' } });
  useEffect(() => {
    if (open) { setError(null); reset(existing ? { visitId: existing.visitId, category: existing.category, amount: (existing.amountCents / 100).toFixed(2), description: existing.description ?? '' } : { visitId: '', category: 'travel', amount: '', description: '' }); }
  }, [open, existing, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => {
      const amountCents = Math.round(Number(v.amount) * 100);
      return existing
        ? reimbursementsApi.update(existing.id, { category: v.category, amountCents, description: v.description })
        : reimbursementsApi.create({ visitId: v.visitId, category: v.category, amountCents, description: v.description || undefined });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reimbursements'] }); qc.invalidateQueries({ queryKey: ['overview'] }); onOpenChange(false); },
    onError: setError,
  });
  // Claims only make sense for visits that actually took place or are underway.
  const claimable = (visits.data?.items ?? []).filter((v) => v.status !== 'cancelled' && v.status !== 'missed');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={existing ? 'Edit claim' : 'New reimbursement claim'} description={existing ? 'Only pending claims can be edited.' : 'Claims are reviewed by an investigator or administrator.'}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          {!existing && (
            <Field label="Visit" error={errors.visitId?.message} hint={!visits.isLoading && !claimable.length ? 'No eligible visits found.' : undefined}>
              <Select {...register('visitId')}><option value="">Select visit…</option>
                {claimable.map((v) => <option key={v.id} value={v.id}>{patientId ? '' : `${v.patientName ?? '—'} · `}{v.visitType} · {formatDate(v.scheduledAt)} ({v.status.replace('_', ' ')})</option>)}</Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" error={errors.category?.message}><Select {...register('category')}>{CATEGORIES.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}</Select></Field>
            <Field label="Amount (USD)" error={errors.amount?.message}><Input inputMode="decimal" placeholder="0.00" {...register('amount')} /></Field>
          </div>
          <Field label="Description (optional)" error={errors.description?.message}><Textarea {...register('description')} /></Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>{existing ? 'Save changes' : 'Submit claim'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
