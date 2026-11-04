import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Skeleton } from './States';
import { cn } from '@/lib/utils';

export function StatCard({ label, value, hint, icon: Icon, to, tone = 'blue', loading }: {
  label: string; value: ReactNode; hint?: string; icon: ComponentType<{ className?: string }>; to?: string; tone?: 'blue' | 'amber' | 'red' | 'green'; loading?: boolean;
}) {
  const tones = { blue: 'bg-brand-50 text-brand-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600', green: 'bg-emerald-50 text-emerald-600' };
  const body = (
    <Card className={cn('h-full p-5 transition-shadow', to && 'hover:shadow-md')}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
          {loading ? <Skeleton className="mt-2 h-8 w-16" /> : <p className="mt-1 text-3xl font-semibold tracking-tight text-ink">{value}</p>}
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        </div>
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', tones[tone])}><Icon className="h-5 w-5" /></div>
      </div>
    </Card>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}
