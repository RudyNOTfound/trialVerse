import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/States';
import { cn } from '@/lib/utils';
import type { PageMeta } from '@/types/api';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hide below the `md` breakpoint to keep tables readable on small screens. */
  hideOnMobile?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  meta?: PageMeta;
  onPageChange?: (page: number) => void;
}

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, onRowClick, emptyTitle = 'Nothing to show', emptyDescription, emptyAction, meta, onPageChange }: Props<T>) {
  return (
    <Card className="overflow-hidden">
      {error ? <ErrorState error={error} onRetry={onRetry} />
        : loading ? <TableSkeleton cols={Math.min(columns.length, 6)} />
        : !rows?.length ? <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                <tr>{columns.map((c) => <th key={c.header} scope="col" className={cn('px-4 py-3 font-medium', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.header}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => (
                  <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}
                    // keyboard access: the row is focusable and Enter / Space open it, but only when the row itself has focus (a button inside keeps its own behaviour)
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={onRowClick ? (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onRowClick(row); } } : undefined}
                    className={cn('transition-colors', onRowClick && 'cursor-pointer hover:bg-brand-50/50 focus-visible:bg-brand-50/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500')}>
                    {columns.map((c) => <td key={c.header} className={cn('px-4 py-3 align-middle', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.cell(row)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {meta && rows?.length ? <Pagination meta={meta} onPageChange={onPageChange} /> : null}
    </Card>
  );
}

export function Pagination({ meta, onPageChange }: { meta: PageMeta; onPageChange?: (p: number) => void }) {
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-muted">
      <span>{from}–{to} of {meta.total}</span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={meta.page <= 1} onClick={() => onPageChange?.(meta.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="px-2 text-xs">Page {meta.page} / {meta.totalPages}</span>
        <Button variant="outline" size="icon" aria-label="Next page" disabled={meta.page >= meta.totalPages} onClick={() => onPageChange?.(meta.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
