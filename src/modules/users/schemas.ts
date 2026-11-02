import { z } from 'zod';
import { pageQuery } from '../../utils/http';

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a digit');

export const roleSchema = z.enum(['admin', 'coordinator', 'investigator', 'patient']);

export const createUserBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
  role: roleSchema,
});

export const updateUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    role: roleSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const staffRoleSchema = z.enum(['admin', 'coordinator', 'investigator']);

/** Staff directory: names only, no email, and never patient accounts. */
export const directoryQuery = z.object({
  ...pageQuery,
  order: z.enum(['asc', 'desc']).default('asc'),
  role: staffRoleSchema.optional(),
  search: z.string().trim().max(100).optional(),
  /** Inactive staff are hidden by default (pickers); set true to resolve historical names. */
  includeInactive: z.enum(['true', 'false']).default('false'),
});

export const listUsersQuery = z.object({
  ...pageQuery,
  role: roleSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  search: z.string().max(100).optional(),
  sort: z.enum(['createdAt', 'email', 'fullName']).default('createdAt'),
});
