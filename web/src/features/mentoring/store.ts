// Mentoring: anonymous, confidential 1:1 support - mentors, conversations, applications and their review.
// State and logic of the area (the previous app.js, function by function); the components read these signals and
// call the actions. The chat pane replaces the list on phones and then has a history entry of its own.
import { createSignal } from 'solid-js';
import { api, apiJson } from '../../app/api';
import { flushNow } from '../../app/flush';
import { programmaticBack } from '../../app/history';
import { t, uiLocale } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { setNavBadge } from '../../app/nav';
import { whenPicturesReady } from '../../app/pictures';
import { HOME_TAB, activeTab, forgetTabHistory, switchTab, syncUrl } from '../../app/router';
import { canManageMentoring, canUseMentoring, currentUid, isCurrentUser } from '../../app/session';
import { confirmAction, showToast } from '../../app/toast';
import { isMobile, once } from '../../app/util';

export interface Thread {
  id: string;
  mentor: string;
  /** The seeker's account (only seekers get it; mentors see the alias). */
  mentee?: string | null;
  status?: string;
  blocked?: boolean;
  blockedByMe?: boolean;
  updated?: string;
  unread_count?: number;
  last_message?: string;
  lastMessage?: { text?: string; created?: string; senderRole?: string } | null;
  myRole?: 'mentor' | 'mentee';
  mentor_name?: string;
  mentee_alias?: string;
}
export interface ChatMessage {
  id: string;
  sender?: string;
  sender_name?: string;
  sender_role?: string;
  text?: string;
  message?: string;
  created?: string;
}
export interface Mentor {
  id: string;
  user?: string;
  user_id?: string;
  name?: string;
  mentorName?: string;
  bio?: string;
  status?: string;
  max_mentees?: number;
  active_mentees?: number;
  activeMentees?: number;
  isFull?: boolean;
  isAccepting?: boolean;
  avatar_url?: string;
  email?: string;
  userEmail?: string;
  created?: string;
}
export interface MentorProfile {
  id?: string;
  status?: string;
  bio?: string;
  max_mentees?: number;
}
export type SubTab = 'chats' | 'find' | 'review';
export type ReviewFilter = 'pending' | 'approved' | 'rejected' | 'all';
export type ReviewState = { state: 'loading' } | { state: 'failed' } | { state: 'empty'; status: ReviewFilter } | { state: 'list'; list: Mentor[] };
/** A message shown while it is on its way to the server. */
export interface SendingMessage {
  key: number;
  text: string;
  time: string;
}

const [subTab, setSubTab] = createSignal<SubTab>('chats');
const [threads, setThreads] = createSignal<Thread[]>([]);
// The list was loaded once (its empty state shows only then)
const [threadsLoaded, setThreadsLoaded] = createSignal(false);
// An opened conversation looks read at once; the counts follow when its messages arrive
const [openedThreads, setOpenedThreads] = createSignal<ReadonlySet<string>>(new Set());
const [activeThreadId, setActiveThreadId] = createSignal<string | null>(null);
// What the chat pane shows: the conversation opened last (it stays there when the chat is left, as before)
const [pane, setPane] = createSignal<{ id: string; fallback: Thread | null } | null>(null);
const [paneMessages, setPaneMessages] = createSignal<{ threadId: string; list: ChatMessage[] | 'denied' } | null>(null);
const [sending, setSending] = createSignal<SendingMessage[]>([]);
// On phones the chat pane replaces the list; opened there, it covers the whole screen
const [inChat, setInChat] = createSignal(false);
const [chatFullscreen, setChatFullscreen] = createSignal(false);
const [menuOpen, setMenuOpen] = createSignal(false);
const [threadSearch, setThreadSearch] = createSignal('');
const [draft, setDraft] = createSignal('');
const [mentors, setMentors] = createSignal<Mentor[]>([]);
const [mentorsState, setMentorsState] = createSignal<'idle' | 'loaded' | 'failed' | 'offline'>('idle');
const [myMentorProfile, setMyMentorProfile] = createSignal<MentorProfile | null>(null);
const [pendingApplications, setPendingApplications] = createSignal(0);
const [reviewFilter, setReviewFilter] = createSignal<ReviewFilter>('pending');
const [review, setReview] = createSignal<ReviewState>({ state: 'loading' });
// The dialogs' forms
const [contactTarget, setContactTarget] = createSignal<{ userId: string; name: string } | null>(null);
const [contactMessage, setContactMessage] = createSignal('');
const [applicationBio, setApplicationBio] = createSignal('');
const [applicationMax, setApplicationMax] = createSignal('3');

