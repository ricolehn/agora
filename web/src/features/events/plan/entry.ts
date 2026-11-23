// One entry of the plan: what (a task, or a song found while typing), who (people and groups picked right in the
// dialog) and when (during the event, or a place in the order of service). Everyone chosen is asked when saving; an
// existing entry also shows its people with "remove".
import { createMemo, createSignal } from 'solid-js';
import { api, apiJson } from '../../../app/api';
import { flushNow } from '../../../app/flush';
import { groupList } from '../../../app/groups';
import { t } from '../../../app/i18n';
import { closeModal, openModal } from '../../../app/modals';
import { confirmAction, showToast } from '../../../app/toast';
import { normalizeSearch } from '../../../lib/songbook';
import { loadSongs, songbookLoaded, songs } from '../../songbook/api';
import { appEvents, hasDutyAssignee, loadEventsData, type AppEvent } from '../store';
import {
  PLAN_ENTRY_MODAL, addMinutes, itemTask, programItemTitle, programItems, programTimes, sameName, setProgramItems, type Duty, type ProgramItem
} from './program';

export const PLAN_DURATIONS = [2, 5, 10, 15, 30];

type AssigneeData = { targetUserId?: string; targetGroupId?: string; sendEmail?: boolean };
export type Assignee = { data: AssigneeData; label: string };
interface PlanEntry {
  /** The event as the dialog was opened with it (the list's fresher copy wins). */
  event: AppEvent;
  mode: 'new' | 'edit';
  /** The name of an existing entry (the dialog's title). */
  heading: string;
  role: string | null;
  itemId: string | null;
  songId: string;
  assignees: Assignee[];
  inProgram: boolean;
  place: number;
  customMinutes: boolean;
  /** The typed text was taken as a task: no more song suggestions for it. */
  taskText: string;
}

const [entry, setEntry] = createSignal<PlanEntry | null>(null);
// The fields' texts
const [name, setName] = createSignal('');
const [minutes, setMinutes] = createSignal('');
const [songKey, setSongKey] = createSignal('');
const [note, setNote] = createSignal('');
const [whoSearch, setWhoSearch] = createSignal('');
const [pickerOpen, setPickerOpen] = createSignal(false);
const [saving, setSaving] = createSignal(false);
export { entry, name, setName, minutes, setMinutes, songKey, setSongKey, note, setNote, whoSearch, setWhoSearch, pickerOpen, saving };

const patch = (fields: Partial<PlanEntry>) => setEntry(current => current && { ...current, ...fields });

export const entryEvent = () => {
  const current = entry();
  return current ? appEvents().find(ev => ev.id === current.event.id) ?? current.event : null;
};
const entryItems = () => programItems(entryEvent()?.id);
const planRoles = (ev: AppEvent) => [...new Set<string>((ev.duties || []).map((d: Duty) => (d.roleName || '').trim()).filter(Boolean))];
/** The people of the edited entry's task. */
export const planDuties = (): Duty[] => {
  const current = entry();
  return (entryEvent()?.duties || []).filter((d: Duty) => current?.role && sameName(d.roleName, current.role) && hasDutyAssignee(d));
};
const assigneeKey = (data: AssigneeData) => (data.targetGroupId ? `g:${data.targetGroupId}` : `u:${data.targetUserId}`);

export function openPlanEntry(ev: AppEvent, request: { mode: 'new' } | { mode: 'edit'; itemId?: string; role?: string }) {
  if (!ev?.canEdit) return;
  const items = programItems(ev.id);
  const role = request.mode === 'edit' ? request.role : undefined;
  const itemId = request.mode === 'edit' ? request.itemId : undefined;
  const item = itemId ? items.find(i => i.id === itemId) : role ? items.find(i => itemTask(i, [role])) : null;
  const index = item ? items.indexOf(item) : -1;
  setEntry({
    event: ev, mode: request.mode, heading: request.mode === 'edit' ? role || (item ? programItemTitle(item) : '') : '',
    role: role || (item ? itemTask(item, planRoles(ev)) : null), itemId: item?.id || null, songId: item?.songId || '', assignees: [],
    inProgram: !!item, place: index > -1 ? index : items.length,
    // Without minutes an entry only sets the order; a duration gives it a time
    customMinutes: !!item?.minutes && !PLAN_DURATIONS.includes(item.minutes), taskText: ''
  });
  setName('');
  setMinutes(item?.minutes ? String(item.minutes) : '');
  setSongKey(item?.songKey || '');
  setNote(item?.note || '');
  setWhoSearch('');
  setPickerOpen(false);
  flushNow();
  if (!songbookLoaded()) void loadSongs();
  void loadEventCandidates();
  openModal(PLAN_ENTRY_MODAL);
}

