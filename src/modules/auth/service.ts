import bcrypt from 'bcryptjs';
import type { Ctx, Role } from '../../context';
import { signToken } from '../../middleware/auth';
import { sha256 } from '../../utils/crypto';
import { inTransaction, nowIso } from '../../utils/db';
import { AppError } from '../../utils/errors';
import { appendAuditEvent } from '../audit/chain';
import type { UserService } from '../users/service';

export function createAuthService(ctx: Ctx, users: UserService) {
  const { db } = ctx;
  // Compared against when the email is unknown so response time does not reveal account existence.
  const dummyHash = bcrypt.hashSync('not-a-real-password', ctx.config.bcryptRounds);

  return {
    /** Public self-registration. Always creates a `patient` account; staff accounts are created by admins. */
    async register(input: { email: string; password: string; fullName: string }) {
      const user = await users.create({ ...input, role: 'patient' }, null);
      return { user, token: signToken(ctx, user) };
    },

    async login(email: string, password: string) {
      const row = db.prepare('SELECT id, password_hash, role, is_active FROM users WHERE email = ?').get(email) as
        | { id: string; password_hash: string; role: Role; is_active: number } | undefined;
      const match = await bcrypt.compare(password, row?.password_hash ?? dummyHash);
      const success = Boolean(row && row.is_active && match);

      inTransaction(db, () => {
        appendAuditEvent(db, {
          actorId: success ? row!.id : null,
          action: success ? 'auth.login_succeeded' : 'auth.login_failed',
          entityType: 'user',
          entityId: row?.id ?? 'unknown',
          metadata: success ? {} : { emailHash: sha256(email).slice(0, 16), reason: !row ? 'unknown_user' : !row.is_active ? 'inactive' : 'bad_password' },
        });
        if (success) db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row!.id);
      });

      if (!success) throw AppError.unauthenticated('Invalid email or password');
      const user = users.getById(row!.id);
      return { user, token: signToken(ctx, user) };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
