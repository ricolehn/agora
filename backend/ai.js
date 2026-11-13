const { getStateValue, upsertStateValue, listPeopleRecords, listExpenseRecords, listUserRecords, listRequestRecords, isDeletedPerson, getFeeState } = require('./pocketbase');
const { toDateStr } = require('./utils/date');
const { buildEventContext } = require('./eventContext');
const { describeFeeResets } = require('./feeReset');
const { describeFeeSchedule } = require('./feeSchedule');

const AI_STATE_KEY = 'ai_config';

const AI_CONFIG_DEFAULTS = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini'
};

async function getAiSettings(appConfig) {
  return getStateValue(appConfig, AI_STATE_KEY, AI_CONFIG_DEFAULTS);
}

/**
 * Persists AI settings to the app_state collection.
 * Pass `apiKey: '***'` as a sentinel to keep the existing key unchanged.
 */
async function setAiSettings(appConfig, patch) {
  const current = await getAiSettings(appConfig);
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : current.baseUrl,
    // A sentinel value of '***' means "keep the existing key"
    apiKey: typeof patch.apiKey === 'string' && patch.apiKey !== '***'
      ? patch.apiKey
      : current.apiKey,
    model: typeof patch.model === 'string' ? patch.model.trim() : current.model
  };
  await upsertStateValue(appConfig, AI_STATE_KEY, next);
  return next;
}

const roundEur = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * The member's fee account as the server works it out (derivedData.js) - the numbers the apps show. The AI used to
 * add up months and payments itself, which is wrong once the fee accounts were started afresh (feeReset.js): open
 * fees from before that day were dropped, credit was carried over, and the time before keeps its own monthly fees.
 * null for members who pay no fees.
 */
function feeAccountOf(data) {
  if (!data || data.pays === false) return null;
  return {
    countsFrom: data._feeReset || data.originalMemberSince || data.memberSince || '',
    startedAfreshOn: data._feeReset || null,
    creditCarriedOverEur: data._feeReset ? roundEur(data._feeCarriedOver) : 0,
    openFeesDroppedEur: data._feeReset ? roundEur(data._feeWrittenOff) : 0,
    paidUpToMonth: data._paidUntil ? toDateStr(new Date(data._paidUntil)).slice(0, 7) : null,
    balanceEur: roundEur(data._currentBalance),
    overdueEur: roundEur(data._overdueAmount),
    isOverdue: data._statusMeta?.isOverdue === true
  };
}

// How much of each history the AI gets: after some years the whole books would not fit into a question. The numbers
// the server works out (totalPaid, feeAccount, the totals) always count everything.
const RECENT_PER_MEMBER = 6;
const RECENT_ENTRIES = 50;
const MONTHS_IN_DETAIL = 36;

/** Money per month (the last MONTHS_IN_DETAIL, up to this month) and per year, in EUR, from finance_monthly_totals. */
async function moneyOverTime(appConfig, todayStr) {
  try {
    const rows = await require('./db/client').listAllRecords('finance_monthly_totals', '', appConfig, 'month');
    const thisMonth = todayStr.slice(0, 7);
    const eur = (cents) => Math.round(cents) / 100;
    const kinds = { memberPayment: 'memberPaymentsEur', donation: 'donationsEur', expense: 'expensesEur' };
    const months = new Map();
    const years = new Map();
    for (const row of rows.filter((entry) => entry.month <= thisMonth)) {
      const key = kinds[row.kind];
      if (!key) continue;
      const month = months.get(row.month) || { month: row.month, memberPaymentsEur: 0, donationsEur: 0, expensesEur: 0 };
      month[key] = eur(Math.round(month[key] * 100) + row.totalCents);
      months.set(row.month, month);
      const yearKey = row.month.slice(0, 4);
      const year = years.get(yearKey) || { year: yearKey, memberPaymentsEur: 0, donationsEur: 0, expensesEur: 0 };
      year[key] = eur(Math.round(year[key] * 100) + row.totalCents);
      years.set(yearKey, year);
    }
    return { monthlyTotals: [...months.values()].slice(-MONTHS_IN_DETAIL), yearlyTotals: [...years.values()] };
  } catch (err) {
    console.error('ai.js: totals over time:', err.message);
    return {};
  }
}