/** The name the entry gets: the edited one's, else the chosen song or the typed task. */
export function planEntryName() {
  const current = entry();
  if (!current) return '';
  if (current.mode === 'edit') return current.role || programItemTitle(entryItems().find(i => i.id === current.itemId) || {});
  return (current.songId && songs().find(s => s.id === current.songId)?.title) || name().trim();
}

// --- What: a chosen song takes the place of the name field (a new entry can take it back with "x") ---
export const chosenSong = () => {
  const id = entry()?.songId;
  return id ? songs().find(s => s.id === id) || null : null;
};

/** While typing: the matching songs of the songbook (and the typed text as a task of its own). */
export const songSuggestions = createMemo(() => {
  const current = entry();
  const text = name().trim();
  const query = normalizeSearch(text);
  if (!current || !query || current.songId || text === current.taskText) return [];
  return songs().filter(s => normalizeSearch(`${s.title} ${s.artist || ''}`).includes(query)).slice(0, 4);
});

export function choosePlanSong(songId: string) {
  const song = songs().find(s => s.id === songId);
  if (song && !songKey()) setSongKey(song.key || '');
  setName('');
  // Songs are sung at a moment of the event: they go into the order right away
  patch({ songId, inProgram: true });
}

export function clearPlanSong() {
  patch({ songId: '' });
  setSongKey('');
}

export function keepPlanTask() {
  patch({ taskText: name().trim() });
}

// --- Who: people and groups in one list; people get a request, groups are set ---
const [candidates, setCandidates] = createSignal<any[] | null>(null);
const [candidateGroups, setCandidateGroups] = createSignal<any[]>([]);
const [candidatesLoading, setCandidatesLoading] = createSignal(false);
export { candidatesLoading };
let candidatesRequest: Promise<void> | null = null;

function loadEventCandidates(): Promise<void> {
  if (candidates()) return Promise.resolve();
  candidatesRequest ??= (async () => {
    setCandidatesLoading(true);
    try {
      const res = await api('/events/candidates');
      if (res.ok) {
        const data = await res.json();
        setCandidates(Array.isArray(data) ? data : data.candidates || []);
        setCandidateGroups(Array.isArray(data) ? [] : data.groups || []);
      }
    } catch (err) {
      console.warn('Failed to fetch event candidates:', err);
    } finally {
      setCandidatesLoading(false);
      candidatesRequest = null;
    }
  })();
  return candidatesRequest;
}

export interface WhoOption {
  key: string;
  data: AssigneeData;
  label: string;
  sub: string;
  group: boolean;
  /** Already on this entry (asked or assigned, not declined). */
  done: boolean;
  chosen: boolean;
}

/** The people and groups matching the search. */
export const whoOptions = createMemo((): WhoOption[] => {
  const current = entry();
  if (!current) return [];
  const term = normalizeSearch(whoSearch().trim());
  const matches = (...texts: string[]) => !term || texts.some(text => normalizeSearch(text || '').includes(term));
  const taken = new Set(
    (current.mode === 'edit' ? planDuties() : [])
      .filter(d => d.status !== 'declined')
      .map(d => (d.status === 'assigned' && d.assignedGroup ? `g:${d.assignedGroup}` : `u:${d.requestedUser || d.assignedUser}`))
  );
  const chosen = new Set(current.assignees.map(a => assigneeKey(a.data)));
  const people = (candidates() || []).map(c => {
    const label: string = c.name || c.email || t('events_member_fallback', 'Member');
    return { key: `u:${c.id}`, data: { targetUserId: c.id, sendEmail: true }, label, search: [label, term ? c.email : ''], sub: t('plan_who_person', 'Gets a request'), group: false };
  });
  const groups = (candidateGroups().length ? candidateGroups() : groupList()).map(g => {
    const label: string = g.name || g.id;
    return { key: `g:${g.id || g.name}`, data: { targetGroupId: g.id || g.name }, label, search: [label], sub: t('plan_who_group', 'Group · assigned directly'), group: true };
  });
  return [...people, ...groups]
    .filter(o => matches(...o.search))
    .map(({ search: _search, ...o }) => ({ ...o, done: taken.has(o.key), chosen: taken.has(o.key) || chosen.has(o.key) }));
});

