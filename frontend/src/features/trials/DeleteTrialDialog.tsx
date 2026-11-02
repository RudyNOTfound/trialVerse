import { useQueryClient } from '@tanstack/react-query';
import { trialsApi } from '@/api/trials';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useToast } from '@/components/ui/toast';
import type { Trial } from '@/types/api';

/** Soft delete (admin). Rejected with 409 when the trial has enrollments; the dialog stays open and shows the server's message. */
export function DeleteTrialDialog({ trial, onOpenChange, onDeleted }: { trial: Trial | null; onOpenChange: (o: boolean) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <ConfirmDialog open={!!trial} onOpenChange={onOpenChange} title={`Delete ${trial?.code ?? 'trial'}?`}
      description="The trial disappears from lists. Trials with enrollments cannot be deleted; terminate them instead." confirmLabel="Delete trial"
      onConfirm={async () => {
        await trialsApi.remove(trial!.id);
        toast.success('Trial deleted');
        for (const k of ['trials', 'directory']) qc.invalidateQueries({ queryKey: [k] });
        onDeleted?.();
      }} />
  );
}
