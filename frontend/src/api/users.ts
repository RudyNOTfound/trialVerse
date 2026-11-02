import { get, getPage, patch, post } from './client';
import type { Role, StaffEntry, User } from '@/types/api';

export interface UserFilters { page?: number; pageSize?: number; role?: Role; isActive?: 'true' | 'false'; search?: string; sort?: 'createdAt' | 'email' | 'fullName'; order?: 'asc' | 'desc' }
export interface UserInput { email: string; password: string; fullName: string; role: Role }

export interface DirectoryFilters { page?: number; pageSize?: number; role?: StaffEntry['role']; search?: string; includeInactive?: boolean }

/** Everything except `directory` is admin-only. Other roles receive 403. */
export const usersApi = {
  /** Staff-readable (admin, coordinator, investigator): id, fullName, role, isActive only. Never patients or emails. */
  directory: (f: DirectoryFilters = {}) => getPage<StaffEntry>('/users/directory', { ...f, includeInactive: f.includeInactive ? 'true' : undefined }),
  list: (f: UserFilters = {}) => getPage<User>('/users', f),
  get: (id: string) => get<User>(`/users/${id}`),
  create: (b: UserInput) => post<User>('/users', b),
  update: (id: string, b: { fullName?: string; role?: Role; isActive?: boolean }) => patch<User>(`/users/${id}`, b),
};