/**
 * Builds the database context for the AI system prompt: everything a question about the community needs, in a size
 * that stays the same after years - the server's own numbers in full, the histories by their newest entries and totals.
 */
async function buildDatabaseSnapshot(appConfig, options = {}) {
  try {
    const canViewFinances = options.canViewFinances === true;

    const [allPeople, expenses, users, requests, donations, fees] = await Promise.all([
      listPeopleRecords(appConfig).catch(() => []),
      canViewFinances ? listExpenseRecords(appConfig).catch(() => []) : Promise.resolve([]),
      listUserRecords(appConfig).catch(() => []),
      listRequestRecords(appConfig).catch(() => []),
      canViewFinances ? getStateValue(appConfig, 'donations', {}).catch(() => ({})) : Promise.resolve({}),
      canViewFinances ? getFeeState(appConfig).catch(() => null) : Promise.resolve(null)
    ]);

    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = String(today.getMonth() + 1).padStart(2, '0');
    const todayD = String(today.getDate()).padStart(2, '0');
    const todayStr = `${todayY}-${todayM}-${todayD}`;

    // Deleted people are no members any more (they used to show up as overdue): only their payments stay in the books
    const people = allPeople.filter((p) => !isDeletedPerson(p));
    const deletedPeople = allPeople.filter(isDeletedPerson);

    // Aggregate summary statistics
    const membersByStatus = {};
    let totalPaidAcrossMembers = 0;
    for (const p of allPeople) {
      if (!isDeletedPerson(p)) {
        const status = p.status || 'unknown';
        membersByStatus[status] = (membersByStatus[status] || 0) + 1;
      }

      if (canViewFinances) {
        const payments = Array.isArray(p.data?.payments) ? p.data.payments : [];
        for (const pay of payments) {
          const payDateStr = toDateStr(pay.date);
          if (payDateStr <= todayStr) {
            totalPaidAcrossMembers += Number(String(pay.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
          }
        }
      }
    }

    let totalExpenses = 0;
    if (canViewFinances) {
      for (const e of expenses) {
        const eDateStr = toDateStr(e.date);
        if (eDateStr <= todayStr) {
          totalExpenses += Number(String(e.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
        }
      }
    }

    let totalDonations = 0;
    if (canViewFinances) {
      for (const d of Object.values(donations || {})) {
        const dDateStr = toDateStr(d.date);
        if (dDateStr <= todayStr) {
          totalDonations += Number(String(d.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
        }
      }
    }

    // Build member records: strip financial details if !canViewFinances
    const memberRecords = people.map((p) => {
      // Without finance rights only the name: the income status is finance data (/api/db hides it too)
      if (!canViewFinances) {
        return { id: p.personKey, name: p.name || '' };
      }
      const payments = Array.isArray(p.data?.payments) ? p.data.payments : [];
      const byDate = [...payments].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return {
        id: p.personKey,
        name: p.name || '',
        status: p.status || '',
        memberSince: p.memberSince || '',
        originalMemberSince: p.originalMemberSince || p.memberSince || '',
        totalPaid: Math.round(Number(String(p.totalPaid || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
        feeAccount: feeAccountOf(p.data),
        // The whole history would not fit into a question after some years: the newest payments, the count and the
        // first day (totalPaid, feeAccount and monthlyTotals count all of them)
        paymentCount: payments.length,
        firstPaymentDate: byDate.length ? byDate[byDate.length - 1].date || '' : '',
        recentPayments: byDate.slice(0, RECENT_PER_MEMBER).map((pay) => ({
          amount: Math.round(Number(String(pay.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
          date: pay.date || '',
          description: pay.description || ''
        })),
        standingOrders: (Array.isArray(p.data?.standingOrders) ? p.data.standingOrders : []).map((so) => ({
          id: so.id || '',
          amount: Math.round(Number(String(so.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
          startDate: so.startDate || '',
          endDate: so.endDate || '',
          note: so.note || '',
          lastAutoPayment: so.lastAutoPayment || ''
        })),
        statusHistory: (Array.isArray(p.data?.statusHistory) ? p.data.statusHistory : []).map(h => ({
          status: h.status || '',
          startDate: h.startDate || '',
          endDate: h.endDate || ''
        }))
      };
    });

    // Booked payments of deleted people: part of the books, but not of the member list (the newest)
    const newestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
    const deletedPeoplePayments = canViewFinances ? deletedPeople.flatMap((p) => (Array.isArray(p.data?.payments) ? p.data.payments : [])
      .map((pay) => ({
        name: p.name || '',
        amount: Math.round(Number(String(pay.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
        date: pay.date || '',
        description: pay.description || ''
      }))).sort(newestFirst).slice(0, RECENT_ENTRIES) : [];

    // Build expense records (empty if not authorized): the newest (the totals count all of them)
    const expenseRecords = canViewFinances ? expenses.map((e) => ({
      id: e.expenseKey,
      amount: Math.round(Number(String(e.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
      date: e.date || '',
      issuer: e.issuer || '',
      description: e.description || ''
    })).sort(newestFirst).slice(0, RECENT_ENTRIES) : [];

    // Filter requests: the open ones and the newest decided ones
    const requestRecords = requests
      .filter((r) => canViewFinances || (options.user && String(r.userId) === String(options.user.uid)))
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
      .filter((r, index, list) => r.status === 'pending' || list.slice(0, index).filter((other) => other.status !== 'pending').length < RECENT_ENTRIES)
      .map((r) => ({
        id: r.requestKey,
        type: r.type || '',
        personName: r.personName || '',
        status: r.status || '',
        timestamp: r.timestamp || null,
        data: canViewFinances ? (r.data || {}) : {}
      }));

    // Include user records (strip password, token, etc)
    const userRecords = users.map((u) => ({
        id: u.id,
        name: u.name || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        // E-mail addresses only for those who may see the member data anyway
        ...(canViewFinances ? { email: u.email || '' } : {}),
        admin: u.admin === true,
        owner: u.owner === true || u.superAdmin === true,
        superAdmin: u.owner === true || u.superAdmin === true,
        pays: u.pays !== false,
        groups: Array.isArray(u.groups) ? u.groups : []
    }));

    const summary = {
      totalMembers: people.length,
      membersByStatus,
      totalUsers: users.length,
      adminCount: users.filter((u) => u.admin === true).length
    };

    if (canViewFinances) {
      summary.totalMemberPaymentsEur = Math.round(totalPaidAcrossMembers * 100) / 100;
      summary.totalExpensesEur = Math.round(totalExpenses * 100) / 100;
      summary.estimatedBalanceEur = Math.round((totalPaidAcrossMembers + totalDonations - totalExpenses) * 100) / 100;
    }

    const snapshot = {
      today: todayStr,
      summary,
      members: memberRecords,
      users: userRecords,
      // What the asking person sees in the calendar (duty roster and order of service only where they may)
      events: await buildEventContext(appConfig, options.user).catch((err) => {
        console.error('ai.js: event context error:', err);
        return [];
      })
    };

    if (canViewFinances) {
      // The monthly fees of this month, and the fees over time: those from the beginning (from: null) and every
      // change with the month it counts from (state: current = counts this month, planned = still to come)
      const feesOverTime = fees ? describeFeeSchedule(fees.schedule, todayStr) : null;
      const rates = feesOverTime ? feesOverTime.current : {};
      snapshot.contributionRates = {
        vollverdiener: rates.vollverdiener ?? null,
        geringverdiener: rates.geringverdiener ?? null,
        keinverdiener: rates.keinverdiener ?? null,
        pausiert: rates.pausiert ?? null
      };
      snapshot.contributionRatesOverTime = feesOverTime ? feesOverTime.entries : [];
      // The days all fee accounts were started afresh (state: active = counted from, scheduled = still to come)
      snapshot.feeResets = describeFeeResets(fees ? fees.resets : [], todayStr);
      snapshot.expenses = expenseRecords;
      snapshot.expenseCount = expenses.length;
      snapshot.paymentsOfDeletedMembers = deletedPeoplePayments;
      const donationList = Object.values(donations || {}).filter((d) => d && typeof d === 'object');
      snapshot.donations = donationList.map((d) => ({
        amount: Math.round(Number(String(d.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
        name: d.name || '',
        date: d.date || '',
        description: d.description || ''
      })).sort(newestFirst).slice(0, RECENT_ENTRIES);
      snapshot.donationCount = donationList.length;
      snapshot.requests = requestRecords;
      // Money per month (the last three years) and per year, as the database sums it up
      Object.assign(snapshot, await moneyOverTime(appConfig, todayStr));
    } else if (requestRecords.length > 0) {
      snapshot.myRequests = requestRecords;
    }

    // Compact JSON: indentation would be a quarter of the tokens
    return JSON.stringify(snapshot);
  } catch (err) {
    console.error('ai.js: buildDatabaseSnapshot error:', err);
    return '{"error":"Could not build database snapshot"}';
  }
}

/**
 * Sanitizes and normalizes user input text before sending to AI providers.
 * - Normalizes Unicode (NFC)
 * - Removes lone/unpaired UTF-16 surrogates to prevent UTF-8 encoding/JSON errors
 * - Strips null bytes and unprintable control characters (preserving \n, \r, \t)
 * - Normalizes CRLF to LF
 */
function sanitizeAiText(input) {
  if (typeof input !== 'string') {
    input = String(input || '');
  }

  try {
    input = input.normalize('NFC');
  } catch { /* ignore */ }

  // Remove null bytes and unprintable ASCII / C0/C1 control characters except \t, \n, \r
  input = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  if (typeof input.toWellFormed === 'function') {
    input = input.toWellFormed();
  } else {
    input = input.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }

  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Validates, sanitizes and trims chat history payload for AI providers.
 */
function sanitizeAiMessages(rawMessages, maxMessages = 50, maxCharPerMsg = 12000) {
  if (!Array.isArray(rawMessages)) return [];

  const sanitized = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'user' ? 'user' : null);
    if (!role) continue;

    let content = sanitizeAiText(msg.content).trim();
    if (!content) continue; // Skip empty messages to prevent provider 400 errors

    if (content.length > maxCharPerMsg) {
      content = content.slice(0, maxCharPerMsg);
    }

    sanitized.push({ role, content });
  }

  return sanitized.slice(-maxMessages);
}

/**
 * Builds the system prompt injected at the start of every chat request.
 * @param {string} appName - The configured application name.
 * @param {string} dbSnapshot - JSON string from buildDatabaseSnapshot.
 */
function buildSystemPrompt(appName, dbSnapshot, options = {}) {
  const canViewFinances = options.canViewFinances === true;
  if (!canViewFinances) {
    return `You are a helpful support assistant for the ${appName || 'Agora'} application. Answer questions about the community, member directory, events and general app usage. Be concise and helpful. Events: the "events" list holds the appointments and events this person can see (two weeks back to a year ahead) with time, place, organizer, description, registration state, their own duty and - where they may see it - the duty roster and order of service. Dates are YYYY-MM-DD, "today" is the current date; answer with readable dates.
IMPORTANT: You do not possess, receive, or have access to any financial data, contribution rates, payments, expenses, donations, or account balances in your database context. All financial records are completely excluded from your view. You cannot view or provide any financial information. If the user asks about finances, explain politely that you do not have access to any financial data and that viewing finances requires financial management permissions.\n\nCurrent database context:\n${dbSnapshot}`;
  }
  return `You are a helpful support assistant for the ${appName || 'Agora'} management application. Answer questions about the application data, members, finances, events and settings. Be concise and helpful. Events: the "events" list holds the appointments and events this person can see (two weeks back to a year ahead) with time, place, organizer, description, registration state, their own duty and - where they may see it - the duty roster and order of service. Dates are YYYY-MM-DD, "today" is the current date; answer with readable dates. Deleted members are not in "members" and owe nothing: only their booked payments stay, in "paymentsOfDeletedMembers". Fees: each member's "feeAccount" is the application's own calculation - take who is overdue (isOverdue), the open amount (overdueEur), the balance (balanceEur, negative means owed) and the last fully paid month (paidUpToMonth) from it instead of adding up months and payments yourself; it is null for members who pay no fees. "feeResets" lists the days on which all fee accounts were started afresh (state "active": counted from; "scheduled": still to come). On such a day the account of every member who had joined before it was settled: whoever was behind starts from zero (openFeesDroppedEur was dropped and is no longer owed), whoever had paid ahead keeps that credit (creditCarriedOverEur), and since that day ("startedAfreshOn"; "countsFrom" is where the account counts from) the months are owed and the payments credited anew. Every month costs the fees of its time: "contributionRates" are the monthly fees of the current month, "contributionRatesOverTime" lists the fees from the beginning ("from": null) and every change with the month it counts from ("from": YYYY-MM; state "current": counts this month, "planned": still to come, "past": replaced by a later change) - the months before a change keep the fees before it. All payments stay in the books, in "totalPaid" and the cash balance; "memberSince" never changes. Histories are shortened to stay readable after years: per member the newest payments ("recentPayments", "paymentCount" in total, "firstPaymentDate"), the newest expenses, donations and requests (with "expenseCount" and "donationCount"); "monthlyTotals" (the last three years) and "yearlyTotals" sum up all money in EUR per month and year (memberPaymentsEur, donationsEur, expensesEur). Say so when a question needs older single entries than the context holds.\n\nCurrent database context:\n${dbSnapshot}`;
}

/**
 * Turns one parsed chunk of an OpenAI-compatible stream into the events Agora sends on: { content }, { reasoning }
 * and { error }. Providers name the thought process differently: reasoning_content (DeepSeek, vLLM, LM Studio),
 * reasoning (OpenRouter, Ollama, newer vLLM), reasoning_details (OpenRouter), thinking (some local servers).
 */
function aiStreamEvents(chunk) {
  const events = [];
  if (!chunk || typeof chunk !== 'object') return events;
  if (chunk.error) {
    const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
    events.push({ error: String(message || 'AI provider error').slice(0, 300) });
    return events;
  }
  const delta = chunk.choices?.[0]?.delta || chunk.choices?.[0]?.message || {};
  let reasoning = '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof delta[key] === 'string') {
      reasoning = delta[key];
      break;
    }
  }
  if (!reasoning && Array.isArray(delta.reasoning_details)) {
    reasoning = delta.reasoning_details
      .map(detail => (typeof detail?.text === 'string' ? detail.text : typeof detail?.summary === 'string' ? detail.summary : ''))
      .join('');
  }
  if (reasoning) events.push({ reasoning });
  if (typeof delta.content === 'string' && delta.content) events.push({ content: delta.content });
  return events;
}

module.exports = {
  aiStreamEvents,
  getAiSettings,
  setAiSettings,
  buildDatabaseSnapshot,
  buildSystemPrompt,
  sanitizeAiText,
  sanitizeAiMessages
};


