import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { actionsApi } from '@/api/actions';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useDirectory } from '@/hooks/useDirectory';
import { useStaffUsers } from '@/hooks/useStaffUsers';
import { humanize } from '@/utils/format';
import type { ActionItem, Priority } from '@/types/api';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const schema = z.object({
  title: z.string().trim().min(3, 'At least 3 characters').max(200),
  description: z.string().max(5000),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  dueDate: z.string(),
  patientId: z.string(),
  assigneeId: z.string(),
});
type Values = z.infer<typeof schema>;
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/** Create or edit an action. Admins can assign to any staff member; other roles can assign to themselves or unassign (the user list is admin-only). */
export function ActionFormDialog({ open, onOpenChange, action }: { open: boolean; onOpenChange: (o: boolean) => void; action?: ActionItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const dir = useDirectory();
  const staff = useStaffUsers(open);
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { title: '', description: '', priority: 'medium', dueDate: '', patientId: '', assigneeId: '' } });
  useEffect(() => {
    if (open) {
      setError(null);
      reset(action
        ? { title: action.title, description: action.description ?? '', priority: action.priority, dueDate: dayOf(action.dueDate), patientId: action.patientId ?? '', assigneeId: action.assigneeId ?? '' }
        : { title: '', description: '', priority: 'medium', dueDate: '', patientId: '', assigneeId: user?.id ?? '' });
    }
  }, [open, action, user?.id, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => {
      const due = v.dueDate ? new Date(`${v.dueDate}T23:59:00`).toISOString() : null;
      if (!action) return actionsApi.create({ title: v.title, description: v.description || undefined, priority: v.priority, dueDate: due ?? undefined, patientId: v.patientId || undefined, assigneeId: v.assigneeId || undefined });
      const body: Parameters<typeof actionsApi.update>[1] = {};
      if (v.title !== action.title) body.title = v.title;
      if (v.description !== (action.description ?? '')) body.description = v.description;
      if (v.priority !== action.priority) body.priority = v.priority;
      if (v.dueDate !== dayOf(action.dueDate)) body.dueDate = due;
      if ((v.assigneeId || null) !== action.assigneeId) body.assigneeId = v.assigneeId || null;
      if (!Object.keys(body).length) throw new Error('No changes to save.');
      return actionsApi.update(action.id, body);
    },
    onSuccess: () => {
      toast.success(action ? 'Action updated' : 'Action created');
      for (const k of ['actions', 'action', 'action-history', 'overview']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
    },
    onError: setError,
  });

  const staffList = staff.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={action ? 'Edit action' : 'New action'}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Title" error={errors.title?.message}><Input {...register('title')} /></Field>
          <Field label="Description (optional)" error={errors.description?.message}><Textarea {...register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" error={errors.priority?.message}><Select {...register('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
            <Field label="Due date (optional)" error={errors.dueDate?.message}><Input type="date" {...register('dueDate')} /></Field>
          </div>
          <Field label="Assignee" hint={staff.isAdmin ? undefined : 'Only administrators can assign to other staff.'}>
            <Select {...register('assigneeId')} disabled={staff.isAdmin && staff.isLoading}>
              <option value="">Unassigned</option>
              {user && <option value={user.id}>Me ({user.fullName})</option>}
              {staffList.filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.role}</option>)}
              {action?.assigneeId && action.assigneeId !== user?.id && !staffList.some((u) => u.id === action.assigneeId) && <option value={action.assigneeId}>{dir.userName(action.assigneeId)}</option>}
            </Select>
          </Field>
          {!action && (
            <Field label="Related patient (optional)"><Select {...register('patientId')}><option value="">None</option>{dir.patients.map((p) => <option key={p.id} value={p.id}>{p.subjectCode} · {p.firstName} {p.lastName}</option>)}</Select></Field>
          )}
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>{action ? 'Save changes' : 'Create action'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
