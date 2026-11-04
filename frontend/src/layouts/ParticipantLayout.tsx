import { CalendarDays, ClipboardList, Home, Receipt, UserCircle, LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useMyPatient } from '@/features/participant/hooks';
import { Logo } from '@/components/common/Logo';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/me', label: 'Home', icon: Home, end: true },
  { to: '/me/visits', label: 'Visits', icon: CalendarDays },
  { to: '/me/records', label: 'Records', icon: ClipboardList },
  { to: '/me/reimbursements', label: 'Claims', icon: Receipt },
  { to: '/me/profile', label: 'Profile', icon: UserCircle },
];

/** Mobile-first: top bar + fixed bottom tab bar on phones, centred column on larger screens. */
export default function ParticipantLayout() {
  const { user, logout } = useAuth();
  const patient = useMyPatient();
  // A self-registered account has no patient record until staff link it; every participant endpoint answers 404.
  const unlinked = patient.error instanceof ApiError && patient.error.status === 404;
  if (unlinked) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <Logo className="mb-8" />
        <div className="max-w-md rounded-xl border border-line bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-ink">Account awaiting activation</h1>
          <p className="mt-2 text-sm text-muted">Thanks for registering{user ? `, ${user.fullName.split(' ')[0]}` : ''}. Your account is not yet linked to a participant record. Please ask your clinic coordinator to link it, then sign in again.</p>
          <p className="mt-4 text-xs text-muted">Signed in as {user?.email}</p>
          <button onClick={logout} className="mt-6 w-full rounded-lg bg-navy-900 py-2.5 text-sm font-medium text-white hover:bg-navy-800">Sign out</button>
          <button onClick={() => patient.refetch()} className="mt-2 w-full rounded-lg border border-line py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Check again</button>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Logo />
          <button onClick={logout} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"><LogOut className="h-4 w-4" /><span className="hidden sm:inline">Log out</span></button>
        </div>
        <nav className="mx-auto hidden max-w-3xl gap-1 px-4 pb-2 sm:flex" aria-label="Main">
          {TABS.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cn('rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>{label}</NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-28 pt-5 sm:pb-10"><Outlet /></main>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Main">
        <ul className="grid grid-cols-4">
          {TABS.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className={({ isActive }) => cn('flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')}>
                <Icon className="h-5 w-5" />{label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
