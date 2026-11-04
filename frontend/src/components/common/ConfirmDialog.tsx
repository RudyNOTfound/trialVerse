import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { InlineError } from './States';

/** Confirmation for destructive actions. Keeps the dialog open and shows the server's message if the action is rejected (e.g. 409 conflicts). */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, confirmVariant = 'danger' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<unknown>;
  /** 'danger' (default) for destructive actions; 'primary' for confirming a safe but significant one. */
  confirmVariant?: 'danger' | 'primary';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onOpenChange(false); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) setError(null); onOpenChange(o); }}>
      <DialogContent title={title} description={description} className="max-w-md">
        <div className="space-y-4">
          <InlineError error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button variant={confirmVariant} loading={busy} onClick={run}>{confirmLabel}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
