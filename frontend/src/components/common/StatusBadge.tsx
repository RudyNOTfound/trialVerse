import { Badge, type Tone } from '@/components/ui/badge';
import { humanize } from '@/utils/format';

const TONES: Record<string, Tone> = {
  // visits
  scheduled: 'blue', otp_pending: 'amber', verified: 'violet', completed: 'green', missed: 'red', cancelled: 'neutral',
  // enrollments / patients / trials / sites
  screening: 'amber', enrolled: 'green', withdrawn: 'orange', screen_failed: 'red', active: 'green', inactive: 'neutral', closed: 'neutral',
  draft: 'neutral', suspended: 'amber', terminated: 'red',
  // reimbursement + payment
  pending: 'amber', approved: 'green', rejected: 'red', none: 'neutral', unpaid: 'amber', processing: 'blue', paid: 'green', failed: 'red',
  // actions
  in_progress: 'blue', overdue: 'red',
  // alerts
  open: 'red', acknowledged: 'amber', resolved: 'green', dismissed: 'neutral',
  // otp
  used: 'green', locked: 'red', expired: 'neutral', superseded: 'neutral',
  // severity / risk / priority
  low: 'green', medium: 'amber', high: 'orange', critical: 'red',
};

export function StatusBadge({ value }: { value: string }) {
  return <Badge tone={TONES[value] ?? 'neutral'}>{humanize(value)}</Badge>;
}
