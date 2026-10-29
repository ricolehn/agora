const { getStateValue, upsertStateValue, listPeopleRecords, listExpenseRecords, listUserRecords, listRequestRecords, isDeletedPerson } = require('./pocketbase');
const { toDateStr } = require('./utils/date');
const { buildEventContext } = require('./eventContext');

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

/**
 * Builds a full database context snapshot for the AI system prompt.
 * Includes all member, expense, request, and user records.
 */
async function buildDatabaseSnapshot(appConfig, options = {}) {
  try {
    const canViewFinances = options.canViewFinances === true;

    const [allPeople, expenses, users, settings, requests, donations] = await Promise.all([
      listPeopleRecords(appConfig).catch(() => []),
      canViewFinances ? listExpenseRecords(appConfig).catch(() => []) : Promise.resolve([]),
      listUserRecords(appConfig).catch(() => []),
      getStateValue(appConfig, 'settings', {}).catch(() => ({})),
      listRequestRecords(appConfig).catch(() => []),
      canViewFinances ? getStateValue(appConfig, 'donations', {}).catch(() => ({})) : Promise.resolve({})
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
      return {
        id: p.personKey,
        name: p.name || '',
        status: p.status || '',
        memberSince: p.memberSince || '',
        originalMemberSince: p.originalMemberSince || p.memberSince || '',
        totalPaid: Math.round(Number(String(p.totalPaid || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
        payments: payments.map((pay) => ({
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

    // Booked payments of deleted people: part of the books, but not of the member list
    const deletedPeoplePayments = canViewFinances ? deletedPeople.flatMap((p) => (Array.isArray(p.data?.payments) ? p.data.payments : [])
      .map((pay) => ({
        name: p.name || '',
        amount: Math.round(Number(String(pay.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
        date: pay.date || '',
        description: pay.description || ''
      }))) : [];

    // Build expense records (empty if not authorized)
    const expenseRecords = canViewFinances ? expenses.map((e) => ({
      id: e.expenseKey,
      amount: Math.round(Number(String(e.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) * 100) / 100,
      date: e.date || '',
      issuer: e.issuer || '',
      description: e.description || ''
    })) : [];

    // Filter requests
    const requestRecords = requests
      .filter((r) => canViewFinances || (options.user && String(r.userId) === String(options.user.uid)))
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
      snapshot.contributionRates = {
        vollverdiener: settings.vollverdiener ?? null,
        geringverdiener: settings.geringverdiener ?? null,
        keinverdiener: settings.keinverdiener ?? null,
        pausiert: settings.pausiert ?? null
      };
      snapshot.expenses = expenseRecords;
      snapshot.paymentsOfDeletedMembers = deletedPeoplePayments;
      snapshot.donations = donations;
      snapshot.requests = requestRecords;
    } else if (requestRecords.length > 0) {
      snapshot.myRequests = requestRecords;
    }

    return JSON.stringify(snapshot, null, 2);
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
  return `You are a helpful support assistant for the ${appName || 'Agora'} management application. Answer questions about the application data, members, finances, events and settings. Be concise and helpful. Events: the "events" list holds the appointments and events this person can see (two weeks back to a year ahead) with time, place, organizer, description, registration state, their own duty and - where they may see it - the duty roster and order of service. Dates are YYYY-MM-DD, "today" is the current date; answer with readable dates. Deleted members are not in "members" and owe nothing: only their booked payments stay, in "paymentsOfDeletedMembers".\n\nCurrent database context:\n${dbSnapshot}`;
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