export {
  subTab, threads, threadsLoaded, activeThreadId, pane, sending, inChat, chatFullscreen, menuOpen, setMenuOpen, threadSearch,
  setThreadSearch, draft, setDraft, mentorsState, myMentorProfile, pendingApplications, reviewFilter, review, contactTarget,
  contactMessage, setContactMessage, applicationBio, setApplicationBio, applicationMax, setApplicationMax
};

let openingDirectChat = false;
let chatHistoryPushed = false;
let chatReturnHome = false;
// Bumped when the chat is closed, so thread loads still in flight don't reopen it
let chatGeneration = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
// The open conversation's messages as last loaded (a report sends the partner's latest ones)
let activeMessages: ChatMessage[] = [];
let messagesElement: HTMLElement | undefined;
let sendingSeq = 0;

/** The chat pane's scrolling message area (set by the pane). */
export function setMessagesElement(el: HTMLElement) {
  messagesElement = el;
}

const findThread = (id: string | null | undefined) => (id ? threads().find(th => th.id === id) : undefined);

/** Mentors see the anonymous alias of the seeker, seekers see their mentor's name. */
export function threadPartner(thread: Thread | null | undefined) {
  const isMentor = !!thread && isCurrentUser(thread.mentor);
  return {
    isMentor,
    name: isMentor ? thread!.mentee_alias || t('mentoring_partner_anonymous', 'Anonymous Seeker') : thread?.mentor_name || t('mentoring_partner_mentor', 'Mentor'),
    role: isMentor ? t('mentoring_role_seeker', 'Seeker (anonymous)') : t('mentoring_role_mentor', 'Your mentor')
  };
}

/** What a row of the conversation list shows (the filter searches the same texts). */
export function threadRow(thread: Thread) {
  const { isMentor, name, role } = threadPartner(thread);
  const closed = thread.status === 'closed';
  const closedLabel = t('mentoring_sub_closed', 'Conversation ended');
  return {
    isMentor,
    name,
    closed,
    closedLabel,
    pill: closed ? closedLabel : role,
    snippet: thread.last_message || (closed ? closedLabel : t('mentoring_no_messages_yet', 'No messages yet')),
    date: thread.updated ? new Date(thread.updated).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }) : ''
  };
}

export function threadMatches(thread: Thread, text: string) {
  const query = text.toLowerCase().trim();
  if (!query) return true;
  const row = threadRow(thread);
  return [row.name, row.snippet, row.pill].some(value => value.toLowerCase().includes(query));
}

/** Unread as shown in the list: an opened conversation is read right away. */
export const isThreadUnread = (thread: Thread) => (thread.unread_count || 0) > 0 && !openedThreads().has(thread.id);

export const unreadTotal = () => threads().reduce((sum, th) => sum + ((th.unread_count || 0) > 0 ? th.unread_count! : 0), 0);

/** Count badges cap large numbers. */
export const formatBadgeCount = (count: number) => (count > 99 ? '99+' : String(count));

/** The conversation the chat pane shows (its latest state in the list). */
export const paneThread = () => {
  const shown = pane();
  return shown ? findThread(shown.id) ?? shown.fallback : null;
};

/** The messages of the conversation in the pane: null until they are loaded. */
export const paneMessageList = () => {
  const shown = paneMessages();
  return shown && shown.threadId === pane()?.id ? shown.list : null;
};

function applyThreads(list: Thread[]) {
  setThreads(list);
  flushNow();
  // The mentoring entry of both navigations (the sub-tab and the start page follow the list)
  setNavBadge('mentoring', unreadTotal());
}