/** Opens the list of people and groups right in the dialog (no second pop-up). */
export function pickPlanPerson() {
  setPickerOpen(true);
  void loadEventCandidates();
}

export function togglePlanWho(option: WhoOption) {
  const current = entry();
  if (!current) return;
  const exists = current.assignees.some(a => assigneeKey(a.data) === option.key);
  patch({ assignees: exists ? current.assignees.filter(a => assigneeKey(a.data) !== option.key) : [...current.assignees, { data: option.data, label: option.label }] });
}

export function clearPlanPerson(index: number) {
  const current = entry();
  if (current) patch({ assignees: current.assignees.filter((_, i) => i !== index) });
}

export async function removePlanPerson(dutyId: string) {
  const ev = entryEvent();
  const duty = ev?.duties?.find((d: Duty) => d.id === dutyId);
  if (!ev || !duty || !confirmAction(t('duty_remove_entry_confirm', 'Really remove this entry?'))) return;
  try {
    const res = await api(`/events/duties/${dutyId}`, 'DELETE');
    if (!res.ok) throw new Error(t('duty_remove_error', 'Failed to remove'));
    // The task stays (empty) when its last person goes
    if ((ev.duties || []).filter((d: Duty) => sameName(d.roleName, duty.roleName)).length === 1) await apiJson(`/events/${ev.id}/duties`, 'POST', { roleName: duty.roleName });
    // Fresh data in the list behind the dialog; the dialog stays open
    await loadEventsData();
  } catch (err: any) {
    showToast(err.message, 'error');
  }
}

/** The button says what happens: "Add", "Add & ask Clara", "Save & ask 3 people". */
export function saveLabel() {
  const current = entry();
  if (!current) return '';
  const asked = current.assignees;
  const who = asked.length > 1
    ? t('plan_ask_count', '{count} people', { count: asked.length })
    : asked[0]?.data.targetGroupId ? asked[0].label : String(asked[0]?.label || '').split(/\s+/)[0];
  if (current.mode === 'edit') return asked.length ? t('plan_save_ask', 'Save & ask {who}', { who }) : t('btn_save', 'Save');
  return asked.length ? t('plan_add_ask', 'Add & ask {who}', { who }) : t('plan_add', 'Add');
}

// --- When: during the whole event, or at a place in the order of service ---
export const setPlanWhen = (inProgram: boolean) => patch({ inProgram });
export const setPlanPlace = (place: number) => patch({ place });

/** A duration pill: again on the chosen one takes it back (the entry then only sets the order); "Other" types it. */
export function setPlanMinutes(value: number | 'other') {
  patch({ customMinutes: value === 'other' });
  if (value !== 'other') setMinutes((parseInt(minutes(), 10) || 0) === value ? '' : String(value));
}

/** The order with this entry as a highlighted slot between the others, and the times that follow from the durations
 *  (only when the event has a start time). */
export const planOrder = createMemo(() => {
  const current = entry();
  const ev = entryEvent();
  if (!current || !ev) return null;
  const others = entryItems().filter(i => i.id !== current.itemId);
  const place = Math.min(Math.max(0, current.place), others.length);
  const mins = Math.max(0, parseInt(minutes(), 10) || 0);
  const start = ev.startTime || '';
  const list: Array<{ minutes?: number | null }> = [...others];
  list.splice(place, 0, { minutes: mins });
  const times = programTimes(list, start);
  const timed = /^\d{1,2}:\d{2}$/.test(start);
  return {
    others,
    place,
    minutes: mins,
    when: (i: number) => times[i] || `${i + 1}.`,
    custom: current.customMinutes || (mins > 0 && !PLAN_DURATIONS.includes(mins)),
    hint: !timed
      ? ''
      : mins
        ? t('plan_starts_hint', 'Starts at {time}, until {end}', { time: times[place], end: addMinutes(times[place], mins) })
        : t('plan_order_only', 'Without a duration it only sets the order.')
  };
});

// --- Saving and deleting ---
/** Asks everyone chosen for the task: an open place of it is filled first, then new places are added. */
async function askPlanPeople(ev: AppEvent, roleName: string, assignees: Assignee[]) {
  const open = (ev.duties || []).filter((d: Duty) => sameName(d.roleName, roleName) && d.status === 'open');
  for (const a of assignees) {
    const slot = open.shift();
    await apiJson(
      slot ? `/events/duties/${slot.id}/assign` : `/events/${encodeURIComponent(ev.id)}/duties`,
      'POST',
      slot ? { ...a.data, sendEmail: true } : { roleName, ...a.data, sendEmail: true },
      t('duty_assign_error', 'Failed to assign')
    );
  }
}

