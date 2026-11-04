import { useState, type ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LogOut, Menu, X } from 'lucide-react';
import { Logo } from '@/components/common/Logo';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { initials } from '@/utils/format';
import { ROLE_LABEL } from '@/utils/roles';

export interface NavItem { to: string; label: string; icon: ComponentType<{ className?: string }>; end?: boolean }

/** Sidebar shell shared by the Operations and Oversight workspaces. */
export function StaffShell({ nav, workspaceLabel, switcher }: { nav: NavItem[]; workspaceLabel: string; switcher?: { to: string; label: string } }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 text-slate-300">
      <div className="flex h-16 items-center justify-between px-5"><Logo dark /><button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button></div>
      <p className="px-5 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{workspaceLabel}</p>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} onClick={() => setOpen(false)}
            className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors', isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white')}>
            <Icon className="h-4 w-4" />{label}
          </NavLink>
        ))}
      </nav>
      {switcher && (
        <NavLink to={switcher.to} className="mx-3 mb-2 rounded-lg border border-white/10 px-3 py-2 text-center text-xs font-medium text-slate-300 hover:bg-white/5">{switcher.label}</NavLink>
      )}
      <div className="border-t border-white/10 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials(user?.fullName ?? '?')}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white">{user?.fullName}</p><p className="truncate text-xs text-slate-400">{user ? ROLE_LABEL[user.role] : ''}</p></div>
          <button onClick={logout} className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Log out" title="Log out"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-navy-950/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-xl">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-line bg-white px-4 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-md p-1.5 hover:bg-slate-100"><Menu className="h-5 w-5" /></button>
          <Logo />
        </header>
        <main className="flex-1 overflow-y-auto"><div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8"><Outlet /></div></main>
      </div>
    </div>
  );
}
