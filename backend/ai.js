const { getStateValue, upsertStateValue, listPeopleRecords, listExpenseRecords, listUserRecords, listRequestRecords, isDeletedPerson, getFeeState } = require('./pocketbase');
const { queueRecordWrite } = require('./db/writeQueue');
const { toDateStr } = require('./utils/date');
const { buildEventContext } = require('./eventContext');
const { describeFeeResets } = require('./feeReset');
const { describeFeeSchedule } = require('./feeSchedule');

const AI_STATE_KEY = 'ai_config';
// The AI settings are read and written one change at a time (the admins' saves, and what the chat remembers about
// the provider)
const AI_STATE_LOCK = 'state:ai';

const AI_CONFIG_DEFAULTS = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini'
};

// How much a question may cost, per effort level (Settings → AI; set by the admins, stored with the AI settings):
//  - low: the compact context only, one request per question - as before there were lookups.
//  - medium (the default): the model may look up the full history when a question needs it.
//  - high: more and larger lookups, and more thinking for models that support it (reasoning_effort).
// lookups: how many lookups one question may make; rows / chars: the most one lookup's result may hold (rows, and
// characters of its JSON); total: the characters all results of one question may hold together. A question without
// lookups costs about the same on every level (medium and high add the short description of the lookups); each round
// of lookups sends the question with its context once more.
const AI_EFFORT_LEVELS = Object.freeze({
  low: Object.freeze({ lookups: 0, rows: 0, chars: 0, total: 0, reasoningEffort: null }),
  medium: Object.freeze({ lookups: 4, rows: 50, chars: 8000, total: 24000, reasoningEffort: null }),
  high: Object.freeze({ lookups: 10, rows: 200, chars: 24000, total: 120000, reasoningEffort: 'high' })
});
const DEFAULT_AI_EFFORT = 'medium';

/** The effort level of [settings] (missing or unknown: medium). */
const aiEffortOf = (settings) => (typeof settings?.effort === 'string' && Object.hasOwn(AI_EFFORT_LEVELS, settings.effort) ? settings.effort : DEFAULT_AI_EFFORT);

