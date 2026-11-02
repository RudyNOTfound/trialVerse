import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badge = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
      blue: 'bg-blue-50 text-blue-700 ring-blue-200',
      green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
      amber: 'bg-amber-50 text-amber-800 ring-amber-200',
      orange: 'bg-orange-50 text-orange-700 ring-orange-200',
      red: 'bg-red-50 text-red-700 ring-red-200',
      violet: 'bg-violet-50 text-violet-700 ring-violet-200',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type Tone = NonNullable<VariantProps<typeof badge>['tone']>;
export const Badge = ({ className, tone, ...p }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) => (
  <span className={cn(badge({ tone }), className)} {...p} />
);
