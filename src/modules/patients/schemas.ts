import { z } from 'zod';
import { dateOnly, pageQuery } from '../../utils/http';

const name = z.string().trim().min(1).max(80);

export const createPatientBody = z.object({
  subjectCode: z.string().trim().regex(/^[A-Za-z0-9-]{3,30}$/, 'subjectCode must be 3-30 alphanumeric/dash characters').optional(),
  firstName: name,
  lastName: name,
  dateOfBirth: dateOnly.refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d) <= new Date(), 'dateOfBirth must be a valid past date'),
  sex: z.enum(['female', 'male', 'other', 'unknown']),
  email: z.string().email().max(254).optional(),
  phone: z.string().trim().max(30).optional(),
  userId: z.string().uuid().optional(),
});

export const updatePatientBody = createPatientBody
  .omit({ subjectCode: true })
  .partial()
  .extend({
    status: z.enum(['active', 'withdrawn', 'inactive']).optional(),
    userId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const linkAccountBody = z.object({ userId: z.string().uuid() });

export const linkableAccountsQuery = z.object({
  ...pageQuery,
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(100).optional(),
});

export const listPatientsQuery = z.object({
  ...pageQuery,
  search: z.string().max(100).optional(),
  status: z.enum(['active', 'withdrawn', 'inactive']).optional(),
  trialId: z.string().uuid().optional(),
  sort: z.enum(['createdAt', 'lastName', 'subjectCode']).default('createdAt'),
});
