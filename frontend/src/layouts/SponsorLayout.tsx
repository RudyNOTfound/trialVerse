import { Activity, FlaskConical, LayoutDashboard, ScrollText, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { StaffShell, type NavItem } from './StaffShell';

const NAV: NavItem[] = [
  { to: '/sponsor', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/sponsor/trials', label: 'Trials & sites', icon: FlaskConical },
  { to: '/sponsor/risk', label: 'Patient risk', icon: Activity },
  { to: '/sponsor/integrity', label: 'Integrity alerts', icon: ShieldAlert },
  { to: '/sponsor/audit', label: 'Audit log', icon: ScrollText },
  { to: '/sponsor/rules', label: 'Detection rules', icon: SlidersHorizontal },
];

export default function SponsorLayout() {
  return <StaffShell nav={NAV} workspaceLabel="Sponsor oversight" switcher={{ to: '/app', label: 'Open site operations' }} />;
}
