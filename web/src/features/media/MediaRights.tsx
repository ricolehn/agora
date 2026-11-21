// Folder rights (extended media rights): who may do what in a folder - all members always, other groups and single
// people only when added - and every folder with rights of its own at a glance.
import { For, Show, createSignal, flush, onSettled } from 'solid-js';
import { apiJson } from '../../app/api';
import { loadMediaStatus, mediaStatus } from '../../app/data';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { activeTab } from '../../app/router';
import { attempt, showToast } from '../../app/toast';
import { once } from '../../app/util';
import { Input } from '../../ui/form';
import { Icon, type IconName } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import { addableTargets, removableRow, rightsPayload, rightsRows } from '../../lib/media.js';
import { loadMediaFolder, mediaFolder, openMediaFolder } from './library';
import { SheetFooter } from './SheetFooter';

const RIGHTS_ID = 'media-rights-modal';
const RULES_ID = 'media-rules-modal';

type Level = '' | 'read' | 'write' | 'hide';
interface Choice {
  id: string;
  name: string;
  kind: 'all' | 'group' | 'person';
}
interface RightsRow extends Choice {
  /** The folder's own level ('' = follows what comes from above). */
  level: Level;
  inherited: { level: Exclude<Level, ''>; from: string } | null;
}
interface Rule {
  path: string;
  groups: Record<string, Exclude<Level, ''>>;
}

const TARGET_ICONS: Record<string, IconName> = { all: 'users', group: 'users', person: 'person' };
const levelLabels = (): Record<string, string> => ({
  read: t('media_level_read', 'Read'),
  write: t('media_level_write', 'Write'),
  hide: t('media_level_hide', 'No access')
});
const groupName = (choice: Choice) => (choice.id === '*' ? t('media_all_members', 'All members') : choice.name);
const folderLabel = (path: string) => (path ? `/${path}` : t('media_base_folder', 'Base folder'));

const [rights, setRights] = createSignal<{ path: string; choices: Choice[]; rows: RightsRow[] } | null>(null);
const [adding, setAdding] = createSignal(false);
const [query, setQuery] = createSignal('');
const [saving, setSaving] = createSignal(false);
const [rules, setRules] = createSignal<{ rules: Rule[]; choices: Choice[] } | null>(null);
let list: HTMLDivElement | undefined;

/** The rights of [path] (the open folder by default), for members with extended media rights. */
export async function openMediaRights(path = mediaFolder()) {
  if (!mediaStatus().canManage) return;
  await attempt(
    async () => {
      const data = await apiJson<{ choices: Choice[]; folder: unknown }>(`/media/rules?path=${encodeURIComponent(path)}`);
      setRights({ path, choices: data.choices, rows: rightsRows(data.choices, data.folder) as RightsRow[] });
      setAdding(false);
      flush();
      openModal(RIGHTS_ID);
    },
    err => err?.message || t('media_rights_load_failed', 'The folder rights could not be loaded')
  );
}

function updateRows(change: (rows: RightsRow[]) => RightsRow[]) {
  const current = rights();
  if (current) setRights({ ...current, rows: change(current.rows) });
}

function setLevel(id: string, level: Level) {
  updateRows(rows => rows.map(row => (row.id === id ? { ...row, level } : row)));
}

function removeRow(id: string) {
  updateRows(rows => rows.filter(row => row.id !== id || !removableRow(row)));
}

