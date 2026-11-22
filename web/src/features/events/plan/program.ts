// One plan per event: the duty roster and the order of service merged. Entries in the order get their time from the
// start and the durations; the tasks without a moment follow as "during the whole event". People are always asked
// through the duty roster, so requests, answers, reminders and the apps keep working. Songs open in the band's key.
import { createSignal } from 'solid-js';
import { apiJson } from '../../../app/api';
import { flushNow } from '../../../app/flush';
import { t } from '../../../app/i18n';
import { isModalOpen } from '../../../app/modals';
import { keySteps } from '../../../lib/songbook';
import { loadSongs, openSong, songbookLoaded, songs } from '../../songbook/api';
import { appEvents, type AppEvent } from '../store';

export type ProgramItem = {
  id: string;
  title?: string;
  who?: string;
  songId?: string;
  songKey?: string;
  minutes?: number | null;
  note?: string;
  [key: string]: any;
};
export type Duty = { id: string; roleName?: string; status?: string; [key: string]: any };

export const PLAN_ENTRY_MODAL = 'plan-entry-modal';

// The loaded order of service and the event it belongs to
const [program, setProgram] = createSignal<{ eventId: string; items: ProgramItem[] }>({ eventId: '', items: [] });
/** The order of service of [eventId] ([] until it is loaded; another event's order never shows). */
export const programItems = (eventId: string | undefined) => (eventId && program().eventId === eventId ? program().items : []);

export function setProgramItems(eventId: string, items: ProgramItem[]) {
  setProgram({ eventId, items });
  flushNow();
}

let programLoad = 0;
/** Loads the order of service of an event (the same event keeps its order until the fresh one is there: no flicker). */
export async function loadProgram(eventId: string): Promise<void> {
  const load = ++programLoad;
  try {
    const data = await apiJson(`/events/${encodeURIComponent(eventId)}/program`);
    if (load !== programLoad) return;
    const items: ProgramItem[] = Array.isArray(data.items) ? data.items : [];
    if (items.some(item => item.songId) && !songbookLoaded()) await loadSongs();
    if (load !== programLoad) return;
    setProgramItems(eventId, items);
  } catch {
    /* the roster stays without the order */
  }
}

// The plan on screen (the event dialog shows it); refreshProgram() reloads its order
let shownPlanEventId = '';
export function setShownPlan(eventId: string) {
  shownPlanEventId = eventId;
}
export function clearShownPlan(eventId: string) {
  if (shownPlanEventId === eventId) shownPlanEventId = '';
}

/** After a change of the events: the open plan shows the saved order again (not while an entry is being edited). */
export async function refreshProgram(): Promise<void> {
  if (!shownPlanEventId || isModalOpen(PLAN_ENTRY_MODAL)) return;
  const ev = appEvents().find(e => e.id === shownPlanEventId);
  if (ev?.canAccessDutyPlan) await loadProgram(ev.id);
}

// --- Times and titles ---
export function addMinutes(hhmm: string, minutes: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The start time of every entry (from the event's start and the durations before it); '' without a start time. */
export function programTimes(items: Array<{ minutes?: number | null }>, start: string | undefined) {
  if (!/^\d{1,2}:\d{2}$/.test(start || '')) return items.map(() => '');
  let offset = 0;
  return items.map(item => {
    const time = addMinutes(start!, offset);
    offset += Number(item.minutes) || 0;
    return time;
  });
}

const programTotal = (items: ProgramItem[]) => items.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
export const programSong = (item: ProgramItem) => (item.songId ? songs().find(song => song.id === item.songId) || null : null);
export const programItemTitle = (item: Partial<ProgramItem>) =>
  item.title || programSong(item as ProgramItem)?.title || (item.songId ? t('program_song_missing', 'Song (no longer in the songbook)') : '');
export const programMinutes = (minutes: number) => t('program_minutes', '{minutes} min', { minutes });

export const sameName = (a: unknown, b: unknown) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
export const roleOf = (duty: Duty) => (duty.roleName || t('duty_task_fallback', 'Task')).trim();
/** The roster task of an item: the one named under "who", else the one with the item's title. */
export const itemTask = (item: ProgramItem, roles: string[]) =>
  roles.find(role => sameName(role, item.who)) || roles.find(role => sameName(role, programItemTitle(item))) || null;

// "2 of 3 filled": confirmed people and assigned groups count as filled
export const filledDuties = (duties: Duty[]) => duties.filter(d => d.status === 'confirmed' || (d.status === 'assigned' && (d.assignedGroup || d.assignedGroupName))).length;
function dutySummary(duties: Duty[]) {
  if (!duties.length) return '';
  const tasks = new Set(duties.map(roleOf)).size;
  return `${t('duty_filled_count', '{filled} of {total} filled', { filled: filledDuties(duties), total: duties.length })} · ${tasks === 1 ? t('duty_task_count_one', '1 task') : t('duty_task_count_many', '{count} tasks', { count: tasks })}`;
}

/** Title and summary of the roster card ("4 of 6 filled · 10:00 – 11:22"). */
export function planHeader(ev: AppEvent, items: ProgramItem[]) {
  const duties: Duty[] = ev.duties || [];
  if (!items.length) return { title: t('events_duty_roster', 'Duty roster'), meta: dutySummary(duties) || t('duty_no_tasks', 'No tasks yet') };
  const total = programTotal(items);
  const start = ev.startTime || '';
  const span = total ? (programTimes(items, start)[0] ? `${start} – ${addMinutes(start, total)}` : programMinutes(total)) : '';
  const count = items.length === 1 ? t('program_count_one', '1 item') : t('program_count_many', '{count} items', { count: items.length });
  const filled = duties.length ? t('duty_filled_count', '{filled} of {total} filled', { filled: filledDuties(duties), total: duties.length }) : '';
  return { title: t('duty_roster_and_program', 'Duty roster & order of service'), meta: [filled, span].filter(Boolean).join(' · ') || count };
}

/** Opens the song of an entry in the key the plan asks for. */
export function openProgramSong(item: ProgramItem) {
  const song = programSong(item);
  if (song) openSong(song.id, { steps: keySteps(song.key, item.songKey) || 0 });
}
