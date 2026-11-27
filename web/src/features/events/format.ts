// Dates, times, categories and status of events, as the list cards, the calendar and the event page show them
import { userInGroup } from '../../app/groups';
import { intlFormatter, t, uiLang } from '../../app/i18n';
import { currentUid, currentUser, isCurrentUser } from '../../app/session';
import { isMyDuty, type AppEvent } from './store';
import type { Duty } from './types';

const WEEKDAY_SHORT_BY_LANG: Record<string, string[]> = {
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
};
const MONTH_SHORT_BY_LANG: Record<string, string[]> = {
  de: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
};
export const weekdayShort = (index: number) => (WEEKDAY_SHORT_BY_LANG[uiLang()] || WEEKDAY_SHORT_BY_LANG.de)[index] || '';
const monthShort = (index: number) => (MONTH_SHORT_BY_LANG[uiLang()] || MONTH_SHORT_BY_LANG.de)[index] || '';
const splitDate = (dateStr: string) => dateStr.split('-').map(Number);
const localDate = (dateStr: string) => {
  const [y, m, d] = splitDate(dateStr);
  return new Date(y, m - 1, d);
};

/** The parts of a calendar leaf: day number, short weekday, short month. */
export function eventDateParts(dateStr: string | undefined) {
  if (!dateStr) return { dayNum: '--', weekdayStr: '', monthStr: '' };
  const [, m, d] = splitDate(dateStr);
  return { dayNum: String(d), weekdayStr: weekdayShort(localDate(dateStr).getDay()), monthStr: monthShort(m - 1) };
}

/** "17.–19. Okt." / "30. Sep. – 2. Okt." for list cards (the year is in the month header). */
export function formatEventDateSpanShort(startDate: string, endDate: string) {
  const [, m1, d1] = splitDate(startDate);
  const [, m2, d2] = splitDate(endDate);
  if (uiLang() === 'en') return m1 === m2 ? `${d1}–${d2} ${monthShort(m1 - 1)}` : `${d1} ${monthShort(m1 - 1)} – ${d2} ${monthShort(m2 - 1)}`;
  const month = (m: number) => `${monthShort(m - 1)}.`;
  return m1 === m2 ? `${d1}.–${d2}. ${month(m1)}` : `${d1}. ${month(m1)} – ${d2}. ${month(m2)}`;
}

/** "Thursday, 19 November 2026" (duty requests). */
export function formatEventDate(dateStr: string | undefined) {
  if (!dateStr) return '';
  return intlFormatter(Intl.DateTimeFormat, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(localDate(dateStr));
}

/** "Thu, 19 Nov 2026" / "17 – 19 Oct 2026" (the event page, sharing). */
export function formatEventDateSpanCompact(startDate: string | undefined, endDate?: string) {
  if (!startDate) return '--';
  const months = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
  const [y1, m1, d1] = splitDate(startDate);
  const weekday = weekdayShort(localDate(startDate).getDay());
  if (uiLang() === 'en') {
    if (!endDate || endDate === startDate) return `${weekday}, ${d1} ${monthShort(m1 - 1)} ${y1}`;
    const [y2, m2, d2] = splitDate(endDate);
    if (y1 === y2 && m1 === m2) return `${d1} – ${d2} ${monthShort(m1 - 1)} ${y1}`;
    if (y1 === y2) return `${d1} ${monthShort(m1 - 1)} – ${d2} ${monthShort(m2 - 1)} ${y1}`;
    return `${d1} ${monthShort(m1 - 1)} ${y1} – ${d2} ${monthShort(m2 - 1)} ${y2}`;
  }
  if (!endDate || endDate === startDate) return `${weekday}., ${d1}. ${months[m1 - 1]} ${y1}`;
  const [y2, m2, d2] = splitDate(endDate);
  if (y1 === y2 && m1 === m2) return `${d1}. – ${d2}. ${months[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1}. ${months[m1 - 1]} – ${d2}. ${months[m2 - 1]} ${y1}`;
  return `${d1}.${m1}.${y1} – ${d2}.${m2}.${y2}`;
}

/** "19:30 – 21:00" / "from 19:30" ('' without a start time). */
export const eventTimeRange = (ev: Pick<AppEvent, 'startTime' | 'endTime'>) =>
  ev.startTime
    ? ev.endTime
      ? t('events_time_range', '{start} – {end}', { start: ev.startTime, end: ev.endTime })
      : t('events_time_from', 'from {start}', { start: ev.startTime })
    : '';

export const isMultiDay = (ev: Pick<AppEvent, 'date' | 'endDate'>) => Boolean(ev.endDate && ev.endDate !== ev.date);

/** An event (with picture and plan) rather than a plain appointment. */
export const isEventKind = (ev: AppEvent) => (ev.eventType ? ev.eventType === 'event' : !ev.isOfficialTermin);

export type EventCategory = 'pinned' | 'event' | 'termin';
/** Category of a card: pinned highlight, event or plain appointment (colour of stripe, leaf and calendar dot). */
export function eventCategory(ev: AppEvent): EventCategory {
  const isEvent = isEventKind(ev);
  return isEvent && ev.isPinned ? 'pinned' : isEvent ? 'event' : 'termin';
}

/** My duty, my open duty request and my registration on an event (for the status on its cards). */
export function eventStatusInfo(ev: AppEvent) {
  const duties = ev.canAccessDutyPlan && Array.isArray(ev.duties) ? ev.duties : null;
  return {
    myDuty: duties ? duties.find(isMyDuty) : null,
    myRequestedDuty: duties ? duties.find(d => (d.requestedUser === currentUid() || d.requestedUser === currentUser()?.id) && d.status === 'requested') : null,
    isRegistered: ev.myRegistration?.status === 'registered',
    isWaitlist: ev.myRegistration?.status === 'waitlist',
    openDutiesCount: duties ? duties.filter(d => d.status === 'open' || (!d.assignedUser && !d.assignedGroup && !d.requestedUser)).length : 0
  };
}

/** My duty comes through one of my groups (not assigned to me by name). */
export const dutyViaGroup = (duty: Duty) =>
  Boolean(duty.assignedGroup && userInGroup(currentUser(), duty.assignedGroup) && !isCurrentUser(duty.assignedUser));

/** A real place gets a map; online meetings and links do not (like the Android app): "Zoom-Meeting", "https://meet...". */
export const isMapPlace = (location: string) =>
  !!location && !/\b(online|zoom|teams|skype|jitsi|discord)\b|meet\.google|https?:\/\/|^meet$|keine angabe/i.test(location);

export const mapsUrl = (location: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

/** The month of a list day ("2026-11"), or the "no date" group. */
export const monthKey = (day: string | undefined) => (day ? day.substring(0, 7) : t('events_no_date', 'No date'));
