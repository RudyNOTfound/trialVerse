import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/utils/format';
import type { Visit } from '@/types/api';

/** Visit progress: scheduled → OTP issued → verified → completed (or missed / cancelled). */
export function VisitStepper({ visit }: { visit: Visit }) {
  const steps = [
    { key: 'scheduled', label: 'Scheduled', at: visit.scheduledAt },
    { key: 'otp_pending', label: 'OTP issued', at: visit.otpIssuedAt },
    { key: 'verified', label: 'Verified', at: visit.verifiedAt },
    { key: 'completed', label: 'Completed', at: visit.completedAt },
  ];
  const order = ['scheduled', 'otp_pending', 'verified', 'completed'];
  const terminal = visit.status === 'missed' || visit.status === 'cancelled';
  const reached = terminal ? (visit.verifiedAt ? 2 : visit.otpIssuedAt ? 1 : 0) : order.indexOf(visit.status);

  return (
    <ol className="flex items-start" aria-label="Visit progress">
      {steps.map((s, i) => {
        const done = i < reached || (i === reached && visit.status === 'completed');
        const current = i === reached && !terminal && visit.status !== 'completed';
        return (
          <li key={s.key} className="relative flex flex-1 flex-col items-center text-center">
            {i > 0 && <span className={cn('absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2', i <= reached ? 'bg-brand-500' : 'bg-line')} aria-hidden />}
            <span className={cn('relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold',
              done ? 'border-brand-600 bg-brand-600 text-white' : current ? 'border-brand-600 bg-white text-brand-700' : 'border-line bg-white text-slate-400')}>
              {done ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span className={cn('mt-2 text-xs font-medium', done || current ? 'text-ink' : 'text-slate-400')}>{s.label}</span>
            <span className="mt-0.5 hidden px-1 text-[11px] text-muted sm:block">{i === 0 || done ? formatDateTime(s.at) : ''}</span>
          </li>
        );
      })}
      {terminal && (
        <li className="ml-2 flex flex-col items-center text-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-300 bg-red-50 text-red-600"><X className="h-4 w-4" /></span>
          <span className="mt-2 text-xs font-medium capitalize text-red-700">{visit.status}</span>
        </li>
      )}
    </ol>
  );
}
