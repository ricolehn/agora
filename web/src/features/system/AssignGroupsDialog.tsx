// The dialog that puts an account into groups (and from where a new group can be created).
import { For, createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { setUsers, users } from '../../app/data';
import { findGroup, groupList } from '../../app/groups';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { currentUser } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import { fullName } from '../../app/util';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { MODAL_TINTS, Modal, ModalSection } from '../../ui/Modal';
import { refreshGroupsAndUsers } from './accounts';
import { openGroupModal } from './GroupDialog';
import { CheckItem, CheckList, DialogActions } from './parts';

const MODAL_ID = 'assign-group-modal';

// The account, how the dialog names it, and the groups ticked (ids, or names of older entries)
const [uid, setUid] = createSignal('');
const [userDisplay, setUserDisplay] = createSignal('');
const [ticked, setTicked] = createSignal<string[]>([]);

export function openAssignGroupModal(accountUid: string) {
  const user = users().find(u => u.uid === accountUid);
  if (!user) return;
  setUid(accountUid);
  setUserDisplay(`${fullName(user) || user.email || t('admin_user_fallback', 'User')} (${user.email || t('admin_no_login', 'No login')})`);
  setTicked(Array.isArray(user.groups) ? [...user.groups] : []);
  openModal(MODAL_ID);
}

const isTicked = (group: { id: string; name: string }) => ticked().includes(group.id) || ticked().includes(group.name);
const toggleGroup = (group: { id: string; name: string }, on: boolean) =>
  setTicked(list => {
    const others = list.filter(entry => entry !== group.id && entry !== group.name);
    return on ? [...others, group.id] : others;
  });

async function submitAssignGroups() {
  const accountUid = uid();
  if (!accountUid) return;
  // In the order of the list, by id
  const groups = groupList()
    .filter(isTicked)
    .map(g => g.id);
  await attempt(
    async () => {
      await apiJson(`/admin/users/${accountUid}/groups`, 'PUT', { groups }, t('admin_groups_assign_failed', 'Failed to assign the groups'));
      setUsers(list => list.map(u => (u.uid === accountUid ? { ...u, groups, groupObjects: groups.map(gid => findGroup(gid) || { id: gid, name: gid }) } : u)));
      closeModal(MODAL_ID);
      showToast(t('toast_user_groups_updated', 'User groups updated successfully'), 'success');
      await refreshGroupsAndUsers(currentUser()?.uid === accountUid);
    },
    err => err.message || t('admin_groups_assign_failed', 'Failed to assign the groups')
  );
}

function openCreateGroupFromAssignModal() {
  closeModal(MODAL_ID);
  setTimeout(() => openGroupModal(null), 60);
}

export function AssignGroupsDialog() {
  return (
    <Modal
      id={MODAL_ID}
      icon="🏷️"
      iconClass={MODAL_TINTS.person}
      title={t('modal_assign_group_title', 'Assign Groups')}
      subtitle={userDisplay() || t('admin_select_user', 'Select user')}
      maxWidth="440px"
    >
      <form
        class="flex flex-col gap-2.5"
        onSubmit={e => {
          e.preventDefault();
          void submitAssignGroups();
        }}
      >
        <ModalSection icon="👥" title={t('groups_sidebar_title', 'Groups')}>
          <CheckList id="assign-group-checklist">
            <For each={groupList()} fallback={<div class="py-2.5 text-[0.85rem] text-text-secondary">{t('admin_no_groups', 'No groups yet. Create a group first.')}</div>}>
              {g => (
                <CheckItem
                  checked={isTicked(g)}
                  onChange={on => toggleGroup(g, on)}
                  name={g.name}
                  desc={
                    Array.isArray(g.permissions) && g.permissions.length > 0
                      ? t('admin_group_permission_count', '{count} permissions', { count: g.permissions.length })
                      : t('admin_group_default_access', 'Default access')
                  }
                />
              )}
            </For>
          </CheckList>
        </ModalSection>
        <DialogActions
          left={
            <Button variant="secondary" size="small" class="!gap-1 !text-[0.82rem]" onClick={openCreateGroupFromAssignModal}>
              <Icon name="plus" size={14} />
              <span>{t('admin_new_group', 'New group')}</span>
            </Button>
          }
        >
          <Button variant="secondary" onClick={() => closeModal(MODAL_ID)}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button type="submit">{t('btn_save', 'Save')}</Button>
        </DialogActions>
      </form>
    </Modal>
  );
}