function addRow(id: string) {
  const current = rights();
  const choice = current?.choices.find(entry => entry.id === id);
  if (!current || !choice || current.rows.some(row => row.id === id)) return;
  // New in the dialog: read, the most common wish; one tap changes it
  updateRows(rows => [...rows, { id: choice.id, name: choice.name, kind: choice.kind, level: 'read', inherited: null }]);
  setAdding(false);
  flush();
  list?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function saveRights() {
  const current = rights();
  if (!current) return;
  const { path, rows } = current;
  await once('media-rights', () =>
    attempt(
      async () => {
        await apiJson('/media/rules', 'PUT', { path, groups: rightsPayload(rows) });
        closeModal(RIGHTS_ID, false, true);
        showToast(t('media_rights_saved', 'Folder rights saved'));
        await Promise.all([loadMediaStatus(), activeTab() === 'media' ? loadMediaFolder({ silent: true }) : null]);
      },
      err => err?.message || t('media_rights_save_failed', 'The folder rights could not be saved'),
      { setBusy: setSaving }
    )
  );
}

/** Every folder with rights of its own; they can be changed from here too (a folder renamed or removed in Nextcloud keeps its rule until then). */
export async function openMediaRulesOverview() {
  if (!mediaStatus().canManage) return;
  await attempt(
    async () => {
      const data = await apiJson<{ choices: Choice[]; rules: Rule[] }>('/media/rules');
      setRules({ rules: data.rules, choices: data.choices });
      flush();
      openModal(RULES_ID);
    },
    err => err?.message || t('media_rights_load_failed', 'The folder rights could not be loaded')
  );
}

// --- The rights of a folder ---
const PILLS = 'flex gap-1 rounded-[14px] border border-border-light bg-surface-alt p-1 [@media(max-width:480px)]:gap-0.5 [@media(max-width:480px)]:p-[3px]';
const PILL =
  'inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-2 text-[0.88rem] font-bold transition-[background-color,color,box-shadow] duration-200 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [@media(max-width:480px)]:px-0.5 [@media(max-width:480px)]:text-[0.78rem] ' +
  '[&>span]:truncate [@media(max-width:480px)]:[&>span]:whitespace-normal [@media(max-width:480px)]:[&>span]:text-center [@media(max-width:480px)]:[&>span]:leading-[1.15] [@media(max-width:480px)]:[&>span]:[overflow-wrap:anywhere]';
const PILL_ACTIVE = 'bg-surface shadow-[0_1px_2px_rgba(28,25,23,0.08),0_4px_12px_-6px_rgba(28,25,23,0.25)] dark:bg-bg';
const ROUND_REMOVE =
  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface-alt hover:text-danger';

function RightsRowView(props: { row: RightsRow }) {
  // Without a rule of its own a row follows: the folder above, else for a person their groups, for a group all
  // members, for all members nothing ("no access" is then already the first choice, not offered twice)
  const from = () =>
    props.row.inherited
      ? t('media_from_above', 'From {folder}: {level}', { folder: folderLabel(props.row.inherited.from), level: levelLabels()[props.row.inherited.level] })
      : '';
  const options = (): Array<[Level, string]> => {
    const follow = from()
      ? t('media_level_inherit', 'As above')
      : props.row.kind === 'person'
        ? t('media_level_groups', 'As their groups')
        : props.row.kind === 'group'
          ? t('media_level_all', 'As all members')
          : t('media_level_none', 'No access');
    const labels = levelLabels();
    const all: Array<[Level, string]> = [['', follow], ['read', labels.read], ['write', labels.write]];
    if (from() || props.row.kind !== 'all' || props.row.level === 'hide') all.push(['hide', labels.hide]);
    return all;
  };
  const name = () => groupName(props.row);
  return (
    <div class="flex flex-col gap-1.5 border-b border-border-light pb-3 last:border-b-0 last:pb-0">
      <div class="flex min-w-0 items-center gap-2.5 text-[0.9rem] font-bold">
        <span class="inline-flex min-w-0 flex-1 items-center gap-2">
          <Icon name={TARGET_ICONS[props.row.kind] || 'users'} size={15} strokeWidth={2.2} class={props.row.kind === 'person' ? 'shrink-0 text-[#2563eb]' : 'shrink-0 text-text-secondary'} />
          <span class="truncate">{name()}</span>
        </span>
        <Show when={from()}>
          <span class="shrink-0 text-right text-[0.76rem] font-medium text-text-secondary">{from()}</span>
        </Show>
        <Show when={removableRow(props.row)}>
          <button
            type="button"
            class={ROUND_REMOVE}
            title={t('btn_remove', 'Remove')}
            aria-label={t('media_rights_remove', 'Remove {name}', { name: name() })}
            onClick={() => removeRow(props.row.id)}
          >
            <Icon name="x" size={15} strokeWidth={2.4} />
          </button>
        </Show>
      </div>
      <div class={PILLS} role="radiogroup" aria-label={name()}>
        <For each={options()} keyed={option => option[0]}>
          {option => (
            <button
              type="button"
              role="radio"
              aria-checked={props.row.level === option()[0] ? 'true' : 'false'}
              class={[
                PILL,
                props.row.level === option()[0]
                  ? [PILL_ACTIVE, option()[0] === 'hide' ? 'text-warning' : 'text-primary']
                  : 'bg-transparent text-text-secondary hover:text-text'
              ]}
              onClick={() => setLevel(props.row.id, option()[0])}
            >
              <span>{option()[1]}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** Adding: a search over the groups and people that are not in the dialog yet. */
function AddPanel() {
  let input: HTMLInputElement | undefined;
  onSettled(() => input?.focus());
  const found = () => {
    const current = rights();
    return current ? (addableTargets(current.choices, current.rows, query()) as Choice[]) : [];
  };
  return (
    <div id="media-rights-add-panel" class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5">
        <Input
          type="search"
          id="media-rights-search"
          class="min-w-0 flex-1"
          autocomplete="off"
          placeholder={t('media_rights_search', 'Search group or person')}
          aria-label={t('media_rights_search', 'Search group or person')}
          ref={el => (input = el)}
          onInput={e => setQuery(e.currentTarget.value)}
        />
        <button type="button" class={ROUND_REMOVE} title={t('btn_cancel', 'Cancel')} aria-label={t('btn_cancel', 'Cancel')} onClick={() => setAdding(false)}>
          <Icon name="x" size={15} strokeWidth={2.4} />
        </button>
      </div>
      <div id="media-rights-results" class="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
        <For
          each={found()}
          fallback={
            <p class="mx-1 my-1.5 text-[0.82rem] text-text-secondary">
              {query().trim() ? t('media_rights_no_match', 'Nobody found') : t('media_rights_all_added', 'All groups and people are listed already')}
            </p>
          }
        >
          {choice => (
            <button
              type="button"
              class="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left text-text hover:bg-surface-alt focus-visible:bg-surface-alt"
              onClick={() => addRow(choice.id)}
            >
              <span
                class={[
                  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-full',
                  choice.kind === 'person' ? 'bg-[rgba(37,99,235,0.1)] text-[#2563eb]' : 'bg-surface-alt text-text-secondary'
                ]}
              >
                <Icon name={TARGET_ICONS[choice.kind] || 'users'} size={15} strokeWidth={2.2} />
              </span>
              <span class="min-w-0 flex-1 truncate text-[0.9rem] font-semibold">{choice.name}</span>
              <span class="shrink-0 text-[0.74rem] text-text-secondary">
                {choice.kind === 'person' ? t('media_kind_person', 'Person') : t('media_kind_group', 'Group')}
              </span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function RightsDialog() {
  return (
    <Modal
      id={RIGHTS_ID}
      title={t('media_rights_title', 'Folder rights')}
      subtitle={<span class="font-mono text-[0.8rem] break-all">{folderLabel(rights()?.path ?? '')}</span>}
      maxWidth="560px"
      bodyClass="gap-3.5"
      footer={<SheetFooter modal={RIGHTS_ID} id="media-rights-save" label={t('btn_save', 'Save')} busy={saving()} onConfirm={() => void saveRights()} />}
    >
      <p class="m-0 mb-3.5 text-[0.82rem] leading-[1.5] text-text-secondary">
        {t(
          'media_rights_hint',
          "A right applies to this folder and every folder in it, until a folder below sets its own. Read: open and download. Write: also upload, create folders and delete. No access: does not see the folder. The most specific right counts: a person's goes before their groups', a group's before the one for all members (someone in several groups gets the most of these). Whoever has no access to the base folder does not see the media library at all. Write also allows deleting (in Nextcloud it goes to the trash bin, if switched on there); a folder only for whoever may write everywhere in it."
        )}
      </p>
      <div id="media-rights-list" ref={el => (list = el)} class="flex flex-col gap-3">
        <For each={rights()?.rows || []} keyed={row => row.id}>
          {row => <RightsRowView row={row()} />}
        </For>
      </div>
      <div class="mt-3.5">
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              id="media-rights-add-btn"
              class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3.5 py-[11px] text-[0.88rem] font-bold text-primary hover:border-primary hover:bg-brand/6"
              onClick={() => {
                setQuery('');
                setAdding(true);
              }}
            >
              <Icon name="plus" size={16} strokeWidth={2.4} />
              <span>{t('media_rights_add', 'Add group or person')}</span>
            </button>
          }
        >
          <AddPanel />
        </Show>
      </div>
    </Modal>
  );
}

// --- All folder rights ---
function RulesDialog() {
  const nameOf = (id: string) => {
    const choice = rules()?.choices.find(entry => entry.id === id);
    return choice ? groupName(choice) : id;
  };
  const openFolder = (path: string) => {
    closeModal(RULES_ID, false, true);
    openMediaFolder(path);
  };
  const editRule = (path: string) => {
    closeModal(RULES_ID, false, true);
    void openMediaRights(path);
  };
  return (
    <Modal id={RULES_ID} title={t('media_rules_overview', 'All folder rights')} maxWidth="460px" bodyClass="gap-3.5">
      <Show
        when={rules()?.rules.length}
        fallback={
          <p class="m-0 mb-3.5 text-[0.82rem] leading-[1.5] text-text-secondary">
            {t('media_rules_none', 'No folder has rights yet: only members with extended media rights see the library. Open a folder and set its rights with the shield.')}
          </p>
        }
      >
        <div id="media-rules-list" class="flex flex-col gap-2">
          <For each={rules()?.rules || []}>
            {rule => (
              <div class="flex w-full flex-col gap-2 rounded-xl border border-border-light bg-surface-alt pt-2.5 pr-2.5 pb-3 pl-3.5 text-text">
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 p-0 text-left text-[0.88rem] font-bold break-all text-[#2563eb] [&:hover>span]:underline"
                    onClick={() => openFolder(rule.path)}
                  >
                    <Icon name="folder" size={15} strokeWidth={2.2} />
                    <span>{folderLabel(rule.path)}</span>
                  </button>
                  <button
                    type="button"
                    class="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-light bg-surface text-text-secondary hover:border-primary hover:text-primary"
                    title={t('media_rights_title', 'Folder rights')}
                    aria-label={t('media_rights_of', 'Rights of {name}', { name: folderLabel(rule.path) })}
                    onClick={() => editRule(rule.path)}
                  >
                    <Icon name="shield" size={15} strokeWidth={2.2} />
                  </button>
                </div>
                <span class="flex flex-wrap gap-1.5">
                  <For each={Object.entries(rule.groups)}>
                    {entry => (
                      <span
                        class={[
                          'rounded-full border border-border-light bg-surface px-[9px] py-[3px] text-[0.74rem] font-semibold',
                          { 'text-primary': entry[1] === 'write', 'text-warning': entry[1] === 'hide' }
                        ]}
                      >
                        {nameOf(entry[0])}: {levelLabels()[entry[1]] || entry[1]}
                      </span>
                    )}
                  </For>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Modal>
  );
}

export function MediaRightsDialogs() {
  return (
    <>
      <RightsDialog />
      <RulesDialog />
    </>
  );
}
