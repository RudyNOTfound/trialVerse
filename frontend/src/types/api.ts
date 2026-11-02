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
}

export type OtpState = 'active' | 'used' | 'locked' | 'expired' | 'superseded';
export interface OtpStatus {
  id: string;
  visitId: string;
  status: OtpState;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}
export interface OtpIssueResult {
  otpId: string;
  visitId: string;
  expiresAt: string;
  maxAttempts: number;
  /** Present only when the backend runs with DEMO_OTP_ENABLED=true. */
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

export interface IntegrityScanSummary {
  engine: { name: string; version: string };
  fallback: { used: boolean; reason?: string };
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
