import { get, post } from './client';
import type { LoginResult, User } from '@/types/api';

export const authApi = {
  login: (email: string, password: string) => post<LoginResult>('/auth/login', { email, password }),
  me: () => get<User>('/auth/me'),
};
