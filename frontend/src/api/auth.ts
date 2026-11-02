import { get, post } from './client';
import type { LoginResult, User } from '@/types/api';

export const authApi = {
  login: (email: string, password: string) => post<LoginResult>('/auth/login', { email, password }),
  /** Always creates a `patient` account and returns a session, like login. */
  register: (b: { email: string; password: string; fullName: string }) => post<LoginResult>('/auth/register', b),
  me: () => get<User>('/auth/me'),
};
