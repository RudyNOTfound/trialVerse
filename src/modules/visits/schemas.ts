import { z } from 'zod';
import { isoDate, pageQuery } from '../../utils/http';

export const createVisitBody = z.object({
  enrollmentId: z.string().uuid(),
  visitType: z.string().trim().min(1).max(60),
  scheduledAt: isoDate,
  notes: z.string().trim().max(2000).optional(),
});

export const updateVisitBody = z
  .object({
    visitType: z.string().trim().min(1).max(60),
    scheduledAt: isoDate,
    notes: z.string().trim().max(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const visitStatusBody = z.object({
  status: z.enum(['completed', 'missed', 'cancelled']),
  note: z.string().trim().max(500).optional(),
});

const visitStatus = z.enum(['scheduled', 'otp_pending', 'verified', 'completed', 'missed', 'cancelled']);

export const listVisitsQuery = z.object({
  ...pageQuery,
  patientId: z.string().uuid().optional(),
  trialId: z.string().uuid().optional(),
  trialSiteId: z.string().uuid().optional(),
  enrollmentId: z.string().uuid().optional(),
  status: visitStatus.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['scheduledAt', 'createdAt']).default('scheduledAt'),
});

export const verifyOtpBody = z.object({
  code: z.string().regex(/^\d{4,10}$/, 'code must be 4-10 digits'),
});
