// System settings → Users: the groups on the left (filter, quick add, settings of a group) and the accounts as a table
// (Nextcloud-like). On tablets the groups become a row of chips above the table, on phones a scrolling row.
import { For, Show, createMemo } from 'solid-js';
import { findLinkedPerson, users } from '../../app/data';
import { findGroup, groupList } from '../../app/groups';
import { t } from '../../app/i18n';
import { avatarRing } from '../../app/session';
import { fullName } from '../../app/util';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { SearchInput } from '../../ui/feedback';
import { Input, Select, Switch } from '../../ui/form';
import { Icon } from '../../ui/Icon';
import {
  accountSearch, activeGroup, canDeleteAccount, deleteUserAccount, filterByGroup, groupFilter, isOwnerAccount, newGroupName,
  setAccountSearch, setNewGroupName, shownAccounts, submitQuickAddGroup, toggleUserPays, toggleUserSystemAdmin, updateUserMemberSince
} from './accounts';
import { openAssignGroupModal } from './AssignGroupsDialog';
import { openCreateUserModal } from './CreateUserDialog';
import { openGroupModal } from './GroupDialog';
import { LineIcon } from './parts';
import { openResetPasswordModal } from './ResetPasswordDialog';
import type { User } from '../../app/types';

// --- Groups ---
// Desktop: a list in the sidebar; below 1280px chips (a wrapping row on tablets, a scrolling row on phones)
const GROUP_ITEM =
  'group flex w-full cursor-pointer select-none items-center justify-between rounded-[10px] border px-2.5 py-2 text-left text-[0.88rem] font-semibold ' +
  'transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-150 ease-[ease] ' +
  'max-xl:w-auto max-xl:flex-[0_0_auto] max-xl:gap-1.5 max-xl:rounded-[20px] max-xl:px-3 max-xl:py-[7px] max-md:max-w-[200px]';
const GROUP_ITEM_ACTIVE = 'border-primary bg-surface-alt text-primary shadow-[0_1px_3px_rgba(0,0,0,0.05)] max-md:bg-primary max-md:text-white';
const GROUP_ITEM_IDLE = 'border-transparent bg-transparent text-text hover:bg-surface-alt max-xl:border-border max-xl:bg-surface-alt';

