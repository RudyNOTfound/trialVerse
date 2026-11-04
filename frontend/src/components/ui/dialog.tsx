import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  // Radix only returns focus to its own <Trigger>. These dialogs are opened from state (a table row, a button), so without this
  // a keyboard or screen-reader user would be dropped at the top of the page when the dialog closes.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-navy-950/50 backdrop-blur-[2px]" />
      <D.Content
        onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(e) => { const el = opener.current; if (el && el.isConnected && el !== document.body) { e.preventDefault(); el.focus(); } }}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-white p-6 shadow-xl',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          <D.Close className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X className="h-4 w-4" /></D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
