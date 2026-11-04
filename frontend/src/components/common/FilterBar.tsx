import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Input, Select } from '@/components/ui/input';

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-3">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input className="pl-9" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

export function FilterSelect({ value, onChange, options, allLabel, label }: { value: string; onChange: (v: string) => void; options: readonly string[] | Array<{ value: string; label: string }>; allLabel: string; label: string }) {
  return (
    <Select className="w-auto min-w-40" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{allLabel}</option>
      {options.map((o) => typeof o === 'string' ? <option key={o} value={o}>{o.replace(/_/g, ' ')}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );
}
