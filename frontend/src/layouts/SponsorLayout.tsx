import { Activity, ClipboardList, FlaskConical, LayoutDashboard, ListChecks, ScrollText, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { StaffShell, type NavItem } from './StaffShell';

const NAV: NavItem[] = [
  { to: '/sponsor', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/sponsor/trials', label: 'Trials & sites', icon: FlaskConical },
  { to: '/sponsor/participant-risk', label: 'Participant risk', icon: Activity },
  { to: '/sponsor/risk', label: 'Risk assessments', icon: ClipboardList },
  { to: '/sponsor/integrity', label: 'Integrity monitoring', icon: ShieldAlert, end: true },
  { to: '/sponsor/integrity/alerts', label: 'Alert log', icon: ListChecks },
  { to: '/sponsor/audit', label: 'Audit log', icon: ScrollText },
  { to: '/sponsor/rules', label: 'Detection rules', icon: SlidersHorizontal },
];

export default function SponsorLayout() {
  return <StaffShell nav={NAV} workspaceLabel="Trial oversight" switcher={{ to: '/app', label: 'Open site operations' }} />;
}