// The chat pane is on screen: mentoring tab with the "Messages" sub-tab, in a visible browser tab
const isChatVisible = () => activeTab() === 'mentoring' && subTab() === 'chats' && !document.hidden;

/** New message, new chat or changed chat status elsewhere: refresh the list and counts, plus what is on screen. */
export async function refreshMentoringFromRemote() {
  if (!canUseMentoring()) return;
  const openThread = isChatVisible() ? activeThreadId() : null;
  await loadMentoringThreads(false, null, false);
  if (openThread && openThread === activeThreadId()) void loadMentoringMessages(openThread, true);
  if (activeTab() === 'mentoring' && subTab() === 'find') void loadMentorsList();
}

function closeMobileChatPane() {
  setInChat(false);
  setChatFullscreen(false);
}

const SUBTAB_LOADERS: Record<SubTab, () => void> = {
  find: () => void loadMentorsList(),
  chats: () => {
    if (!openingDirectChat && !activeThreadId() && isMobile()) closeMobileChatPane();
    void loadMentoringThreads(false, activeThreadId());
  },
  review: () => void loadMentoringReviewList()
};
const isSubTab = (value: string | undefined): value is SubTab => !!value && Object.hasOwn(SUBTAB_LOADERS, value);

export function switchMentoringSubTab(sub: SubTab) {
  setSubTab(sub);
  flushNow();
  SUBTAB_LOADERS[sub]();
  syncUrl();
}

export async function loadMentoringData() {
  if (!canUseMentoring()) return;
  const isManager = canManageMentoring();
  try {
    const res = await api('/mentoring/my-profile');
    if (res.ok) {
      setMyMentorProfile((await res.json()).mentor || null);
      flushNow();
    }
  } catch (err) {
    console.warn('Failed to load my mentor profile:', err);
  }
  if (isManager) {
    try {
      const res = await api('/mentoring/mentors?status=pending');
      if (res.ok) {
        const list = await res.json();
        setPendingApplications(Array.isArray(list) ? list.length : 0);
      }
    } catch (err) {
      console.warn('Failed to load pending mentors count:', err);
    }
  }
  switchMentoringSubTab(subTab());
}

// --- Mentors ---
export async function loadMentorsList() {
  try {
    const res = await api('/mentoring/mentors?status=approved');
    if (res.ok) {
      const list = await res.json();
      setMentors(Array.isArray(list) ? list : []);
      setMentorsState('loaded');
    } else {
      setMentorsState('failed');
    }
  } catch (err) {
    console.warn('Failed to load mentors:', err);
    setMentorsState('offline');
  }
}

export function mentorCapacity(m: Mentor) {
  const max = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
  const active = typeof m.active_mentees === 'number' ? m.active_mentees : typeof m.activeMentees === 'number' ? m.activeMentees : 0;
  return { max, active, isFull: m.isFull === true || (typeof m.active_mentees === 'number' && active >= max) || m.isAccepting === false };
}

export const isOwnMentorCard = (m: Mentor) => {
  const uid = currentUid();
  return !!uid && (m.user_id === uid || m.user === uid);
};

/** Regular members don't see fully booked mentors (except their own card). */
export const visibleMentors = () => mentors().filter(m => canManageMentoring() || isOwnMentorCard(m) || !mentorCapacity(m).isFull);

/** The member's own conversation with the mentor of a card. */
export function threadWithMentor(m: Mentor) {
  const mentorUserId = m.user || m.user_id || m.id;
  const uid = currentUid();
  return threads().find(th => (th.mentor === mentorUserId || th.mentor === m.user || th.mentor === m.id) && th.mentee === uid);
}

export function openMentorContactModal(userId: string, mentorName: string) {
  const existing = threads().find(th => th.mentor === userId && th.mentee === currentUid());
  if (existing) {
    showToast(
      existing.status === 'closed'
        ? t('mentoring_toast_existing_closed', 'You already have a past conversation with this mentor.')
        : t('mentoring_toast_existing_active', 'You already have an active conversation with this mentor.'),
      'info'
    );
    void openChatDirect(existing.id);
    return;
  }
  setContactTarget({ userId, name: mentorName });
  setContactMessage('');
  openModal('mentor-contact-modal');
}

