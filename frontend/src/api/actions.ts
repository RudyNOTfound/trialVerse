import { get, getPage, patch, post } from './client';
import type { ActionItem, ActionStatus, HistoryEntry, Priority } from '@/types/api';

export interface ActionFilters { page?: number; pageSize?: number; status?: ActionStatus | 'overdue'; priority?: Priority; assigneeId?: string; trialId?: string; patientId?: string; visitId?: string; sort?: 'createdAt' | 'dueDate' | 'priority'; order?: 'asc' | 'desc' }
export interface ActionInput { title: string; description?: string; priority?: Priority; dueDate?: string; assigneeId?: string; trialId?: string; patientId?: string; visitId?: string }

/** PATCH body: dueDate and assigneeId can be cleared with null. */
export interface ActionUpdate { title?: string; description?: string; priority?: Priority; dueDate?: string | null; assigneeId?: string | null }

export const actionsApi = {
  list: (f: ActionFilters = {}) => getPage<ActionItem>('/actions', f),
  get: (id: string) => get<ActionItem>(`/actions/${id}`),
  history: (id: string) => get<HistoryEntry[]>(`/actions/${id}/history`),
  create: (b: ActionInput) => post<ActionItem>('/actions', b),
  update: (id: string, b: ActionUpdate) => patch<ActionItem>(`/actions/${id}`, b),
  setStatus: (id: string, status: ActionStatus, note?: string) => post<ActionItem>(`/actions/${id}/status`, { status, note }),
};
