import { z } from 'zod';
import { isoDate, pageQuery } from '../../utils/http';

/**
 * Capture APIs for the data the ML contract v1.1 needs (see docs/ML_INTEGRATION.md). The shapes follow migration 002 exactly:
 * nothing here adds a field, a status or a unit the database does not already have.
 */
const uuid = z.string().uuid();

export const patientParam = z.object({ patientId: uuid.describe('patient id') });
export const recordParam = z.object({ id: uuid });

// ------------------------------------------------------------------------------------------------ measurements
/**
 * One measurement set per visit (visit_measurements.visit_id is the primary key, so a measurement's id IS its visit's id).
 * Units are fixed by the contract and are never converted: systolic/diastolic BP in mmHg, heart rate in bpm, weight in kg, glucose in mg/dL.
 * Structural checks only (positive numbers). An implausible-but-possible value must stay storable: flagging it is the integrity engine's job.
 */
const vital = z.number().positive('must be a positive number');

export const createMeasurementBody = z.object({
  visitId: uuid,
  performedAt: isoDate.describe('when the measurement was taken (device clock), ISO-8601 with offset'),
  systolicBp: vital.optional().describe('mmHg'),
  diastolicBp: vital.optional().describe('mmHg'),
  heartRate: vital.optional().describe('beats per minute'),
  weightKg: vital.optional().describe('kg'),
  glucoseMgDl: vital.optional().describe('mg/dL'),
}).strict().refine((v) => [v.systolicBp, v.diastolicBp, v.heartRate, v.weightKg, v.glucoseMgDl].some((x) => x !== undefined), 'At least one measurement value is required');

export const listMeasurementsQuery = z.object({ ...pageQuery, visitId: uuid.optional() });

// ------------------------------------------------------------------------------------------------ ECG references
/**
 * The project stores a REFERENCE to an ECG image (a path relative to the shared ML_ECG_DIR), never the image bytes. Several records may
 * point at the same file: re-used ECGs are exactly what the integrity engine looks for, so a repeated fileRef is accepted, not rejected.
 */
export const ecgFileRef = z.string().min(1).max(500)
  .refine((s) => !s.startsWith('/') && !s.startsWith('\\') && !/^[a-zA-Z]:/.test(s), 'fileRef must be relative to the ECG directory (no absolute paths)')
  .refine((s) => !s.includes('\\') && !s.includes('\0') && !/[\u0000-\u001f]/.test(s), 'fileRef must not contain backslashes or control characters')
  .refine((s) => !s.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'fileRef must not contain empty, "." or ".." path segments');

export const createEcgBody = z.object({
  visitId: uuid,
  fileRef: ecgFileRef,
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, 'fileSha256 must be 64 lowercase hex characters').optional(),
  recordedAt: isoDate.optional(),
}).strict();

export const listEcgsQuery = z.object({ ...pageQuery, visitId: uuid.optional() });

// ------------------------------------------------------------------------------------------------ reminders
/** Both ids are optional individually, but one must say which enrollment the reminder is about (a visit determines its enrollment). */
const target = {
  enrollmentId: uuid.optional(),
  visitId: uuid.optional(),
};
const needsTarget = (v: { enrollmentId?: string; visitId?: string }) => v.enrollmentId !== undefined || v.visitId !== undefined;
const TARGET_MSG = 'enrollmentId or visitId is required';

export const REMINDER_CHANNELS = ['sms', 'ivr', 'call', 'other'] as const;
export const REMINDER_OUTCOMES = ['sent', 'acknowledged', 'missed'] as const;

export const createReminderBody = z.object({
  ...target,
  channel: z.enum(REMINDER_CHANNELS),
  sentAt: isoDate,
}).strict().refine(needsTarget, TARGET_MSG);

/** A reminder is created as 'sent' and is resolved once: acknowledged (optionally when) or missed. */
export const updateReminderBody = z.object({
  outcome: z.enum(['acknowledged', 'missed']),
  acknowledgedAt: isoDate.optional().describe("only with outcome 'acknowledged'; defaults to now"),
}).strict().refine((v) => v.outcome === 'acknowledged' || v.acknowledgedAt === undefined, { message: "acknowledgedAt is only valid with outcome 'acknowledged'", path: ['acknowledgedAt'] });

export const listRemindersQuery = z.object({ ...pageQuery, outcome: z.enum(REMINDER_OUTCOMES).optional(), enrollmentId: uuid.optional() });

// ------------------------------------------------------------------------------------------------ adverse events
/** The database records THAT an adverse event was reported (and when), nothing more: no severity scale, type or free text. */
export const createAdverseEventBody = z.object({
  ...target,
  reportedAt: isoDate.optional().describe('defaults to now'),
}).strict().refine(needsTarget, TARGET_MSG);

export const listAdverseEventsQuery = z.object({ ...pageQuery, enrollmentId: uuid.optional() });