export const submitMentorContact = () => once('mentor-contact', submitMentorContactNow);
async function submitMentorContactNow() {
  const mentorId = contactTarget()?.userId;
  const message = contactMessage().trim();
  if (!mentorId) return showToast(t('mentor_contact_error_no_mentor', 'No mentor selected.'), 'error');
  if (!message) return showToast(t('mentor_contact_error_no_msg', 'Please enter a first message for the mentor.'), 'error');
  try {
    const res = await api('/mentoring/threads', 'POST', { mentor: mentorId, mentorId, message, initialMessage: message });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.threadId) {
        closeModal('mentor-contact-modal');
        showToast(data.error || t('mentoring_toast_existing_opened', 'Opened the existing conversation.'), 'info');
        void openChatDirect(data.threadId);
        return;
      }
      throw new Error(data.error || data.message || t('mentoring_req_error', 'Failed to send the request.'));
    }
    closeModal('mentor-contact-modal');
    showToast(t('mentoring_toast_req_sent', 'Confidential request sent successfully!'), 'success');
    const threadId = data.threadId || data.thread?.id;
    if (threadId) {
      await loadMentoringThreads(true, threadId);
      void openChatDirect(threadId);
    } else {
      void loadMentoringThreads(true);
    }
  } catch (err: any) {
    showToast(err.message || t('mentoring_req_error', 'Failed to send the request.'), 'error');
  }
}

// --- Conversations ---
export async function loadMentoringThreads(shouldSelect = false, selectThreadId: string | null = null, autoSelect = true) {
  const generation = chatGeneration;
  try {
    const res = await api('/mentoring/threads');
    if (!res.ok) return console.warn('Failed to fetch mentoring threads, status:', res.status);
    const data = await res.json();
    await whenPicturesReady();
    setOpenedThreads(new Set<string>());
    setThreadsLoaded(true);
    applyThreads(Array.isArray(data) ? data : []);
    const list = threads();
    if (list.length === 0 || generation !== chatGeneration) return;
    if (selectThreadId) {
      await openMentoringThread(selectThreadId);
    } else if (shouldSelect || (autoSelect && !isMobile() && !activeThreadId() && isChatVisible())) {
      // Desktop shows list and chat side by side. Only open a chat the user can see: opening marks its
      // messages as read, which used to clear the unread counts right after login
      await openMentoringThread(list[0].id);
    }
  } catch (err) {
    console.warn('Failed to load mentoring threads:', err);
  }
}

export async function openMentoringThread(threadId: string) {
  if (!threadId) return;
  setActiveThreadId(threadId);
  setInChat(true);
  if (isMobile()) {
    setChatFullscreen(true);
    if (!chatHistoryPushed) {
      history.pushState({ view: 'mentoring-chat' }, '');
      chatHistoryPushed = true;
    }
  }
  setOpenedThreads(prev => new Set(prev).add(threadId));
  flushNow();
  syncUrl();

  let thread = findThread(threadId);
  if (!thread) {
    try {
      const res = await api('/mentoring/threads');
      if (res.ok) {
        const data = await res.json();
        applyThreads(Array.isArray(data) ? data : []);
        thread = findThread(threadId);
      }
    } catch (err) {
      console.warn('Failed to reload threads in openMentoringThread:', err);
    }
  }
  setMenuOpen(false);
  setPane({ id: threadId, fallback: thread ?? null });
  flushNow();
  await loadMentoringMessages(threadId);
  // Another chat opened meanwhile (or this one was left): its own run keeps the polling
  if (activeThreadId() !== threadId) return;
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (activeThreadId() === threadId && isChatVisible()) void loadMentoringMessages(threadId, true);
  }, 3500);
}

/**
 * Leaves the open chat. fromHistory: the chat's history entry is already gone (back gesture or tab switch).
 * userBack: the user left the chat (button or gesture), so a chat opened from the start page returns there.
 */
