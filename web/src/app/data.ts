// The community's data the app keeps in memory: members' finance records (people), requests, accounts (users), the
// fee settings, the fees over time, the fresh starts of the fee accounts, the registration code and the media status.
// Signals hold plain data; a change replaces the changed record (lists re-render only what changed).
//
// loadData() loads everything after signing in and on a live update of 'all'. Features add their own loads through
// onDataLoadStart (in parallel, e.g. events, conversations) and onDataLoaded (after the finance data).
import { createSignal, onFlush } from 'solid-js';
import {
  apiGet, apiJson, child, db, equalTo, get, orderByChild, query, ref, runTransaction, set, update, isPreviousServer, auth,
  fetchWithTimeout, API
} from './api';
import { t } from './i18n';
import { setReloadAll } from './live';
import { createMutateCollection } from '../lib/collections';
import { loadPictureVersions } from './pictures';
import { activeTab, applyInitialRoute, isRouteReady, switchTab, takePendingAiRoute } from './router';
import {
  canAccessAi, canManageFinances, canManageRegistrationCode, canViewFinances, currentUid, currentUser, isAuthenticated,
  isOwnerUser, isSuperAdminUser, patchCurrentUser, setAiEnabled
} from './session';
import { hideLoading, showLoading } from './shell';
import { showToast } from './toast';
import { compressImage, convertHeic, fullName, getTodayStr, parseUtcDate, safeList, toFormData } from './util';
import type {
  FeePlan, FeeReset, FeeResetLogEntry, FeeSettings, FinanceRequest, MediaStatus, Payment, Person, PersonRecord, SessionAnswer, StandingOrder,
  StatusEntry, User
} from './types';

export type { FeeSettings, FinanceRequest, Person };

const [people, setPeopleSignal] = createSignal<Person[]>([]);
const [requests, setRequestsSignal] = createSignal<FinanceRequest[]>([]);
const [users, setUsersSignal] = createSignal<User[]>([]);
const [settings, setSettingsSignal] = createSignal<FeeSettings>({ vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0, reportStartDate: null });
// The days all fee accounts were started afresh, for those who see the finances or run the instance; members get the
// day their own account counts from with their record (_feeReset)
const [feeResets, setFeeResets] = createSignal<FeeReset[]>([]);
const [feeResetLog, setFeeResetLog] = createSignal<FeeResetLogEntry[]>([]);
// The monthly fees over time: what a month costs now, the change still to come and all of them (GET /api/fees)
const [feePlan, setFeePlanSignal] = createSignal<FeePlan | null>(null);
const [inviteCode, setInviteCodeSignal] = createSignal('');
const [mediaStatus, setMediaStatus] = createSignal<MediaStatus>({ enabled: false, canManage: false, hasAccess: false });
// The data has been loaded once since signing in (views show their empty states only after that)
const [dataLoaded, setDataLoaded] = createSignal(false);

export { people, requests, users, settings, feeResets, feeResetLog, feePlan, inviteCode, mediaStatus, dataLoaded };

// Like every signal write, a change shows with Solid's next update (the same microtask): code that goes on with the
// new data uses what it wrote, not a read right after. A change of a list goes through the list it changes (setUsers(list
// => ...)): two changes in one go both stay.
export const setPeople = (list: PersonRecord[]) => setPeopleSignal(list.map(preprocessPerson));
export const setRequests = setRequestsSignal;
export const setUsers = setUsersSignal;
export const setSettings = setSettingsSignal;
export const setInviteCode = setInviteCodeSignal;
export function applyFeePlan(data: FeePlan | null) {
  if (data && Array.isArray(data.entries)) setFeePlanSignal(data);
}
export function applyFeeResets(data: { resets?: FeeReset[]; log?: FeeResetLogEntry[] } | null) {
  setFeeResets(safeList(data?.resets));
  setFeeResetLog(safeList(data?.log));
}

