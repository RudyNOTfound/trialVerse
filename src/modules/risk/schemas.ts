import { z } from 'zod';
import { pageQuery } from '../../utils/http';

const entityType = z.enum(['patient', 'visit', 'reimbursement']);
const level = z.enum(['low', 'medium', 'high', 'critical']);

export const assessBody = z.object({ entityType, entityId: z.string().uuid() });

export const listAssessmentsQuery = z.object({
  ...pageQuery,
  entityType: entityType.optional(),
  entityId: z.string().uuid().optional(),
  level: level.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(['assessedAt', 'score']).default('assessedAt'),
});
