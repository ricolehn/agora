// The dialog that creates a group or changes its name and permissions (and deletes it).
import { For, Show, createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { systemPermissions } from '../../app/groups';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { attempt, confirmAction, showToast } from '../../app/toast';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/form';
import { MODAL_TINTS, Modal, ModalSection } from '../../ui/Modal';
import { filterByGroup, groupFilter, refreshGroupsAndUsers } from './accounts';
import { CheckItem, CheckList, DialogActions } from './parts';

const MODAL_ID = 'manage-group-modal';

// The group being edited ('' for a new one), its name and the permissions ticked
const [groupId, setGroupId] = createSignal('');
const [groupName, setGroupName] = createSignal('');
const [permissions, setPermissions] = createSignal<string[]>([]);

/** Opens the dialog for [group] (null: a new group). */
export function openGroupModal(group: { id: string; name: string; permissions?: string[] } | null) {
  setGroupId(group ? group.id : '');
  setGroupName(group ? group.name : '');
  setPermissions(Array.isArray(group?.permissions) ? [...group.permissions] : []);
  openModal(MODAL_ID);
}

const togglePermission = (id: string, on: boolean) => setPermissions(list => (on ? [...list.filter(p => p !== id), id] : list.filter(p => p !== id)));

async function submitSaveGroup() {
  const id = groupId();
  const name = groupName().trim();
  if (!name) return showToast(t('admin_group_name_required', 'Please enter a group name.'), 'error');
  // In the order of the list, as the boxes are ticked
  const ticked = systemPermissions()
    .map(p => p.id)
    .filter(p => permissions().includes(p));
  await attempt(
    async () => {
      await apiJson(id ? `/admin/groups/${id}` : '/admin/groups', id ? 'PUT' : 'POST', { name, permissions: ticked }, t('admin_group_save_failed', 'Failed to save the group'));
      closeModal(MODAL_ID);
      showToast(id ? t('toast_group_updated', 'Group updated successfully') : t('toast_group_created', 'Group created successfully'), 'success');
      await refreshGroupsAndUsers();
    },
    err => err.message || t('admin_group_save_failed', 'Failed to save the group')
  );
}

async function deleteCurrentGroup() {
  const id = groupId();
  if (!id || !confirmAction(t('confirm_delete_group', 'Are you sure you want to delete this group? It will be removed from all users.'))) return;
  await attempt(
    async () => {
      await apiJson(`/admin/groups/${id}`, 'DELETE', undefined, t('admin_group_delete_failed', 'Failed to delete the group'));
      if (groupFilter() === id) filterByGroup(null);
      closeModal(MODAL_ID);
      showToast(t('toast_group_deleted', 'Group deleted successfully'), 'success');
      await refreshGroupsAndUsers();
    },
    err => err.message || t('admin_group_delete_failed', 'Failed to delete the group')
  );
}

export function GroupDialog() {
  return (
    <Modal
      id={MODAL_ID}
      icon="👥"
      iconClass={MODAL_TINTS.person}
      title={groupId() ? t('modal_manage_group_title', 'Manage Group') : t('modal_create_group_title', 'Create new group')}
      subtitle={t('group_permissions_desc', 'Configure permissions granted to members of this group.')}
      maxWidth="440px"
    >
      <form
        class="flex flex-col gap-2.5"
        onSubmit={e => {
          e.preventDefault();
          void submitSaveGroup();
        }}
      >
        <ModalSection icon="🏷️" title={t('label_group_name', 'Group Name')}>
          <Input
            id="manage-group-name"
            type="text"
            placeholder={t('label_group_name', 'Group Name')}
            required
            autocomplete="off"
            value={groupName()}
            onInput={e => setGroupName(e.currentTarget.value)}
          />
        </ModalSection>
        <ModalSection icon="🛡️" title={t('group_permissions_title', 'Permission Flags')}>
          <CheckList id="manage-group-permissions-list">
            <For each={systemPermissions()} fallback={<div class="text-85 text-text-secondary">{t('admin_no_permissions', 'No permission definitions found.')}</div>}>
              {p => (
                <CheckItem
                  checked={permissions().includes(p.id)}
                  onChange={on => togglePermission(p.id, on)}
                  name={t(`perm_${p.id}`, p.name)}
                  desc={t(`perm_${p.id}_desc`, p.description || '')}
                />
              )}
            </For>
          </CheckList>
        </ModalSection>
        <DialogActions
          left={
            <Show when={groupId()}>
              <Button
                variant="danger"
                size="small"
                class="border border-[rgba(239,68,68,0.3)] !rounded-[10px] !bg-[rgba(239,68,68,0.12)] !px-3.5"
                onClick={() => void deleteCurrentGroup()}
              >
                {t('btn_delete_group', 'Delete Group')}
              </Button>
            </Show>
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
