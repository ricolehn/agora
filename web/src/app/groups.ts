// Groups and permissions (system settings, event audiences, the duty plan). System admins get all groups with their
// members and the list of permissions; everyone else the groups they may see.
import { createSignal } from 'solid-js';
import { api } from './api';
import { currentUser, isSuperAdminUser } from './session';
import type { Group, Permission, User } from './types';

export const DEFAULT_PERMISSIONS: Permission[] = [
  { id: 'view_finances', name: 'Finance management (read only)', description: 'Allows viewing balances, history, transactions and reports without editing rights' },
  { id: 'manage_finances', name: 'Finance management (full access)', description: 'Allows recording, editing, booking and deleting payments, donations, expenses and standing orders' },
  { id: 'manage_registration_code', name: 'Manage registration code', description: 'Allows viewing, copying and regenerating the registration code for new members' },
  { id: 'access_ai', name: 'Use AI support', description: 'Allows access to and use of the built-in AI assistant' },
  { id: 'manage_mentoring', name: 'Mentoring management', description: 'Allows leaders to review, approve or reject mentor applications (no access to private chats)' },
  { id: 'manage_events', name: 'Event & duty roster management', description: 'Allows creating recurring appointments and full management of all events and duties' },
  { id: 'manage_songbook', name: 'Manage songbook', description: 'Allows adding, editing and deleting songs in the songbook' },
  { id: 'manage_prayers', name: 'Moderate prayer requests', description: 'Allows removing unsuitable prayer requests (anonymous ones stay anonymous)' },
  { id: 'manage_media', name: 'Extended media rights', description: 'Allows deciding which groups may read, write or not see a media folder; sees every folder, its files only where the rights allow' }
];

const [systemGroups, setSystemGroups] = createSignal<Group[]>([]);
const [systemPermissions, setSystemPermissions] = createSignal<Permission[]>(DEFAULT_PERMISSIONS);
export { systemGroups, systemPermissions };

/** The groups as a list (never null). */
export const groupList = () => (Array.isArray(systemGroups()) ? systemGroups() : []);
export const findGroup = (idOrName: string) => groupList().find(g => g.id === idOrName || g.name === idOrName);

/** Whether [user] is in the group [groupId] (accounts keep their groups by id, very old ones by name). */
export const userInGroup = (user: User | null | undefined, groupId: string): boolean => (user?.groups ?? []).includes(groupId);

async function fetchSystemGroups() {
  if (!currentUser()) return;
  try {
    if (isSuperAdminUser()) {
      try {
        const res = await api('/admin/permissions');
        if (res.ok) {
          const list = (await res.json()) as Permission[];
          setSystemPermissions(Array.isArray(list) && list.length ? list : DEFAULT_PERMISSIONS);
        }
      } catch (err) {
        console.warn('Failed to load permissions list:', err);
      }
      const res = await api('/admin/groups');
      if (res.ok) {
        setSystemGroups((await res.json()) as Group[]);
        return;
      }
    }
    const res = await api('/groups');
    if (res.ok) setSystemGroups((await res.json()) as Group[]);
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

// Several views ask for the groups during one refresh: they share the request that is already running
let systemGroupsRequest: Promise<void> | null = null;
// maxAgeMs: reuse a list loaded that recently (the start loads it with the events and again for the views)
let systemGroupsLoadedAt = 0;
export function loadSystemGroups(maxAgeMs = 0): Promise<void> {
  if (maxAgeMs && Date.now() - systemGroupsLoadedAt < maxAgeMs) return Promise.resolve();
  if (!systemGroupsRequest) {
    systemGroupsRequest = fetchSystemGroups()
      .then(() => {
        systemGroupsLoadedAt = Date.now();
      })
      .finally(() => {
        systemGroupsRequest = null;
      });
  }
  return systemGroupsRequest;
}
