import { get, getPage, patch, post } from './client';
import type { Role, User } from '@/types/api';

export interface UserFilters { page?: number; pageSize?: number; role?: Role; isActive?: 'true' | 'false'; search?: string; sort?: 'createdAt' | 'email' | 'fullName'; order?: 'asc' | 'desc' }
export interface UserInput { email: string; password: string; fullName: string; role: Role }

/** All admin-only. Other roles receive 403. */
export const usersApi = {
  list: (f: UserFilters = {}) => getPage<User>('/users', f),
  get: (id: string) => get<User>(`/users/${id}`),
  create: (b: UserInput) => post<User>('/users', b),
  update: (id: string, b: { fullName?: string; role?: Role; isActive?: boolean }) => patch<User>(`/users/${id}`, b),
};
