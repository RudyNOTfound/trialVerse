import { z } from 'zod';
import { isoDate, pageQuery } from '../../utils/http';

export const auditListQuery = z.object({
  ...pageQuery,
  actorId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
