import { z } from 'zod';
import { dateOnly, pageQuery } from '../../utils/http';

const phase = z.enum(['I', 'I/II', 'II', 'II/III', 'III', 'IV']);
const trialStatus = z.enum(['draft', 'active', 'suspended', 'completed', 'terminated']);

const trialFields = {
  code: z.string().trim().regex(/^[A-Za-z0-9-]{3,30}$/, 'code must be 3-30 alphanumeric/dash characters'),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  sponsor: z.string().trim().min(1).max(120),
  phase,
  startDate: dateOnly.optional(),
  endDate: dateOnly.optional(),
};

const datesOrdered = (v: { startDate?: string; endDate?: string }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;

export const createTrialBody = z.object(trialFields).refine(datesOrdered, { message: 'endDate must not be before startDate', path: ['endDate'] });

export const updateTrialBody = z
  .object({ ...trialFields, status: trialStatus })
  .omit({ code: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required')
  .refine(datesOrdered, { message: 'endDate must not be before startDate', path: ['endDate'] });

export const listTrialsQuery = z.object({
  ...pageQuery,
  status: trialStatus.optional(),
  phase: phase.optional(),
  search: z.string().max(100).optional(),
  sort: z.enum(['createdAt', 'code', 'title', 'startDate']).default('createdAt'),
});

export const createSiteBody = z.object({
  siteCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, 'siteCode must be 2-20 alphanumeric/dash characters'),
  name: z.string().trim().min(1).max(160),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().min(2).max(80),
  principalInvestigatorId: z.string().uuid().optional(),
});

export const updateSiteBody = createSiteBody
  .omit({ siteCode: true })
  .partial()
  .extend({ principalInvestigatorId: z.string().uuid().nullable().optional(), status: z.enum(['active', 'inactive', 'closed']).optional() })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const trialSiteParams = z.object({ id: z.string().uuid(), siteId: z.string().uuid() });

export const createEnrollmentBody = z.object({
  patientId: z.string().uuid(),
  trialId: z.string().uuid(),
  trialSiteId: z.string().uuid(),
  arm: z.string().trim().max(60).optional(),
});

export const updateEnrollmentBody = z.object({
  status: z.enum(['screening', 'enrolled', 'completed', 'withdrawn', 'screen_failed']),
});

export const listEnrollmentsQuery = z.object({
  ...pageQuery,
  trialId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  trialSiteId: z.string().uuid().optional(),
  status: z.enum(['screening', 'enrolled', 'completed', 'withdrawn', 'screen_failed']).optional(),
  sort: z.enum(['createdAt', 'enrolledAt']).default('createdAt'),
});
