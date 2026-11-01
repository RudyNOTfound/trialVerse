import { z } from 'zod';
import { isoDate, pageQuery } from '../../utils/http';

const priority = z.enum(['low', 'medium', 'high', 'critical']);

export const createActionBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  priority: priority.default('medium'),
  dueDate: isoDate.optional(),
  assigneeId: z.string().uuid().optional(),
  trialId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  visitId: z.string().uuid().optional(),
});

export const updateActionBody = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000),
    priority,
    dueDate: isoDate.nullable(),
    assigneeId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const actionStatusBody = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  note: z.string().trim().max(500).optional(),
});

export const listActionsQuery = z.object({
  ...pageQuery,
  // "overdue" is derived: open (pending / in_progress) with a dueDate in the past.
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled', 'overdue']).optional(),
  priority: priority.optional(),
  assigneeId: z.string().uuid().optional(),
  trialId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  visitId: z.string().uuid().optional(),
  dueBefore: isoDate.optional(),
  sort: z.enum(['createdAt', 'dueDate', 'priority']).default('createdAt'),
});