// --- People ---
/** The sum of the amounts of a list (payments, a report's transactions; amounts may be text). */
export const sumAmounts = (list: ReadonlyArray<{ amount?: unknown }>) => list.reduce((sum, entry) => sum + parseFloat(String(entry.amount || 0)), 0);

/** A record as the views expect it: lists are lists, totals and the sorted status history are there. */
export function preprocessPerson(person: PersonRecord): Person {
  const memberSince = person.memberSince || getTodayStr();
  const payments = safeList<Payment>(person.payments);
  return {
    ...person,
    memberSince,
    originalMemberSince: person.originalMemberSince || memberSince,
    payments,
    totalPaid: sumAmounts(payments),
    statusHistory: [...safeList<StatusEntry>(person.statusHistory)].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
  };
}

/** The finance record of the account [uid] (in [list]: the one a load is about to show). */
export const findLinkedPerson = (uid: string | undefined, list: Person[] = people()) => list.find(p => p.uid === uid || (p.data && p.data.uid === uid));
export const findPerson = (id: unknown) => people().find(p => String(p.id) === String(id));

/** The own request: by author, or by the own person record (decisions used to overwrite userId with the treasurer's
 *  id) - of the records in [list] (the ones a load is about to show). */
export function isOwnRequest(req: FinanceRequest | null | undefined, list: readonly Pick<Person, 'id' | 'uid'>[] = people()): boolean {
  const uid = currentUid();
  if (!currentUser() || !req) return false;
  if (req.userId === uid) return true;
  return list.some(p => p.uid === uid && String(p.id) === String(req.personId));
}

/**
 * Books all standing-order payments that fell due up to today (weekend dates move to Monday) and drops expired
 * orders. Returns the updated person or null when nothing changed.
 */