export function closeMentoringChatMobile(fromHistory = false, userBack = !fromHistory) {
  chatGeneration++;
  const hadOpenChat = !!activeThreadId();
  setActiveThreadId(null);
  clearInterval(pollTimer);
  pollTimer = undefined;
  closeMobileChatPane();
  flushNow();
  const returnHome = userBack && chatReturnHome;
  chatReturnHome = false;
  // Pop the chat entry (button) and the tab entry (return home) in one step. The tab entry exists: the chat was
  // opened from the start page, which made it
  const steps = (!fromHistory && chatHistoryPushed ? 1 : 0) + (returnHome ? 1 : 0);
  chatHistoryPushed = false;
  if (steps > 0) programmaticBack(steps);
  syncUrl();
  if (returnHome) {
    // Both entries are gone: the router's "not home" entry too (as the old code reset it)
    forgetTabHistory();
    switchTab(HOME_TAB, 'history');
  }
  // Only a chat that was open changes the unread counts; never pick a new chat while closing
  else if (hadOpenChat) void loadMentoringThreads(false, null, false);
}

/** The back gesture on phones first leaves the open chat (handled before the dialogs). */
export function backFromMobileChat(): boolean {
  if (!inChat() || !isMobile()) return false;
  chatHistoryPushed = false;
  closeMentoringChatMobile(true, true);
  return true;
}

/** Puts messages into the chat pane; a late answer for a conversation that is no longer shown is dropped. */
function showPaneMessages(threadId: string, list: ChatMessage[] | 'denied'): boolean {
  if (pane()?.id !== threadId) return false;
  setPaneMessages({ threadId, list });
  // The area is drawn anew: a message on its way disappears with it (it comes back as sent or into the field)
  setSending([]);
  flushNow();
  return true;
}

async function loadMentoringMessages(threadId: string, isPoll = false) {
  try {
    const res = await api(`/mentoring/threads/${threadId}/messages`);
    if (!res.ok) {
      if (res.status === 403) showPaneMessages(threadId, 'denied');
      return;
    }
    let messages = await res.json();
    if (Array.isArray(messages?.messages)) messages = messages.messages;
    if (!Array.isArray(messages)) return;
    if (threadId === activeThreadId()) activeMessages = messages;
    // Mark the thread as read locally so badges and the home card update instantly
    if ((findThread(threadId)?.unread_count || 0) > 0) {
      applyThreads(threads().map(th => (th.id === threadId ? { ...th, unread_count: 0 } : th)));
    }
    const el = messagesElement;
    const wasAtBottom = !!el && el.scrollHeight - el.scrollTop <= el.clientHeight + 120;
    if (!showPaneMessages(threadId, messages)) return;
    if (el && messages.length && (!isPoll || wasAtBottom)) el.scrollTop = el.scrollHeight;
  } catch (err) {
    console.warn('Failed to load messages:', err);
  }
}

const timeOfDay = (d: Date) => d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });

/** Time of a chat message: "14:05" today, "3 Nov, 14:05" before (only the time made old messages look new). */
export function chatTime(iso: string | undefined) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const time = timeOfDay(d);
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' })}, ${time}`;
}

export async function sendMentoringMessage() {
  const text = draft().trim();
  const threadId = activeThreadId();
  if (!threadId || !text) return;
  // Show the message optimistically until the server round-trip completes
  const pending: SendingMessage = { key: ++sendingSeq, text, time: timeOfDay(new Date()) };
  setSending(list => [...list, pending]);
  setDraft('');
  flushNow();
  if (messagesElement) messagesElement.scrollTop = messagesElement.scrollHeight;
  try {
    await apiJson(`/mentoring/threads/${threadId}/messages`, 'POST', { message: text, text }, t('mentoring_send_error', 'Failed to send'));
    const open = activeThreadId();
    if (open) await loadMentoringMessages(open);
    void loadMentoringThreads(false);
  } catch (err: any) {
    // Like the Android app: the text is not lost - it goes back into the field to try again
    setSending(list => list.filter(entry => entry !== pending));
    if (!draft().trim()) setDraft(text);
    showToast(err.message || t('mentoring_send_failed', 'The message could not be sent.'), 'error');
  }
}

