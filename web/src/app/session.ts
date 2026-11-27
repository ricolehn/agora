// The signed-in account and what it may do. Every permission check is a function that reads the account signal, so
// used in JSX (or a memo) it follows a change of the account (a reload of /auth/me, a new group).
import { createSignal } from 'solid-js';
import { inList } from './util';
import { flushNow } from './flush';
import type { PermissionFlag, PermissionId, User } from './types';

export type { User };

const [currentUser, setCurrentUserSignal] = createSignal<User | null>(null);
const [isAuthenticated, setAuthenticated] = createSignal(false);
// The AI assistant is switched on by the system admins (GET /admin/ai-status)
const [aiEnabled, setAiEnabled] = createSignal(false);

export { currentUser, isAuthenticated, aiEnabled, setAiEnabled };

/** Replaces the account (applied at once: imperative code may read it right after). */
export function setCurrentUser(user: User | null) {
  setCurrentUserSignal(user);
  flushNow();
}
/** Merges fields into the account. */
export function patchCurrentUser(fields: Partial<User>) {
  const user = currentUser();
  if (!user) return;
  setCurrentUserSignal({ ...user, ...fields });
  flushNow();
}
export function setIsAuthenticated(value: boolean) {
  setAuthenticated(value);
  flushNow();
}

const hasPermission = (flag: PermissionFlag, permission: PermissionId) => {
  const user = currentUser();
  return !!(user && (user[flag] || inList(user.permissions, permission)));
};
export const isSuperAdminUser = () => {
  const user = currentUser();
  return !!(user && (user.admin || user.owner || user.superAdmin));
};
export const isOwnerUser = () => {
  const user = currentUser();
  return !!(user && (user.owner || user.superAdmin));
};
export const canManageFinances = () => hasPermission('canManageFinances', 'manage_finances');
export const canViewFinances = () => canManageFinances() || hasPermission('canViewFinances', 'view_finances');
export const canAccessAi = () => hasPermission('canAccessAi', 'access_ai');
export const canUseMentoring = () => !!currentUser();
export const canManageMentoring = () => hasPermission('canManageMentoring', 'manage_mentoring');
// Admins too need the permission (group with "manage events") to create appointments and manage events
export const canManageEvents = () => hasPermission('canManageEvents', 'manage_events');
export const canManageRegistrationCode = () => hasPermission('canManageRegistrationCode', 'manage_registration_code');
export const canApproveRequests = () => canManageFinances() || isOwnerUser();

export const currentUid = (): string | undefined => {
  const user = currentUser();
  return user?.uid || user?.id;
};
export const isCurrentUser = (id: unknown) => {
  const user = currentUser();
  return !!user && (id === user.uid || id === user.id);
};

export type AvatarRing = 'manager' | 'mentor' | 'standard';
/** The coloured ring around a person's picture: mentoring managers, approved mentors, everyone else. */
export function avatarRing(user: User | null | undefined): AvatarRing {
  if (user?.canManageMentoring || inList(user?.permissions, 'manage_mentoring')) return 'manager';
  if (user?.isApprovedMentor || user?.mentorStatus === 'approved') return 'mentor';
  return 'standard';
}
