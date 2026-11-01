import { z } from 'zod';
import { pageQuery } from '../../utils/http';

const category = z.enum(['travel', 'meals', 'accommodation', 'parking', 'other']);
const status = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const paymentStatus = z.enum(['none', 'unpaid', 'processing', 'paid', 'failed']);

export const createReimbursementBody = z.object({
  visitId: z.string().uuid(),
  category,
  amountCents: z.number().int().min(1).max(10_000_000),
  currency: z.string().length(3).toUpperCase().default('USD'),
  description: z.string().trim().max(1000).optional(),
});

export const updateReimbursementBody = z
  .object({
    category,
    amountCents: z.number().int().min(1).max(10_000_000),
    description: z.string().trim().max(1000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const noteBody = z.object({ note: z.string().trim().max(500).optional() });

export const paymentBody = z
  .object({
    status: z.enum(['processing', 'paid', 'failed']),
    transactionRef: z.string().trim().min(3).max(100).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status !== 'paid' || !!v.transactionRef, { message: 'transactionRef is required when marking as paid', path: ['transactionRef'] });

export const listReimbursementsQuery = z.object({
  ...pageQuery,
  patientId: z.string().uuid().optional(),
  visitId: z.string().uuid().optional(),
  trialId: z.string().uuid().optional(),
  status: status.optional(),
  paymentStatus: paymentStatus.optional(),
  category: category.optional(),
  minAmountCents: z.coerce.number().int().min(0).optional(),
  maxAmountCents: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['createdAt', 'amountCents']).default('createdAt'),
});