// --- The open chat's menu ---
export function toggleChatMenu(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  setMenuOpen(!menuOpen());
}

// Menu actions on the open chat: close the menu, run with the thread, show errors
async function withActiveThread<A extends unknown[]>(action: (thread: Thread, ...args: A) => unknown, ...args: A) {
  const thread = findThread(activeThreadId());
  if (!thread) return;
  setMenuOpen(false);
  try {
    await action(thread, ...args);
  } catch (err: any) {
    showToast(err.message || t('mentoring_status_error', 'Failed to update.'), 'error');
  }
}

// 'blocked' closes the chat so that only the blocker can reopen it (Google Play UGC policy)
async function setThreadStatus(thread: Thread, status: 'active' | 'closed' | 'blocked', toast: string) {
  await apiJson(`/mentoring/threads/${thread.id}/status`, 'PATCH', { status }, t('mentoring_status_error', 'Failed to update.'));
  const fields = status === 'blocked' ? { status: 'closed', blocked: true, blockedByMe: true } : { status };
  applyThreads(threads().map(th => (th.id === thread.id ? { ...th, ...fields } : th)));
  void openMentoringThread(thread.id);
  void loadMentoringThreads();
  showToast(toast, 'info');
}

/** Reports the conversation to the admins with the partner's recent messages. */
export const reportCurrentThread = () =>
  withActiveThread(async thread => {
    const reason = window.prompt(t('mentoring_report_reason', 'Why are you reporting this conversation? The latest messages of the other person are sent to the administrators.'), '');
    if (reason === null) return;
    const partnerRole = thread.myRole === 'mentor' ? 'mentee' : 'mentor';
    const content =
      activeMessages
        .filter(m => m.sender_role === partnerRole)
        .slice(-10)
        .map(m => m.text)
        .join('\n---\n') || t('mentoring_report_no_messages', '(no messages)');
    await apiJson('/reports', 'POST', { type: 'chat', threadId: thread.id, content, reason }, t('report_failed', 'Report failed.'));
    showToast(t('report_sent', 'Reported – thank you!'), 'info');
  });

async function blockThread(thread: Thread) {
  if (!confirmAction(t('mentoring_confirm_block', 'Block this person? The conversation is closed and only you can reopen it.'))) return;
  await setThreadStatus(thread, 'blocked', t('mentoring_toast_blocked', 'Conversation blocked.'));
}
export const blockCurrentThread = () => withActiveThread(blockThread);

/** Ends the open conversation or opens it again (forcedStatus: that one, else the other of the current). */
async function closeOrReopenThread(thread: Thread, forcedStatus?: 'active' | 'closed') {
  const status = forcedStatus || (thread.status === 'closed' ? 'active' : 'closed');
  const closing = status === 'closed';
  const question = closing
    ? t('mentoring_confirm_close', 'Do you really want to end this conversation? Neither party can send new messages until it is reopened.')
    : t('mentoring_confirm_reopen', 'Do you want to reopen this conversation?');
  if (!confirmAction(question)) return;
  await setThreadStatus(thread, status, closing ? t('mentoring_toast_closed', 'Conversation ended.') : t('mentoring_toast_reopened', 'Conversation reopened.'));
}
export const toggleCloseCurrentThread = (forcedStatus?: 'active' | 'closed') => withActiveThread(closeOrReopenThread, forcedStatus);

// --- Applying as a mentor ---
export function openMentorApplicationModal() {
  const profile = myMentorProfile();
  setApplicationBio(profile ? profile.bio || '' : '');
  setApplicationMax(String(profile ? profile.max_mentees || 3 : 3));
  openModal('mentor-application-modal');
}

