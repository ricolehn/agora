const { getStateValue, upsertStateValue, listPeopleRecords, listExpenseRecords, listUserRecords, listRequestRecords } = require('./pocketbase');

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
 * Includes all member, expense, and pending request records.
 * Sensitive fields (passwords, tokens, emails, user IDs, receipt URLs) are excluded.
 */
async function buildDatabaseSnapshot(appConfig) {
  try {
    const [people, expenses, users, settings, requests] = await Promise.all([
      listPeopleRecords(appConfig).catch(() => []),
      listExpenseRecords(appConfig).catch(() => []),
      listUserRecords(appConfig).catch(() => []),
      getStateValue(appConfig, 'settings', {}).catch(() => ({})),
      listRequestRecords(appConfig).catch(() => [])
    ]);

    // Aggregate summary statistics
    const membersByStatus = {};
    let totalPaidAcrossMembers = 0;
    for (const p of people) {
      const status = p.status || 'unknown';
      membersByStatus[status] = (membersByStatus[status] || 0) + 1;
      totalPaidAcrossMembers += parseFloat(p.totalPaid || 0);
    }

    let totalExpenses = 0;
    for (const e of expenses) {
      totalExpenses += parseFloat(e.amount || 0);
    }

    // Build full member records (no uid, no raw data blob)
    const memberRecords = people.map((p) => {
      const payments = Array.isArray(p.data?.payments) ? p.data.payments : [];
      return {
        id: p.personKey,
        name: p.name || '',
        status: p.status || '',
        memberSince: p.memberSince || '',
        totalPaid: Math.round(parseFloat(p.totalPaid || 0) * 100) / 100,
        payments: payments.map((pay) => ({
          amount: Math.round(parseFloat(pay.amount || 0) * 100) / 100,
          date: pay.date || '',
          description: pay.description || ''
        }))
      };
    });

    // Build expense records (no receipt field)
    const expenseRecords = expenses.map((e) => ({
      id: e.expenseKey,
      amount: Math.round(parseFloat(e.amount || 0) * 100) / 100,
      date: e.date || '',
      issuer: e.issuer || '',
      description: e.description || ''
    }));

    // Include only pending requests (no userId)
    const pendingRequests = requests
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        id: r.requestKey,
        type: r.type || '',
        personName: r.personName || '',
        timestamp: r.timestamp || null,
        data: r.data || {}
      }));

    const snapshot = {
      summary: {
        totalMembers: people.length,
        membersByStatus,
        totalMemberPaymentsEur: Math.round(totalPaidAcrossMembers * 100) / 100,
        totalExpensesEur: Math.round(totalExpenses * 100) / 100,
        estimatedBalanceEur: Math.round((totalPaidAcrossMembers - totalExpenses) * 100) / 100,
        totalUsers: users.length,
        adminCount: users.filter((u) => u.admin === true).length
      },
      contributionRates: {
        vollverdiener: settings.vollverdiener ?? null,
        geringverdiener: settings.geringverdiener ?? null,
        keinverdiener: settings.keinverdiener ?? null,
        pausiert: settings.pausiert ?? null
      },
      members: memberRecords,
      expenses: expenseRecords,
      pendingRequests
    };

    return JSON.stringify(snapshot, null, 2);
  } catch (err) {
    console.error('ai.js: buildDatabaseSnapshot error:', err);
    return '{"error":"Could not build database snapshot"}';
  }
}

/**
 * Builds the system prompt injected at the start of every chat request.
 * @param {string} appName - The configured application name.
 * @param {string} dbSnapshot - JSON string from buildDatabaseSnapshot.
 */
function buildSystemPrompt(appName, dbSnapshot) {
  return `You are a helpful support assistant for the ${appName || 'Nova'} church management application. Answer admin questions about the application data, members, finances, and settings. Be concise and helpful.\n\nCurrent database context:\n${dbSnapshot}`;
}

module.exports = { getAiSettings, setAiSettings, buildDatabaseSnapshot, buildSystemPrompt };
