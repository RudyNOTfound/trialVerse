import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const LEVEL_COLORS: Record<string, string> = { low: '#10b981', medium: '#f59e0b', high: '#f97316', critical: '#dc2626' };

/** Simple categorical bar chart; callers pass real counts only. */
export function CountBars({ data, colors, height = 220 }: { data: { name: string; value: number }[]; colors?: Record<string, string>; height?: number }) {
  return (
    <div style={{ height }} role="img" aria-label={`Bar chart: ${data.map((d) => `${d.name} ${d.value}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={56}>
            {data.map((d) => <Cell key={d.name} fill={colors?.[d.name] ?? '#2563eb'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 0-100 score bar coloured by risk level. */
export function ScoreBar({ score, level }: { score: number; level: string }) {
  return (
    <div className="flex items-center gap-2" aria-label={`Score ${score} of 100`}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${score}%`, background: LEVEL_COLORS[level] ?? '#2563eb' }} /></div>
      <span className="w-8 text-right text-sm font-semibold tabular-nums">{score}</span>
    </div>
  );
}
