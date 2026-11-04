import type { ActionStatus, AlertStatus, EnrollmentStatus, TrialStatus, VisitStatus } from '@/types/api';

// UI hints only: mirrors the backend state machines so the interface offers just the legal next steps.
// The server remains the authority and rejects anything else with 409 INVALID_STATE_TRANSITION.
export const TRIAL_NEXT: Record<TrialStatus, TrialStatus[]> = { draft: ['active', 'terminated'], active: ['suspended', 'completed', 'terminated'], suspended: ['active', 'terminated'], completed: [], terminated: [] };
export const ENROLLMENT_NEXT: Record<EnrollmentStatus, EnrollmentStatus[]> = { screening: ['enrolled', 'screen_failed', 'withdrawn'], enrolled: ['completed', 'withdrawn'], completed: [], withdrawn: [], screen_failed: [] };
export const VISIT_NEXT: Record<VisitStatus, VisitStatus[]> = { scheduled: ['otp_pending', 'missed', 'cancelled'], otp_pending: ['verified', 'missed', 'cancelled'], verified: ['completed', 'cancelled'], completed: [], missed: [], cancelled: [] };
export const ACTION_NEXT: Record<ActionStatus, ActionStatus[]> = { pending: ['in_progress', 'completed', 'cancelled'], in_progress: ['pending', 'completed', 'cancelled'], completed: ['in_progress'], cancelled: [] };
export const ALERT_NEXT: Record<AlertStatus, AlertStatus[]> = { open: ['acknowledged', 'resolved', 'dismissed'], acknowledged: ['open', 'resolved', 'dismissed'], resolved: ['open'], dismissed: ['open'] };
