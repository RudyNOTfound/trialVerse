import type { Role } from '@/types/api';

/** Three experiences. Server-side RBAC remains the real gate; this only decides which UI to show. */
export type Workspace = 'operations' | 'sponsor' | 'participant';

export const WORKSPACE_ROLES: Record<Workspace, Role[]> = {
  operations: ['admin', 'coordinator', 'investigator'],
  sponsor: ['admin', 'investigator'],
  participant: ['patient'],
};

export const WORKSPACE_PATH: Record<Workspace, string> = {
  operations: '/app',
  sponsor: '/sponsor',
  participant: '/me',
};

export function homePathFor(role: Role): string {
  switch (role) {
    case 'patient': return WORKSPACE_PATH.participant;
    case 'investigator': return WORKSPACE_PATH.sponsor;
    default: return WORKSPACE_PATH.operations;
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  coordinator: 'Site Coordinator',
  investigator: 'Investigator',
  patient: 'Participant',
};
