import * as M from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface RowAction { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; hidden?: boolean }

/** Contextual "…" menu for table rows. Clicks are stopped so they don't trigger row navigation. */
export function RowActions({ actions, label = 'Row actions' }: { actions: RowAction[]; label?: string }) {
  const visible = actions.filter((a) => !a.hidden);
  if (!visible.length) return null;
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <M.Root>
        <M.Trigger className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-ink" aria-label={label}><MoreHorizontal className="h-4 w-4" /></M.Trigger>
        <M.Portal>
          <M.Content align="end" sideOffset={4} className="z-50 min-w-40 rounded-lg border border-line bg-white p-1 shadow-lg">
            {visible.map((a) => (
              <M.Item key={a.label} onSelect={a.onSelect}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-slate-100', a.danger ? 'text-red-600' : 'text-ink')}>
                {a.icon}{a.label}
              </M.Item>
            ))}
          </M.Content>
        </M.Portal>
      </M.Root>
    </div>
  );
}