export const submitMentorApplication = () => once('mentor-application', submitMentorApplicationNow);
async function submitMentorApplicationNow() {
  const bio = applicationBio().trim();
  const maxMentees = parseInt(applicationMax(), 10);
  if (!bio) return showToast(t('mentor_app_error_no_bio', 'Please enter a short personal introduction.'), 'error');
  const isUpdate = !!myMentorProfile();
  try {
    const data = await apiJson(isUpdate ? '/mentoring/my-profile' : '/mentoring/apply', isUpdate ? 'PUT' : 'POST', { bio, max_mentees: maxMentees }, t('mentor_app_error_generic', 'The application failed.'));
    setMyMentorProfile(data.mentor || myMentorProfile());
    closeModal('mentor-application-modal');
    showToast(
      isUpdate ? t('mentor_app_toast_updated', 'Mentor profile updated!') : t('mentor_app_toast_submitted', 'Application submitted successfully! The leadership will review it.'),
      'success'
    );
    void loadMentoringData();
  } catch (err: any) {
    showToast(err.message || t('mentor_app_error_generic', 'The application failed.'), 'error');
  }
}

// --- Review of the applications (mentoring managers) ---
export async function loadMentoringReviewList() {
  if (!canManageMentoring()) return;
  const status = reviewFilter();
  setReview({ state: 'loading' });
  try {
    const res = await api(`/mentoring/mentors?status=${encodeURIComponent(status)}`);
    if (!res.ok) return setReview({ state: 'failed' });
    const list = await res.json();
    setReview(Array.isArray(list) && list.length ? { state: 'list', list } : { state: 'empty', status });
  } catch (err) {
    console.warn('Failed to load review list:', err);
    // Not "Loading applications..." forever
    setReview({ state: 'failed' });
  }
}

export function changeReviewFilter(filter: ReviewFilter) {
  setReviewFilter(filter);
  flushNow();
  void loadMentoringReviewList();
}

export const setMentorStatus = (mentorId: string, status: 'approved' | 'rejected') => once(`mentor:${mentorId}`, () => setMentorStatusNow(mentorId, status));
async function setMentorStatusNow(mentorId: string, status: 'approved' | 'rejected') {
  const action = status === 'approved' ? t('mentoring_action_approve', 'approve') : t('mentoring_action_reject', 'reject');
  if (!confirmAction(t('mentoring_confirm_status', 'Are you sure you want to {action} this application?', { action }))) return;
  try {
    await apiJson(`/mentoring/manage/${mentorId}/status`, 'POST', { status }, t('mentoring_status_error', 'Failed to update.'));
    showToast(status === 'approved' ? t('mentoring_toast_approved', 'Application approved successfully!') : t('mentoring_toast_rejected', 'Application rejected successfully!'), 'success');
    void loadMentoringReviewList();
    void loadMentoringData();
  } catch (err: any) {
    showToast(err.message || t('mentoring_status_error', 'Failed to update.'), 'error');
  }
}

// --- Entry points: the tab, its address, a conversation opened from elsewhere ---
export async function openChatDirect(threadId: string, source?: string) {
  openingDirectChat = true;
  // Opened from the start page: going back from the chat leads there again (like the Android app)
  chatReturnHome = source === 'home' && isMobile();
  setSubTab('chats');
  flushNow();
  switchTab('mentoring');
  switchMentoringSubTab('chats');
  await loadMentoringThreads(true, threadId || null);
  // Keep the flag long enough for tab transitions and pending loads
  setTimeout(() => {
    openingDirectChat = false;
  }, 400);
}

/** The tab opens: back to the messages (unless a conversation is opened directly), then its data. */
export function enterMentoringTab() {
  if (!openingDirectChat) {
    setSubTab('chats');
    flushNow();
  }
  void loadMentoringData();
}

/** Another tab replaces this one: the open chat closes (its history entry is left behind with the tab). */
export function leaveMentoringTab() {
  chatReturnHome = false;
  closeMentoringChatMobile(true);
}

/** The tab's part of the address: the open chat, else the sub-tab ('' for the messages). */
export function mentoringSubPath() {
  const id = activeThreadId();
  if (id) return `chat/${encodeURIComponent(id)}`;
  return subTab() !== 'chats' ? subTab() : '';
}

/** /mentoring/<sub-tab> and /mentoring/chat/<thread id> */
export function openMentoringRoute([sub, extra]: string[]) {
  if (sub === 'chat' && extra) void openChatDirect(extra);
  else if (isSubTab(sub) && (sub !== 'review' || canManageMentoring())) switchMentoringSubTab(sub);
}