/** The provider a question goes to: its address and model as the chat uses them, and both together as its key. */
function aiProviderOf(settings) {
  const baseUrl = (settings?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = settings?.model || 'gpt-4o-mini';
  return { baseUrl, model, key: `${baseUrl}|${model}` };
}

// What the chat remembers when the provider refused a part of the request: until the settings are saved again,
// questions to this address and model go without it
const UNSUPPORTED_FIELDS = { tools: 'toolsUnsupportedFor', reasoningEffort: 'reasoningEffortUnsupportedFor' };

/** Does the provider of [settings] take [feature] ('tools' or 'reasoningEffort'), as far as the chat knows. */
const aiProviderTakes = (settings, feature) => settings?.[UNSUPPORTED_FIELDS[feature]] !== aiProviderOf(settings).key;

async function getAiSettings(appConfig) {
  return getStateValue(appConfig, AI_STATE_KEY, AI_CONFIG_DEFAULTS);
}

/**
 * Persists AI settings to the app_state collection.
 * Pass `apiKey: '***'` as a sentinel to keep the existing key unchanged.
 */
async function setAiSettings(appConfig, patch) {
  return queueRecordWrite(AI_STATE_LOCK, async () => {
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
    // The effort level is stored once it was chosen (without one, a question costs "medium"). What the chat
    // remembered about the provider is dropped: saving the settings tries everything again.
    const effort = typeof patch.effort === 'string' && Object.hasOwn(AI_EFFORT_LEVELS, patch.effort) ? patch.effort : current.effort;
    if (typeof effort === 'string' && Object.hasOwn(AI_EFFORT_LEVELS, effort)) next.effort = effort;
    await upsertStateValue(appConfig, AI_STATE_KEY, next);
    return next;
  });
}

/** Remembers that the provider [providerKey] refused [feature] ('tools' or 'reasoningEffort'). */
async function rememberAiUnsupported(appConfig, providerKey, feature) {
  const field = UNSUPPORTED_FIELDS[feature];
  return queueRecordWrite(AI_STATE_LOCK, async () => {
    const current = await getAiSettings(appConfig);
    // The settings were changed meanwhile: the new provider gets its own chance
    if (aiProviderOf(current).key !== providerKey || current[field] === providerKey) return;
    await upsertStateValue(appConfig, AI_STATE_KEY, { ...current, [field]: providerKey });
  });
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

// What the model is told when it may look things up (aiTools.js) - only then: without lookups the prompt is the one
// it always was. No braces in here: the context after it is JSON.
const LOOKUP_GUIDE = {
  finance: 'Lookups: the context below is a summary - the newest entries of every history, the totals per month and year, the events from two weeks back to a year ahead. When a question needs more than that (older or all single entries, sums by description, person or period, a member\'s whole history, past events, the change log), call the lookup tools: they read the complete history with the application\'s exact amounts. Look up only what the question needs, and let the tools filter and sum up (groupBy) so the results stay small. Categories such as flowers, rent or technology are not stored: find them by words in the descriptions (and the issuer or donor) - give several spellings and both languages - and always say which descriptions you counted. The costs of an event are the expenses whose description names the event or its date. A result that says it was cut covers only part of the data: say so, or narrow the lookup. Mark every estimate or forecast clearly as an estimate and name the numbers it rests on.',
  events: 'Lookups: the events list below covers two weeks back to a year ahead. For other periods, or to count the dates of a recurring event, call the events lookup - it reads the whole calendar this person can see. Mark every estimate clearly as an estimate and name the numbers it rests on.'
};

/**
 * Builds the system prompt injected at the start of every chat request.
 * @param {string} appName - The configured application name.
 * @param {string} dbSnapshot - JSON string from buildDatabaseSnapshot.
 * @param {{ canViewFinances?: boolean, lookups?: boolean }} options - lookups: the model is offered the lookup tools.
 */
function buildSystemPrompt(appName, dbSnapshot, options = {}) {
  const canViewFinances = options.canViewFinances === true;
  const lookups = options.lookups === true ? `\n\n${LOOKUP_GUIDE[canViewFinances ? 'finance' : 'events']}` : '';
  if (!canViewFinances) {
    return `You are a helpful support assistant for the ${appName || 'Agora'} application. Answer questions about the community, member directory, events and general app usage. Be concise and helpful. Events: the "events" list holds the appointments and events this person can see (two weeks back to a year ahead) with time, place, organizer, description, registration state, their own duty and - where they may see it - the duty roster and order of service. Dates are YYYY-MM-DD, "today" is the current date; answer with readable dates.
IMPORTANT: You do not possess, receive, or have access to any financial data, contribution rates, payments, expenses, donations, or account balances in your database context. All financial records are completely excluded from your view. You cannot view or provide any financial information. If the user asks about finances, explain politely that you do not have access to any financial data and that viewing finances requires financial management permissions.${lookups}\n\nCurrent database context:\n${dbSnapshot}`;
  }
  return `You are a helpful support assistant for the ${appName || 'Agora'} management application. Answer questions about the application data, members, finances, events and settings. Be concise and helpful. Events: the "events" list holds the appointments and events this person can see (two weeks back to a year ahead) with time, place, organizer, description, registration state, their own duty and - where they may see it - the duty roster and order of service. Dates are YYYY-MM-DD, "today" is the current date; answer with readable dates. Deleted members are not in "members" and owe nothing: only their booked payments stay, in "paymentsOfDeletedMembers". Fees: each member's "feeAccount" is the application's own calculation - take who is overdue (isOverdue), the open amount (overdueEur), the balance (balanceEur, negative means owed) and the last fully paid month (paidUpToMonth) from it instead of adding up months and payments yourself; it is null for members who pay no fees. "feeResets" lists the days on which all fee accounts were started afresh (state "active": counted from; "scheduled": still to come). On such a day the account of every member who had joined before it was settled: whoever was behind starts from zero (openFeesDroppedEur was dropped and is no longer owed), whoever had paid ahead keeps that credit (creditCarriedOverEur), and since that day ("startedAfreshOn"; "countsFrom" is where the account counts from) the months are owed and the payments credited anew. Every month costs the fees of its time: "contributionRates" are the monthly fees of the current month, "contributionRatesOverTime" lists the fees from the beginning ("from": null) and every change with the month it counts from ("from": YYYY-MM; state "current": counts this month, "planned": still to come, "past": replaced by a later change) - the months before a change keep the fees before it. All payments stay in the books, in "totalPaid" and the cash balance; "memberSince" never changes. Histories are shortened to stay readable after years: per member the newest payments ("recentPayments", "paymentCount" in total, "firstPaymentDate"), the newest expenses, donations and requests (with "expenseCount" and "donationCount"); "monthlyTotals" (the last three years) and "yearlyTotals" sum up all money in EUR per month and year (memberPaymentsEur, donationsEur, expensesEur). Say so when a question needs older single entries than the context holds.${lookups}\n\nCurrent database context:\n${dbSnapshot}`;
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

/**
 * Adds the tool calls in one parsed chunk of an OpenAI-compatible stream to [calls] (a Map, in the order they came).
 * They come in pieces by their index (OpenAI); some providers send each call whole, without an index, and some send
 * the arguments as an object instead of JSON text. Returns [calls].
 */
function addToolCallParts(calls, chunk, knownNames = []) {
  const choice = chunk?.choices?.[0];
  const parts = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  if (!Array.isArray(parts)) return calls;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const known = [...calls.values()];
    let key = Number.isInteger(part.index) ? part.index : null;
    if (key === null) {
      // Without an index: a call with an id not seen yet is a new one, anything else goes on with the last one
      const continues = known.length > 0 && (!part.id || known[known.length - 1].id === part.id || known.some((call) => call.id === part.id));
      key = continues ? [...calls.keys()].pop() : `call${calls.size}`;
    }
    let call = calls.get(key);
    if (!call) calls.set(key, (call = { id: '', name: '', arguments: '' }));
    if (typeof part.id === 'string' && part.id) call.id = part.id;
    const name = part.function?.name;
    // A name comes once (OpenAI), again with every piece, or in pieces
    if (typeof name === 'string' && name && call.name !== name && !knownNames.includes(call.name)) call.name += name;
    const args = part.function?.arguments;
    if (typeof args === 'string') call.arguments += args;
    else if (args && typeof args === 'object') call.arguments = JSON.stringify(args);
  }
  return calls;
}

/** Under which name a parsed chunk carries the thought process ('reasoning_content', 'reasoning', ...), or null. */
function reasoningKeyOf(chunk) {
  const delta = chunk?.choices?.[0]?.delta || chunk?.choices?.[0]?.message || {};
  return ['reasoning_content', 'reasoning', 'thinking', 'reasoning_details'].find((key) => typeof delta[key] === 'string' ? delta[key] : Array.isArray(delta[key]) && delta[key].length) || null;
}

module.exports = {
  AI_EFFORT_LEVELS,
  DEFAULT_AI_EFFORT,
  aiEffortOf,
  aiProviderOf,
  aiProviderTakes,
  rememberAiUnsupported,
  addToolCallParts,
  reasoningKeyOf,
  aiStreamEvents,
  getAiSettings,
  setAiSettings,
  buildDatabaseSnapshot,
  buildSystemPrompt,
  sanitizeAiText,
  sanitizeAiMessages
};


