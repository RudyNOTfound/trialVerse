import { cn } from '@/lib/utils';

export function Logo({ className, dark }: { className?: string; dark?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden>
        <rect width="32" height="32" rx="8" fill={dark ? '#fff' : '#0b2447'} />
        <path d="M16 6l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V9z" fill="none" stroke={dark ? '#1d4fd8' : '#7fb2ff'} strokeWidth="2" />
        <path d="M12 16l3 3 5-6" fill="none" stroke={dark ? '#0b2447' : '#fff'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={cn('text-lg font-semibold tracking-tight', dark ? 'text-white' : 'text-navy-900')}>TrialVerse</span>
    </div>
  );
}
