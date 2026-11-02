import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Actor, Ctx, Role } from '../../context';
import { AppError } from '../../utils/errors';
import { inTransaction, mapRow, mapRows, nowIso, orderBy } from '../../utils/db';
import { appendAuditEvent } from '../audit/chain';

export interface UserDto {
  id: string; email: string; fullName: string; role: Role; isActive: boolean;
  lastLoginAt: string | null; createdAt: string; updatedAt: string;
}

export interface StaffDirectoryEntry { id: string; fullName: string; role: 'admin' | 'coordinator' | 'investigator'; isActive: boolean }

const COLS = 'id, email, full_name, role, is_active, last_login_at, created_at, updated_at';

export function createUserService(ctx: Ctx) {
  const { db } = ctx;

  const getById = (id: string): UserDto => {
    const u = mapRow<UserDto>(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as any);
    if (!u) throw AppError.notFound('User');
    return u;
  };

  return {
    getById,

    /** Creates a user. `actor` is null for self-registration. */
    async create(input: { email: string; password: string; fullName: string; role: Role }, actor: Actor | null): Promise<UserDto> {
      const hash = await bcrypt.hash(input.password, ctx.config.bcryptRounds);
      const id = randomUUID();
      const now = nowIso();
      try {
        inTransaction(db, () => {
          db.prepare(
            `INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          ).run(id, input.email, hash, input.fullName, input.role, now, now);
          appendAuditEvent(db, {
            actorId: actor?.id ?? id, action: 'user.created', entityType: 'user', entityId: id,
            metadata: { role: input.role, selfRegistered: !actor },
          });
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw AppError.conflict('A user with this email already exists');
        throw err;
      }
      return getById(id);
    },

    list(q: { page: number; pageSize: number; order: 'asc' | 'desc'; role?: string; isActive?: string; search?: string; sort: string }) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.role) { where.push('role = ?'); params.push(q.role); }
      if (q.isActive) { where.push('is_active = ?'); params.push(q.isActive === 'true' ? 1 : 0); }
      if (q.search) { where.push('(email LIKE ? OR full_name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) c FROM users ${w}`).get(...params) as { c: number }).c;
      const ob = orderBy(q.sort, q.order, { createdAt: 'created_at', email: 'email', fullName: 'full_name' }, 'created_at');
      const rows = db.prepare(`SELECT ${COLS} FROM users ${w} ${ob} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<UserDto>(rows), total };
    },

    /**
     * Minimal staff directory for operational pickers (principal investigator, assignee) and name display.
     * Returns only id, fullName, role and isActive. Patient accounts and emails are never included.
     */
    directory(q: { page: number; pageSize: number; order: 'asc' | 'desc'; role?: string; search?: string; includeInactive: string }) {
      const where: string[] = [`role IN ('admin', 'coordinator', 'investigator')`];
      const params: unknown[] = [];
      if (q.role) { where.push('role = ?'); params.push(q.role); }
      if (q.includeInactive !== 'true') where.push('is_active = 1');
      if (q.search) { where.push('full_name LIKE ?'); params.push(`%${q.search}%`); }
      const w = `WHERE ${where.join(' AND ')}`;
      const total = (db.prepare(`SELECT COUNT(*) c FROM users ${w}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT id, full_name, role, is_active FROM users ${w} ORDER BY full_name ${q.order === 'asc' ? 'ASC' : 'DESC'}, id LIMIT ? OFFSET ?`)
        .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as any[];
      return { items: mapRows<StaffDirectoryEntry>(rows), total };
    },

    update(id: string, patch: { fullName?: string; role?: Role; isActive?: boolean }, actor: Actor): UserDto {
      const existing = getById(id);
      if (id === actor.id && (patch.role !== undefined && patch.role !== existing.role || patch.isActive === false)) {
        throw AppError.conflict('You cannot change your own role or deactivate your own account');
      }
      inTransaction(db, () => {
        db.prepare(
          `UPDATE users SET full_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        ).run(patch.fullName ?? existing.fullName, patch.role ?? existing.role, (patch.isActive ?? existing.isActive) ? 1 : 0, nowIso(), id);
        appendAuditEvent(db, {
          actorId: actor.id, action: 'user.updated', entityType: 'user', entityId: id,
          metadata: {
            changes: {
              ...(patch.role !== undefined && patch.role !== existing.role ? { role: { from: existing.role, to: patch.role } } : {}),
              ...(patch.isActive !== undefined && patch.isActive !== existing.isActive ? { isActive: { from: existing.isActive, to: patch.isActive } } : {}),
              ...(patch.fullName !== undefined && patch.fullName !== existing.fullName ? { fullName: true } : {}),
            },
          },
        });
      });
      return getById(id);
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
