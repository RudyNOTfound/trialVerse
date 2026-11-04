import { z } from 'zod';

/** Mirrors the backend passwordSchema (src/modules/users/schemas.ts). The server remains the authority. */
export const passwordRules = z.string()
  .min(10, 'At least 10 characters')
  .max(128, 'At most 128 characters')
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a digit');