async function saveProgram(ev: AppEvent, items: ProgramItem[]) {
  const data = await apiJson(`/events/${encodeURIComponent(ev.id)}/program`, 'PUT', { items }, t('program_save_failed', 'The order of service could not be saved'));
  setProgramItems(ev.id, data.items || items);
}

/** Saves the entry; false when the name is missing (the dialog puts the cursor there). */
export async function savePlanEntry(): Promise<boolean> {
  const current = entry();
  const ev = entryEvent();
  if (!current || !ev) return true;
  const song = current.songId ? songs().find(s => s.id === current.songId) : null;
  const items = entryItems();
  const existingItem = current.itemId ? items.find(i => i.id === current.itemId) : null;
  const entryName = planEntryName();
  if (!entryName) {
    showToast(t('plan_name_missing', 'Please enter a name.'), 'error');
    return false;
  }
  const minutesValue = minutes();
  const fields = {
    minutes: minutesValue === '' ? null : Math.max(0, Math.min(600, parseInt(minutesValue, 10) || 0)),
    note: note().trim(),
    songKey: song || existingItem?.songId ? songKey().trim() : ''
  };
  setSaving(true);
  try {
    const roles = planRoles(ev);
    const roleName = current.role || roles.find(r => sameName(r, entryName)) || entryName;
    const hasTask = roles.some(r => sameName(r, roleName));
    const asking = current.assignees.length > 0;
    // People are asked through the duty roster (requests, reminders, apps)
    if (asking) await askPlanPeople(ev, roleName, current.assignees);
    else if (!hasTask && (!current.inProgram || current.mode === 'edit')) {
      // A task without a moment always stays on the roster (also when it leaves the order)
      await apiJson(`/events/${encodeURIComponent(ev.id)}/duties`, 'POST', { roleName }, t('duty_task_add_error', 'Failed to create the task'));
    }
    let next = items.map(i => ({ ...i }));
    const linked = existingItem || next.find(i => itemTask(i, [roleName]));
    if (current.inProgram) {
      // An item that gets its first people points to their task
      const placed: ProgramItem = linked
        ? { ...linked, ...fields, ...(asking && !itemTask(linked, roles) && !sameName(linked.who, roleName) ? { who: roleName } : {}) }
        : { id: '', title: song ? '' : entryName, who: asking || hasTask || current.mode === 'edit' ? roleName : '', songId: song?.id || '', ...fields };
      next = next.filter(i => i !== linked && i.id !== linked?.id);
      next.splice(Math.min(current.place, next.length), 0, placed);
    } else if (linked) {
      next = next.filter(i => i.id !== linked.id);
    }
    if (JSON.stringify(next) !== JSON.stringify(items)) await saveProgram(ev, next);
    closeModal(PLAN_ENTRY_MODAL, false, true);
    showToast(current.assignees.some(a => a.data.targetUserId) ? t('duty_request_sent', 'Duty request sent!') : t('plan_saved', 'Saved'));
    await loadEventsData();
  } catch (err: any) {
    showToast(err.message, 'error');
  } finally {
    setSaving(false);
  }
  return true;
}

export async function deletePlanEntry() {
  const current = entry();
  const ev = entryEvent();
  if (!current || !ev) return;
  const items = entryItems();
  const item = current.itemId ? items.find(i => i.id === current.itemId) : null;
  const entryName = current.role || programItemTitle(item || {});
  if (!confirmAction(t('plan_delete_confirm', 'Delete “{name}” with everyone asked for it?', { name: entryName }))) return;
  try {
    const duties = (ev.duties || []).filter((d: Duty) => current.role && sameName(d.roleName, current.role));
    await Promise.all(duties.map((d: Duty) => apiJson(`/events/duties/${d.id}`, 'DELETE')));
    const next = items.filter(i => i.id !== item?.id && !(current.role && itemTask(i, [current.role])));
    if (next.length !== items.length) await saveProgram(ev, next);
    closeModal(PLAN_ENTRY_MODAL, false, true);
    showToast(t('plan_deleted', 'Entry deleted'), 'info');
    await loadEventsData();
  } catch (err: any) {
    showToast(err.message, 'error');
  }
}