function GroupItem(props: { group?: { id: string; name: string; memberCount?: number }; label: string; icon: string; count: number; active: boolean }) {
  return (
    <div class={[GROUP_ITEM, props.active ? GROUP_ITEM_ACTIVE : GROUP_ITEM_IDLE]} onClick={() => filterByGroup(props.group ? props.group.id : null)}>
      <div class="flex flex-1 items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
        <span>{props.icon}</span>
        <span>{props.label}</span>
      </div>
      <div class="ml-1.5 flex items-center gap-1">
        <span
          class={[
            'rounded-[10px] border px-[7px] py-0.5 text-[0.75rem] font-bold',
            props.active ? 'border-primary bg-primary text-white max-md:border-transparent max-md:bg-white/25' : 'border-border bg-surface-alt text-text-secondary'
          ]}
        >
          {props.count}
        </span>
        <Show when={props.group}>
          {group => (
            <button
              type="button"
              class={[
                'flex items-center rounded-[4px] bg-transparent px-1 py-0.5 text-text-secondary transition-opacity duration-150 ease-[ease] hover:bg-black/6 hover:text-text max-md:p-[3px]',
                props.active ? 'opacity-100 max-md:text-white' : 'opacity-0 group-hover:opacity-100 max-md:opacity-90'
              ]}
              title={t('modal_manage_group_title', 'Manage Group')}
              onClick={e => {
                e.stopPropagation();
                const current = findGroup(group().id);
                if (current) openGroupModal(current);
              }}
            >
              <Icon name="gear" />
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

function GroupsSidebar() {
  const isActive = (g: { id: string; name: string }) => groupFilter() === g.id || groupFilter() === g.name;
  return (
    <div
      class={[
        'flex w-full min-w-0 max-w-full flex-col gap-2.5 rounded-[16px] border border-border bg-surface p-3.5 shadow-card',
        'max-xl:rounded-[14px] max-xl:px-3.5 max-xl:py-3',
        'md:max-xl:flex-row md:max-xl:flex-wrap md:max-xl:items-center md:max-xl:gap-x-3.5 md:max-xl:gap-y-2.5'
      ]}
    >
      <div class="flex items-center justify-between border-b border-border-light pb-2 max-md:pb-1.5 md:max-xl:border-b-0 md:max-xl:pb-0">
        <div class="flex items-center gap-2 text-[0.95rem] font-bold text-text">
          <Icon name="users" size={18} />
          <span>{t('groups_sidebar_title', 'Groups')}</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 md:max-xl:order-3 md:max-xl:flex-[0_1_280px]">
        <Input
          id="nc-new-group-name"
          type="text"
          class="h-[34px] min-w-0 flex-1 rounded-[8px] px-2.5 py-1.5 text-[0.82rem]"
          placeholder={t('group_add_placeholder', 'New group...')}
          value={newGroupName()}
          onInput={e => setNewGroupName(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitQuickAddGroup();
            }
          }}
        />
        <Button
          class="h-[34px] shrink-0 rounded-[8px] px-2.5 py-0"
          title={t('admin_create_group', 'Create group')}
          aria-label={t('admin_create_group', 'Create group')}
          onClick={() => void submitQuickAddGroup()}
        >
          <Icon name="plus" size={15} strokeWidth={2.5} />
        </Button>
      </div>

      <div
        id="nc-groups-list"
        class={[
          'flex max-h-[480px] flex-col gap-1 overflow-y-auto',
          'md:max-xl:order-2 md:max-xl:max-h-none md:max-xl:flex-[1_1_100%] md:max-xl:flex-row md:max-xl:flex-wrap md:max-xl:gap-2 md:max-xl:p-0',
          'max-md:max-h-none max-md:w-full max-md:min-w-0 max-md:max-w-full max-md:flex-row max-md:gap-2 max-md:overflow-x-auto max-md:px-0.5 max-md:pb-2 max-md:pt-0.5'
        ]}
      >
        <GroupItem label={t('group_all_users', 'All Users')} icon="👥" count={users().length} active={groupFilter() === null} />
        <For each={groupList()}>{g => <GroupItem group={g} label={g.name} icon="🏷️" count={g.memberCount !== undefined ? g.memberCount : 0} active={isActive(g)} />}</For>
      </div>
    </div>
  );
}

// --- Accounts ---
const BADGE = 'inline-block rounded-[8px] border border-border bg-surface-alt px-2 py-[3px] text-text-secondary';
const TH =
  'border-b border-border bg-surface-alt px-4 py-3 align-middle text-[0.82rem] font-semibold uppercase tracking-[0.03em] text-text-secondary ' +
  'md:max-xl:px-2.5 md:max-xl:py-2.5 md:max-xl:text-[0.86rem] md:max-xl:first:pl-4 max-md:px-3 max-md:py-2.5 max-md:text-[0.85rem]';
const TD =
  'border-b border-border px-4 py-3 align-middle ' +
  'md:max-xl:px-2.5 md:max-xl:py-2.5 md:max-xl:text-[0.86rem] md:max-xl:first:pl-4 max-md:px-3 max-md:py-2.5 max-md:text-[0.85rem]';
const ICON_BTN =
  'flex items-center justify-center rounded-[8px] border border-border bg-transparent p-1.5 text-text-secondary transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-150 ease-[ease] max-md:min-h-[34px] max-md:min-w-[34px]';

function AccountRow(props: { user: User }) {
  const name = () => fullName(props.user) || t('status_unknown', 'Unknown');
  const owner = () => isOwnerAccount(props.user);
  const memberSince = () => {
    const linked = findLinkedPerson(props.user.uid);
    return props.user.memberSince || linked?.memberSince || linked?.data?.memberSince || '';
  };
  const groups = (): Array<{ id: string; name: string }> => {
    const u = props.user;
    if (Array.isArray(u.groupObjects) && u.groupObjects.length > 0) return u.groupObjects;
    return Array.isArray(u.groups) ? u.groups.map((gid: string) => findGroup(gid) || { id: gid, name: gid }) : [];
  };
  return (
    <tr class="hover:bg-[rgba(0,0,0,0.015)] [&:last-child>td]:border-b-0">
      <td class={TD}>
        <div class="flex items-center gap-3">
          {/* 40px with the role ring (.nc-avatar) */}
          <Avatar uid={props.user.uid} name={name()} size={34} ring={avatarRing(props.user)} initialsClass="text-[0.78rem]" />
          <div class="flex flex-col">
            <div class="flex items-center gap-1.5 font-semibold text-text">
              <span>{name()}</span>
              <Show when={owner()}>
                <span class="flex items-center gap-[3px] rounded-[6px] bg-[rgba(245,158,11,0.15)] px-1.5 py-0.5 text-[0.72rem] font-bold text-[#d97706]">👑 {t('badge_owner', 'Owner')}</span>
              </Show>
              <Show when={props.user.isClaimed === false}>
                <span class="block rounded-[8px] border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.12)] px-1.5 py-0.5 text-[0.72rem] font-semibold text-[#d97706]">
                  ⏳ {t('badge_unclaimed', 'Not Registered')}
                </span>
              </Show>
            </div>
          </div>
        </div>
      </td>
      <td class={[TD, '!text-[0.88rem] text-text-secondary']}>
        <Show when={props.user.email} fallback={<span class="italic opacity-50">{t('accounts_no_login', 'No login credentials')}</span>}>
          {props.user.email}
        </Show>
      </td>
      <td class={[TD, 'cursor-pointer']} title={t('modal_assign_group_title', 'Assign Groups')} onClick={() => openAssignGroupModal(props.user.uid)}>
        <Show when={groups().length > 0} fallback={<span class={[BADGE, 'm-0.5 border-dashed text-[0.78rem] font-semibold opacity-60']}>+ {t('admin_assign_short', 'Assign')}</span>}>
          <For each={groups()}>
            {g => (
              <>
                <span class={[BADGE, 'm-0.5 text-[0.78rem] font-semibold']}>{g.name}</span>{' '}
              </>
            )}
          </For>
        </Show>
      </td>
      <td class={TD}>
        <Input
          type="date"
          class="m-0 h-[30px] w-[130px] rounded-[8px] px-1.5 py-[3px] text-[0.82rem]"
          value={memberSince()}
          onChange={e => void updateUserMemberSince(props.user.uid, e.currentTarget.value)}
        />
      </td>
      <td class={TD}>
        <Select
          class="w-auto cursor-pointer rounded-[8px] border-border bg-surface px-2.5 py-1.5 text-[0.85rem] font-semibold"
          value={props.user.pays !== false ? 'yes' : 'no'}
          onChange={e => void toggleUserPays(props.user.uid, e.currentTarget.value === 'yes')}
        >
          <option value="yes">{t('option_yes', 'Yes')}</option>
          <option value="no">{t('option_no', 'No')}</option>
        </Select>
      </td>
      <td class={TD}>
        {/* A block in the cell: centred in the row like the old switch (its checkbox gave it a text baseline) */}
        <Switch
          class="block"
          checked={!!props.user.admin}
          disabled={owner()}
          aria-label={t('col_system_admin', 'System Admin')}
          onChange={on => void toggleUserSystemAdmin(props.user.uid, on)}
        />
      </td>
      <td class={TD}>
        <div class="flex items-center justify-end gap-1.5">
          <button type="button" class={[ICON_BTN, 'hover:border-text-secondary hover:text-text']} title={t('btn_reset_password', 'Reset Password')} onClick={() => openResetPasswordModal(props.user.uid, name())}>
            <Icon name="lock" size={15} />
          </button>
          <Show when={canDeleteAccount(props.user)}>
            <button
              type="button"
              class={[ICON_BTN, 'hover:border-danger hover:bg-[rgba(239,68,68,0.08)] hover:text-danger']}
              title={t('btn_delete', 'Delete')}
              onClick={() => void deleteUserAccount(props.user.uid)}
            >
              <Icon name="trash" size={15} />
            </button>
          </Show>
        </div>
      </td>
    </tr>
  );
}

function EmptyRow(props: { text: string }) {
  return (
    <tr class="[&:last-child>td]:border-b-0">
      <td colspan="7" class={[TD, '!p-[30px] text-center text-text-secondary']}>
        {props.text}
      </td>
    </tr>
  );
}

export function AccountsPanel() {
  const rows = createMemo(shownAccounts);
  return (
    <div class="grid w-full min-w-0 max-w-full grid-cols-[240px_minmax(0,1fr)] items-start gap-5 max-xl:flex max-xl:flex-col max-xl:gap-3.5">
      <GroupsSidebar />

      <div class="w-full min-w-0 max-w-full overflow-hidden">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3 max-md:w-full max-md:max-w-full max-md:flex-col max-md:items-stretch max-md:gap-2.5">
          <SearchInput
            id="accounts-search"
            class="mb-0 min-w-[200px] max-w-[360px] flex-1 max-md:w-full max-md:max-w-full"
            value={accountSearch()}
            onInput={setAccountSearch}
            placeholder={t('accounts_search_placeholder', 'Search users...')}
          />
          <Button size="small" class="gap-1.5 max-md:min-h-[42px] max-md:w-full" onClick={openCreateUserModal}>
            <LineIcon size={16}>
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </LineIcon>
            <span>{t('btn_create_user', 'New User')}</span>
          </Button>
        </div>

        <Show when={activeGroup()}>
          {group => (
            <div class="mb-3.5 flex items-center justify-between rounded-xl border border-border bg-surface-alt px-3.5 py-2 max-md:w-full max-md:max-w-full max-md:flex-col max-md:items-start max-md:gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[0.85rem] font-medium text-text-secondary">{t('filter_active_group', 'Filtered by group:')}</span>
                <span class={[BADGE, 'text-[0.85rem] font-bold']}>{group().name}</span>
                <span class="text-[0.8rem] text-text-secondary">{t('admin_group_user_count', '({count} users)', { count: rows().length })}</span>
              </div>
              <Button variant="secondary" size="small" class="px-2.5 py-1 text-[0.8rem] max-md:w-full" onClick={() => filterByGroup(null)}>
                {t('btn_clear_group_filter', 'Clear filter')}
              </Button>
            </div>
          )}
        </Show>

        <div class="block w-full min-w-0 max-w-full overflow-x-auto rounded-[16px] border border-border bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.02)] max-md:rounded-[12px]">
          <table class="w-full min-w-[780px] border-collapse text-left text-[0.92rem]">
            <thead>
              <tr>
                <th class={[TH, 'min-w-[170px] text-left']}>{t('col_name_avatar', 'Name')}</th>
                <th class={[TH, 'min-w-[160px] text-left']}>{t('col_email', 'Email')}</th>
                <th class={[TH, 'min-w-[120px] text-left']}>{t('col_groups', 'Group(s)')}</th>
                <th class={[TH, 'min-w-[130px] text-left']}>{t('col_member_since', 'Member since')}</th>
                <th class={[TH, 'min-w-[90px] text-left']}>{t('col_pays', 'Pays')}</th>
                <th class={[TH, 'min-w-[120px] text-left']}>{t('col_system_admin', 'System Admin')}</th>
                <th class={[TH, 'min-w-[90px] text-right']}>{t('col_actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              <Show when={users().length > 0} fallback={<EmptyRow text={t('admin_no_users', 'No users found.')} />}>
                <For each={rows()} keyed={u => u.uid} fallback={<EmptyRow text={t('admin_no_matching_users', 'No matching users found.')} />}>
                  {u => <AccountRow user={u()} />}
                </For>
              </Show>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
