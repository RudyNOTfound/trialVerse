import { z } from 'zod';
import { passwordSchema } from '../users/schemas';

export const registerBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
});

export const loginBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(128),
});
