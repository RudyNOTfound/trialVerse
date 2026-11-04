import { Activity, CalendarCheck, UserCog, FlaskConical, LayoutDashboard, ListChecks, Receipt, Users, UserPlus } from 'lucide-react';
import { StaffShell, type NavItem } from './StaffShell';
import { useAuth } from '@/contexts/AuthContext';

const NAV: NavItem[] = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/patients', label: 'Patients', icon: Users },
  { to: '/app/trials', label: 'Trials & sites', icon: FlaskConical },
  { to: '/app/enrollments', label: 'Enrollments', icon: UserPlus },
  { to: '/app/visits', label: 'Visits', icon: CalendarCheck },
  { to: '/app/risk', label: 'Participant risk', icon: Activity },
  { to: '/app/reimbursements', label: 'Reimbursements', icon: Receipt },
  { to: '/app/actions', label: 'Actions', icon: ListChecks },
];

export default function OperationsLayout() {
  const { hasRole } = useAuth();
  const nav = hasRole('admin') ? [...NAV, { to: '/app/users', label: 'Users', icon: UserCog }] : NAV;
  return <StaffShell nav={nav} workspaceLabel="Site operations" switcher={hasRole('admin', 'investigator') ? { to: '/sponsor', label: 'Open trial oversight' } : undefined} />;
}
