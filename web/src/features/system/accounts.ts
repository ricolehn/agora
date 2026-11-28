// System settings: the accounts (filter by group, search, the settings of each account) and the groups with their
// permissions. The groups themselves are shared state (app/groups.ts); after a change they and the accounts are loaded
// again.
import { createSignal } from 'solid-js';
import { apiJson, errorMessage } from '../../app/api';
import { findLinkedPerson, loadData, people, refreshCurrentUser, replacePersonInMemory, setUsers, users } from '../../app/data';
import { findGroup, loadSystemGroups } from '../../app/groups';
import { t } from '../../app/i18n';
import { currentUser, isSuperAdminUser } from '../../app/session';
import { attempt, confirmAction, showToast } from '../../app/toast';
import { flushNow } from '../../app/flush';
import type { User } from '../../app/types';

// --- Filter and search of the accounts table ---
const [groupFilter, setGroupFilter] = createSignal<string | null>(null);
const [accountSearch, setAccountSearch] = createSignal('');
export { groupFilter, accountSearch, setAccountSearch };

export function filterByGroup(groupId: string | null) {
  setGroupFilter(groupId);
  flushNow();
}

const rawName = (u: User) => `${u.firstName || ''} ${u.lastName || ''}`;
/** The group the table is filtered by (null: all accounts, or a group that is gone). */
export const activeGroup = () => {
  const id = groupFilter();
  return id ? findGroup(id) || null : null;
};
/** The accounts the table shows: in the filtered group, matching the search, by name. */
export function shownAccounts() {
  const filter = groupFilter();
  const group = activeGroup();
  const query = accountSearch().toLowerCase().trim();
  return users()
    .filter(u => {
      const groups: string[] = Array.isArray(u.groups) ? u.groups : [];
      if (filter && !(groups.includes(filter) || (group && (groups.includes(group.name) || groups.includes(group.id))))) return false;
      return !query || rawName(u).toLowerCase().includes(query) || (u.email || '').toLowerCase().includes(query);
    })
    .sort((a, b) => rawName(a).localeCompare(rawName(b)));
}

// --- Loading again after a change ---
async function reloadUsersData() {
  try {
    setUsers(await apiJson<User[]>('/admin/users'));
  } catch (err) {
    console.warn('Failed to reload users:', err);
  }
}

/** The groups and the accounts again; refreshSelf: also the own account (its permissions may have changed). */
export async function refreshGroupsAndUsers(refreshSelf = true) {
  await loadSystemGroups();
  await reloadUsersData();
  if (refreshSelf) await refreshCurrentUser();
}

const updateUser = (uid: string, fields: Record<string, unknown>) => setUsers(list => list.map(u => (u.uid === uid ? { ...u, ...fields } : u)));

// --- The settings of one account, saved at once from the table ---
async function saveUserSetting(uid: string, field: 'member-since' | 'admin' | 'pays', payload: object, applyLocal: () => void, successMsg: string, errorMsg: string, logMsg: string) {
  if (!isSuperAdminUser()) return;
  try {
    await apiJson(`/admin/users/${uid}/${field}`, 'PUT', payload);
    applyLocal();
    showToast(successMsg);
  } catch (err) {
    console.error(logMsg, err);
    showToast(errorMsg, 'error');
    // The table shows what is stored again
    void loadData();
  }
}

export const updateUserMemberSince = (uid: string, memberSince: string) =>
  saveUserSetting(
    uid,
    'member-since',
    { memberSince },
    () => {
      updateUser(uid, { memberSince });
      const linked = findLinkedPerson(uid);
      if (linked) {
        replacePersonInMemory({
          ...linked,
          memberSince,
          originalMemberSince: memberSince,
          data: linked.data ? { ...linked.data, memberSince, originalMemberSince: memberSince } : linked.data
        });
      }
    },
    t('toast_member_since_updated', 'Membership date updated'),
    t('toast_member_since_failed', 'Membership date could not be saved'),
    'Saving the membership date failed:'
  );

export const toggleUserSystemAdmin = (uid: string, isAdmin: boolean) =>
  saveUserSetting(
    uid,
    'admin',
    { admin: isAdmin },
    () => updateUser(uid, { admin: isAdmin }),
    t('toast_admin_updated', 'System Admin privileges updated'),
    t('toast_user_rights_failed', 'Failed to save user rights'),
    'Saving the admin role failed:'
  );

export const toggleUserPays = (uid: string, pays: boolean) =>
  saveUserSetting(
    uid,
    'pays',
    { pays },
    () => {
      updateUser(uid, { pays });
      const linked = people().find(p => p.uid === uid);
      if (linked) replacePersonInMemory({ ...linked, pays, data: linked.data ? { ...linked.data, pays } : linked.data });
    },
    t('toast_pays_updated', 'Payment status updated'),
    t('toast_pays_failed', 'Fee status could not be saved'),
    'Saving the fee status failed:'
  );

export async function deleteUserAccount(uid: string) {
  if (!confirmAction(t('confirm_delete_user', 'Are you sure you want to delete this user account?'))) return;
  await attempt(
    async () => {
      await apiJson(`/admin/users/${uid}`, 'DELETE', undefined, t('toast_delete_failed_short', 'Deletion failed'));
      setUsers(list => list.filter(u => u.uid !== uid));
      showToast(t('toast_user_deleted', 'User deleted successfully'));
    },
    err => err.message || t('admin_user_delete_failed', 'Failed to delete the user')
  );
}

/** Whether [u] is the owner of the instance (no admin switch, no deleting). */
export const isOwnerAccount = (u: User | null | undefined) => u?.owner === true || u?.superAdmin === true;
/** Whether the account [u] may be deleted from the table: not the owner, not the own one. */
export const canDeleteAccount = (u: User) => !isOwnerAccount(u) && u.uid !== currentUser()?.uid;

// --- Groups ---
// The name typed into the quick "new group" field above the list
const [newGroupName, setNewGroupName] = createSignal('');
export { newGroupName, setNewGroupName };

export async function submitQuickAddGroup() {
  const name = newGroupName().trim();
  if (!name) return;
  try {
    await apiJson('/admin/groups', 'POST', { name, permissions: [] }, t('admin_group_create_failed', 'Failed to create the group'));
    setNewGroupName('');
    showToast(t('toast_group_created', 'Group created successfully'), 'success');
    await refreshGroupsAndUsers(false);
  } catch (err) {
    showToast(errorMessage(err) || t('admin_group_create_failed', 'Failed to create the group'), 'error');
  }
}
