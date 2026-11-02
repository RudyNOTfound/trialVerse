import { getPage } from './client';
import type { User } from '@/types/api';

export const usersApi = {
  /** Admin only. Used to resolve actor / assignee names where the role allows it. */
  list: (page = 1, pageSize = 100) => getPage<User>('/users', { page, pageSize }),
};