export function checkAndExecuteStandingOrders<P extends Pick<Person, 'payments' | 'standingOrders'>>(person: P): P | null {
  if (!Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;
  const payments = [...safeList<Payment>(person.payments)];
  const existingIds = new Set(payments.map(p => p.id));
  const now = new Date();
  const limit = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const isoDay = (d: Date) => d.toISOString().split('T')[0];
  const nextMonth = (date: Date, day: number) => {
    const next = new Date(date);
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
    return next;
  };
  let modified = false;
  const remaining: StandingOrder[] = [];
  for (const so of person.standingOrders) {
    const order = { ...so };
    const day = parseUtcDate(order.startDate).getUTCDate();
    let lastAuto: Date | null = order.lastAutoPayment ? parseUtcDate(order.lastAutoPayment) : null;
    const endDate = order.endDate ? parseUtcDate(order.endDate) : null;
    endDate?.setUTCHours(23, 59, 59, 999);
    let due = lastAuto ? nextMonth(lastAuto, day) : parseUtcDate(order.startDate);
    let booked = false;
    for (let safety = 0; safety < 1200 && !(endDate && due > endDate); safety++) {
      const execution = new Date(due);
      const weekday = execution.getUTCDay();
      if (weekday === 6 || weekday === 0) execution.setUTCDate(execution.getUTCDate() + (weekday === 6 ? 2 : 1));
      if (execution > limit) break;
      const id = `auto_${order.id}_${isoDay(due)}`;
      if (!existingIds.has(id)) {
        payments.push({ id, amount: parseFloat(String(order.amount)), date: isoDay(execution), description: (order.note || 'Dauerauftrag') + ' (Auto)', isAuto: true });
        existingIds.add(id);
        booked = true;
      }
      lastAuto = new Date(due);
      due = nextMonth(due, day);
    }
    if (booked && lastAuto) order.lastAutoPayment = isoDay(lastAuto);
    if (endDate && endDate < limit) {
      modified = true;
    } else {
      remaining.push(order);
      modified ||= booked;
    }
  }
  return modified ? { ...person, payments, standingOrders: remaining } : null;
}

/** Puts a record the server returned in place of the shown one (or removes it when it was deleted). */
export function replacePersonInMemory(record: PersonRecord) {
  const person = preprocessPerson(record);
  setPeopleSignal(list => {
    const idx = list.findIndex(p => String(p.id) === String(person.id));
    if (idx >= 0 && person.isDeleted) return list.filter((_, i) => i !== idx);
    if (idx >= 0) return list.map((p, i) => (i === idx ? person : p));
    return person.isDeleted ? list : [...list, person];
  });
}

/** A fee account as stored, its lists as lists: what a change on the latest server copy works on. */
export type StoredPerson = Omit<PersonRecord, 'payments' | 'statusHistory'> & { payments: Payment[]; statusHistory: StatusEntry[] };

/** Changes a record on the latest server copy (a transaction): writing this screen's copy could drop a payment
 *  someone else booked in the meantime. Resolves to the saved record. */
export async function mutatePerson(personId: string, mutator: (current: StoredPerson) => StoredPerson): Promise<PersonRecord | null> {
  const result = await runTransaction<PersonRecord>(ref(db, 'people/' + personId), current =>
    current ? mutator({ ...current, payments: safeList<Payment>(current.payments), statusHistory: safeList<StatusEntry>(current.statusHistory) }) : current
  );
  const updated = result.snapshot.val();
  if (updated) replacePersonInMemory(updated);
  return updated;
}

/** Donations & expenses are stored as whole lists: see lib/collections.ts (also while the previous server version
 *  serves the instance during a waiting database upgrade). */
export const mutateCollection = createMutateCollection({ db, ref, runTransaction, apiGet, set, isPreviousServer });

/** A copy of [list] with the entry [id] changed by [fields] (null when there is no such entry). */
export function replaceById<T extends { id?: unknown }>(list: T[], id: unknown, fields: Partial<T>): T[] | null {
  const idx = list.findIndex(entry => String(entry.id) === String(id));
  if (idx < 0) return null;
  return list.map((entry, i) => (i === idx ? { ...entry, ...fields } : entry));
}

// --- Receipts ---
/** Uploads a receipt (HEIC converted, large images recompressed) and resolves to the stored file name. */
export async function uploadReceipt(file: File, transactionName: string, transactionDate: string): Promise<string> {
  if (!auth.currentUser) throw new Error('Not authenticated');
  const token = await auth.currentUser.getIdToken();
  let uploadFile = (await convertHeic(file, 0.8)) as File;
  const compressible = uploadFile.type.startsWith('image/') && uploadFile.type !== 'image/gif' && uploadFile.type !== 'image/svg+xml';
  if (compressible && uploadFile.size >= 500 * 1024) {
    try {
      uploadFile = await compressImage(uploadFile, uploadFile.size > 2 * 1024 * 1024 ? 0.65 : 0.75);
    } catch (e) {
      console.error('Compression failed:', e);
    }
  }
  const res = await fetchWithTimeout(`${API}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: toFormData({ name: transactionName, date: transactionDate, receipt: uploadFile })
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.statusText);
  return ((await res.json()) as { filename: string }).filename;
}

/** Uploads several receipts; resolves to the JSON list of their file names (as records store them). */
export async function uploadAll(files: File[], name: string, date: string): Promise<string> {
  const filenames: string[] = [];
  for (const file of files) filenames.push(await uploadReceipt(file, name, date));
  return JSON.stringify(filenames);
}

/** A receipt as an object URL (HEIC shown as JPEG). The caller revokes it when it is no longer shown. */
export async function fetchReceiptImage(filename: string): Promise<string> {
  if (!auth.currentUser) throw new Error('Not authenticated');
  const token = await auth.currentUser.getIdToken();
  const res = await fetchWithTimeout(`${API}/receipts/${encodeURIComponent(filename)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Fetch failed: ' + res.statusText);
  return URL.createObjectURL((await convertHeic(await res.blob(), 0.8, filename)) as Blob);
}

// --- Media status (the Extras hub shows the library only with access) ---
export async function loadMediaStatus() {
  if (!currentUser()) return;
  const status = await apiJson<MediaStatus>('/media/status').catch((): MediaStatus => ({ enabled: false, canManage: false, hasAccess: false }));
  setMediaStatus(status);
  // No (more) access to the base folder: the library is closed, back to Extras
  if (!status.hasAccess && activeTab() === 'media') switchTab('hub');
}

// --- Loading ---
export interface LoadContext {
  /** A background refresh (live update): keep what is shown, no loading screen. */
  silent: boolean;
  /** A full render: also settings inputs, push state and system tools. */
  full: boolean;
}
const startHooks: Array<(ctx: LoadContext) => void> = [];
const loadedHooks: Array<(ctx: LoadContext) => void | Promise<void>> = [];
/** Runs at the start of every load, beside the finance data (events, conversations do not depend on it). */
export function onDataLoadStart(fn: (ctx: LoadContext) => void) {
  startHooks.push(fn);
}
/** Runs after the finance data is loaded (and the address is applied on the first load). */
export function onDataLoaded(fn: (ctx: LoadContext) => void | Promise<void>) {
  loadedHooks.push(fn);
}

export async function refreshCurrentUser() {
  try {
    const data = await apiJson<SessionAnswer>('/auth/me');
    if (data?.user) patchCurrentUser(data.user);
  } catch (err) {
    console.warn('Could not refresh current user info:', err);
  }
}

// Members only see their own person entry and requests; the person is auto-linked by name on first login.
async function loadMemberData() {
  const uid = currentUid()!;
  const user = currentUser()!;
  const peopleRef = ref(db, 'people');
  const byField = (field: string, value: unknown) =>
    get<Record<string, PersonRecord>>(query(peopleRef, orderByChild(field), equalTo(value))).then(snap => snap.val() ?? {});
  // Independent requests run side by side (each round trip costs on mobile data)
  const [sData, ownPeople, rSnap] = await Promise.all([
    apiGet<FeeSettings>('settings').catch(err => (console.warn('Could not fetch settings:', err), null)),
    byField('uid', uid).catch(err => (console.warn('Could not load people:', err), {})),
    // The server only returns the own requests; no userId filter here (decided requests used to carry the treasurer's id)
    get<FinanceRequest[] | Record<string, FinanceRequest>>(ref(db, 'requests')).catch(err => (console.warn('Could not get requests:', err), null))
  ]);
  if (sData) setSettings(sData);
  let peopleList: PersonRecord[] = [];
  try {
    peopleList = safeList(ownPeople);
    // Members created before their account existed: link the person record with the same name once - only the
    // one record of that name no account uses (two are two people: the treasury assigns the account)
    const name = fullName(user) || user.name || '';
    if (peopleList.length === 0 && name) {
      const val = await byField('name', name);
      const unused = Object.keys(val).filter(k => !val[k]?.uid && !val[k]?.isDeleted);
      const key = unused.length === 1 ? unused[0] : null;
      if (key) {
        await update(child(peopleRef, key), { uid }).catch(err => console.warn('Auto-link update failed:', err));
        peopleList = [{ ...val[key], uid }];
      }
    }
  } catch (err) {
    console.warn('Could not load people:', err);
  }
  const shown = peopleList.filter(p => !p.isDeleted);
  setPeople(shown);
  setRequests((rSnap?.exists() ? safeList<FinanceRequest>(rSnap.val()) : []).filter(req => isOwnRequest(req, shown)));
  applyFeeResets(null);
}

async function loadAdminData() {
  const withFinances = canViewFinances();
  const [pData, sData, rData, uData, resetData, feeData] = await Promise.all([
    apiGet<Record<string, PersonRecord>>('people').catch(() => null),
    apiGet<FeeSettings>('settings').catch(() => null),
    withFinances ? apiGet<Record<string, FinanceRequest>>('requests').catch(() => null) : null,
    apiGet<Record<string, Omit<User, 'uid'>>>('users').catch(() => null),
    apiJson<{ resets?: FeeReset[]; log?: FeeResetLogEntry[] }>('/fee-reset').catch(() => null),
    apiJson<FeePlan>('/fees').catch(() => null)
  ]);
  const shown = safeList<PersonRecord>(pData)
    .filter(p => !p.isDeleted)
    .map(preprocessPerson);
  setPeopleSignal(shown);
  setRequests(safeList(rData));
  if (sData) setSettings(sData);
  // A failed request keeps what is shown (like the settings)
  if (resetData) applyFeeResets(resetData);
  applyFeePlan(feeData);
  setUsers(
    Object.entries(uData || {}).map(([uid, data]) => {
      if (!withFinances) return { ...data, uid };
      const linked = findLinkedPerson(uid, shown);
      return {
        ...data,
        uid,
        memberSince: data.memberSince || linked?.memberSince || linked?.data?.memberSince || '',
        status: data.status || linked?.status || linked?.data?.status || ''
      };
    })
  );
}

let lastRefreshErrorAt = 0;

/** Loads everything. silent: a background refresh. freshUser: the sign-in just delivered the account. */
export async function loadData(silent = false, { freshUser = false } = {}) {
  if (!silent) showLoading();
  try {
    if (isAuthenticated() && !freshUser) await refreshCurrentUser();
    const ctx: LoadContext = { silent, full: !silent };
    // Events and conversations do not depend on the finance data: start them right away
    const pictures = isAuthenticated() ? loadPictureVersions() : null;
    if (isAuthenticated()) for (const fn of startHooks) fn(ctx);
    const code = canManageRegistrationCode() ? apiGet('system/inviteCode').catch(() => null) : null;
    if (canViewFinances() || isSuperAdminUser()) await loadAdminData();
    else await loadMemberData();
    // A code that could not be loaded keeps the one shown (a background refresh on a bad connection)
    if (!code) setInviteCode('');
    else {
      const value = await code;
      if (value) setInviteCode(String(value));
    }

    if (canAccessAi()) {
      apiJson<{ enabled?: boolean }>('/admin/ai-status')
        .then(data => {
          setAiEnabled(!!data.enabled);
          // Opened at /ai (a reload in the chat): the chat once the status says it is on - after the update that
          // applies it (the chat's guard reads it)
          if (takePendingAiRoute() && data.enabled) onFlush(() => activeTab() === 'hub' && switchTab('ai-chat'));
        })
        .catch(() => takePendingAiRoute());
    }
    void loadMediaStatus();

    if (!isRouteReady()) void applyInitialRoute();

    await pictures;
    if (canManageFinances()) {
      // Booked on the latest copy of the record (a transaction)
      await Promise.all(
        people()
          .filter(person => checkAndExecuteStandingOrders(person))
          .map(person => mutatePerson(person.id, latest => checkAndExecuteStandingOrders(latest) || latest))
      );
    }
    setDataLoaded(true);
    for (const fn of loadedHooks) await fn(ctx);
  } catch (err) {
    console.error('Loading failed:', err);
    // A background refresh (live update) keeps what is shown and says so quietly - at most once a minute
    if (!silent) showToast(t('alert_error_loading_data', 'Failed to load data. Please reload the page.'), 'error');
    else if (Date.now() - lastRefreshErrorAt > 60000) {
      lastRefreshErrorAt = Date.now();
      showToast(t('toast_refresh_failed', 'Could not refresh - check your connection.'), 'error');
    }
  } finally {
    if (!silent) hideLoading();
  }
}
// A live update of 'all' (app/live.ts) reloads quietly; a plain callback, not a reactive scope
// eslint-disable-next-line solid/reactivity
setReloadAll(() => loadData(true));

/** For the sign-out: nothing of this session stays in memory. */
export function clearData() {
  setPeopleSignal([]);
  setRequestsSignal([]);
  setUsersSignal([]);
  setInviteCodeSignal('');
  setDataLoaded(false);
}

// The owner has the books too (isOwnerUser) - re-exported for views that decide on requests
export { isOwnerUser, set, ref, db };
