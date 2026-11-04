// Types mirror the backend responses observed in src/modules/** (source of truth: docs/API_ENDPOINTS.md + implementation).

export type Role = 'admin' | 'coordinator' | 'investigator' | 'patient';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResult { user: User; token: string }

export interface PageMeta { page: number; pageSize: number; total: number; totalPages: number }
export interface Paginated<T> { items: T[]; meta: PageMeta }

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export type Sex = 'female' | 'male' | 'other' | 'unknown';
export type PatientStatus = 'active' | 'withdrawn' | 'inactive';
export interface Patient {
  id: string;
  subjectCode: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: Sex;
  email: string | null;
  phone: string | null;
  status: PatientStatus;
  createdAt: string;
  updatedAt: string;
  /** Embedded by the API: display name of the linked portal account. */
  portalAccountName?: string | null;
}

export type TrialStatus = 'draft' | 'active' | 'suspended' | 'completed' | 'terminated';
export type TrialPhase = 'I' | 'I/II' | 'II' | 'II/III' | 'III' | 'IV';
export interface Trial {
  id: string;
  code: string;
  title: string;
  description: string | null;
  sponsor: string;
  phase: TrialPhase;
  status: TrialStatus;
  startDate: string | null;
  endDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrialSite {
  id: string;
  trialId: string;
  siteCode: string;
  name: string;
  city: string | null;
  country: string;
  principalInvestigatorId: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: string;
  updatedAt: string;
  principalInvestigatorName?: string | null;
  /** ML inputs (backend migration 002). IANA timezone and the category the retention model knows the site by. */
  timezone?: string | null;
  mlSiteCategory?: string | null;
}

export type EnrollmentStatus = 'screening' | 'enrolled' | 'completed' | 'withdrawn' | 'screen_failed';
export interface Enrollment {
  id: string;
  patientId: string;
  trialId: string;
  trialSiteId: string;
  status: EnrollmentStatus;
  arm: string | null;
  enrolledAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Embedded by the API. */
  patientName?: string | null;
  patientCode?: string | null;
  trialCode?: string | null;
  trialTitle?: string | null;
  siteName?: string | null;
  /** Coarse travel distance from the participant's home to the site (km). Model input; null = unknown. */
  distanceToSiteKm?: number | null;
}

export type VisitStatus = 'scheduled' | 'otp_pending' | 'verified' | 'completed' | 'missed' | 'cancelled';
export interface Visit {
  id: string;
  enrollmentId: string;
  patientId: string;
  trialId: string;
  trialSiteId: string;
  visitType: string;
  scheduledAt: string;
  status: VisitStatus;
  otpIssuedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  completedAt: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Embedded by the API. */
  patientName?: string | null;
  patientCode?: string | null;
  trialCode?: string | null;
  trialTitle?: string | null;
  siteName?: string | null;
  verifiedByName?: string | null;
}

export type OtpState = 'active' | 'used' | 'locked' | 'expired' | 'superseded';
/** How the code reached the participant. Never contains the code. */
export interface OtpDelivery {
  channel: 'email' | 'demo' | 'none';
  /** Masked address of the participant's portal account, e.g. `a***@example.org`. */
  recipientHint: string | null;
  cooldownSeconds: number;
  /** When another code may be sent; null if there is no cooldown or nothing was sent yet. */
  resendAvailableAt: string | null;
}
export interface OtpStatus {
  id: string;
  visitId: string;
  status: OtpState;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  delivery: OtpDelivery;
}
export interface OtpIssueResult {
  otpId: string;
  visitId: string;
  expiresAt: string;
  maxAttempts: number;
  delivery?: OtpDelivery & { status: 'sent' | 'demo' | null };
  /** Development only: present only when the backend runs with DEMO_OTP_ENABLED=true and email delivery off. */
  demoOtp?: string;
}
export interface DemoOtp { code: string; expiresAt: string }

export type ReimbursementCategory = 'travel' | 'meals' | 'accommodation' | 'parking' | 'other';
export type ReimbursementStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type PaymentStatus = 'none' | 'unpaid' | 'processing' | 'paid' | 'failed';
export interface Reimbursement {
  id: string;
  patientId: string;
  visitId: string;
  trialId: string;
  category: ReimbursementCategory;
  amountCents: number;
  currency: string;
  description: string | null;
  status: ReimbursementStatus;
  paymentStatus: PaymentStatus;
  requestedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  paidAt: string | null;
  transactionRef: string | null;
  createdAt: string;
  updatedAt: string;
  /** Embedded by the API. */
  patientName?: string | null;
  trialCode?: string | null;
  requestedByName?: string | null;
  reviewedByName?: string | null;
}

export interface HistoryEntry {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  note: string | null;
  createdAt: string;
  actorName?: string | null;
}

export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ActionStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export interface ActionItem {
  id: string;
  title: string;
  description: string | null;
  status: ActionStatus;
  priority: Priority;
  dueDate: string | null;
  assigneeId: string | null;
  createdBy: string;
  trialId: string | null;
  patientId: string | null;
  visitId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isOverdue: boolean;
  effectiveStatus: ActionStatus | 'overdue';
  /** Embedded by the API. */
  assigneeName?: string | null;
  createdByName?: string | null;
  patientName?: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RiskEntityType = 'patient' | 'visit' | 'reimbursement';
export interface TriggeredRule { ruleId: string; name: string; weight: number; detail: string }
export interface RiskAssessment {
  id: string;
  entityType: RiskEntityType;
  entityId: string;
  score: number;
  level: RiskLevel;
  triggeredRules: TriggeredRule[];
  explanation: string;
  engine: { name: string; version: string };
  fallback: { used: boolean; reason: string | null };
  assessedAt: string;
  requestedBy: string | null;
  createdAt: string;
  /** Embedded by the API: label of the assessed patient / visit / reimbursement. */
  entityName?: string | null;
}
export interface RuleConfig { enabled: boolean; weight: number; threshold: number; params?: Record<string, unknown> }
export interface RiskRulesConfig {
  engine: { name: string; version: string };
  baselineConfig: { levels: { medium: number; high: number; critical: number }; rules: Record<string, RuleConfig> };
}

export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';
export interface IntegrityAlert {
  id: string;
  ruleId: string;
  entityType: string;
  entityId: string;
  severity: RiskLevel;
  status: AlertStatus;
  message: string;
  details: Record<string, unknown>;
  source: string;
  fingerprint: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  detectedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Embedded by the API. */
  resolvedByName?: string | null;
  entityName?: string | null;
}

export interface AuditEvent {
  seq: number;
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
  hash: string;
  /** Embedded by the API (display only; the hash chain covers actorId). */
  actorName?: string | null;
  actorRole?: string | null;
}
export interface ChainVerification {
  valid: boolean;
  eventsChecked: number;
  headSeq: number;
  headHash: string;
  errors: Array<{ type: string; seq: number | null; message: string }>;
  errorsTruncated: boolean;
  verifiedAt: string;
}

/** What a scan could and could not look at (only present on the response of POST /integrity/scans). */
export interface ScanCoverage {
  trialsScanned: number;
  /** Site ids left out of the scan because they have no timezone / an invalid one / exceeded the size cap. */
  sitesSkippedNoTimezone: string[];
  sitesSkippedInvalidTimezone?: string[];
  trialsWithoutData: string[];
  truncated: Array<{ trialId: string; visits?: number; ecgs?: number; participants?: number }>;
}
export interface IntegrityScanSummary {
  engine: { name: string; version: string };
  fallback: { used: boolean; reason?: string };
  coverage?: ScanCoverage;
  windowStart: string;
  windowEnd: string;
  eventsScanned: number;
  findings: number;
  newAlerts: number;
  existingAlerts: number;
  alerts: IntegrityAlert[];
}

/** GET /integrity/rules. Each rule has `enabled` plus rule-specific numeric settings. */
export interface IntegrityRulesConfig {
  engine: { name: string; version: string };
  baselineConfig: Record<string, { enabled: boolean } & Record<string, boolean | number>>;
}

/** GET /users/directory (staff only, minimal fields). */
export interface StaffEntry { id: string; fullName: string; role: 'admin' | 'coordinator' | 'investigator'; isActive: boolean }

/** GET /patients/linkable-accounts: registered patient accounts waiting to be linked. */
export interface LinkableAccount { id: string; fullName: string; email: string; createdAt: string }

/** GET /visits/:id/history: curated, read-only view of the visit's audit trail. */
export interface VisitHistoryEntry {
  id: string;
  at: string;
  action: string;
  kind: 'schedule' | 'edit' | 'otp' | 'status';
  label: string;
  actor: { id: string; name: string | null; role: string | null } | null;
  from?: string;
  to?: string;
  scheduledAt?: { from: string; to: string };
  changedFields?: string[];
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  note?: string;
}

// ---- /stats/* (server-side aggregates)
export type CountMap = Record<string, number>;
export interface OperationsStats {
  generatedAt: string;
  patients: { total: number; byStatus: CountMap };
  trials: { total: number; byStatus: CountMap };
  enrollments: { total: number; byStatus: CountMap };
  visits: { total: number; byStatus: CountMap; pastDueUnverified: number };
  actions: { total: number; byStatus: CountMap; overdue: number };
  reimbursements: { total: number; byStatus: CountMap; byPaymentStatus: CountMap };
}
export interface UpcomingVisit { id: string; visitType: string; scheduledAt: string; status: VisitStatus; patientId: string; patientName: string | null; trialId: string; trialCode: string | null; siteName: string | null }
export interface VisitStats { generatedAt: string; total: number; byStatus: CountMap; windowDays: number; upcomingInWindow: number; upcoming: UpcomingVisit[] }
export interface ReimbursementStats {
  generatedAt: string;
  total: number;
  byStatus: CountMap;
  byPaymentStatus: CountMap;
  byCategory: Array<{ category: string; currency: string; count: number; amountCents: number }>;
  totals: Array<{ currency: string; count: number; amountCents: number; pendingAmountCents: number; approvedAmountCents: number; paidAmountCents: number }>;
  oldestPendingAt: string | null;
}
export interface SponsorStats {
  generatedAt: string;
  trials: { total: number; byStatus: CountMap };
  risk: {
    basis: string;
    assessedEntities: number;
    byLevel: CountMap;
    byEntityType: Record<string, CountMap>;
    highOrCritical: number;
    storedAssessments: number;
    top: Array<{ id: string; entityType: string; entityId: string; entityName: string | null; score: number; level: RiskLevel; assessedAt: string }>;
  };
  integrity: { total: number; byStatus: CountMap; open: number; openBySeverity: CountMap };
  audit: { totalEvents: number; headSeq: number; lastEventAt: string | null };
}
