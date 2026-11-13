const express = require('express');
const {
  context,
  verifyToken,
  verifySuperAdmin,
  verifyAiAccess,
  aiChatRateLimit,
  broadcastDataUpdate,
  resolveRequestUser
} = require('../context');

const {
  AI_EFFORT_LEVELS,
  AI_PROVIDERS,
  aiEffortOf,
  aiProviderIdOf,
  aiAddressOf,
  aiProviderOf,
  aiRefusedParts,
  rememberAiUnsupported,
  getAiSettings,
  setAiSettings,
  buildDatabaseSnapshot,
  buildSystemPrompt,
  sanitizeAiMessages
} = require('../ai');
const { aiToolDefinitions, runAiTool, describeLookup, foundIn, AI_TOOL_NAMES } = require('../aiTools');
const { adapterFor, roundOutput } = require('../aiProviders');

// While a model thinks, nothing may flow for minutes: a comment line every 15 s keeps proxies and the browser
// from closing the connection. A reply never takes longer than 10 minutes.
const AI_HEARTBEAT_MS = 15000;
const AI_MAX_MS = 10 * 60 * 1000;
// A lookup needs room for its result: with less left of the question's total, the model answers with what it has
const MIN_LOOKUP_CHARS = 600;
const NO_MORE_LOOKUPS = JSON.stringify({ error: 'No more lookups for this question: answer with what you have, and say what is missing.' });

const router = express.Router();

const isEffort = (value) => typeof value === 'string' && Object.hasOwn(AI_EFFORT_LEVELS, value);
const isProvider = (value) => typeof value === 'string' && Object.hasOwn(AI_PROVIDERS, value);

router.get('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    res.json({
      enabled: aiSettings.enabled,
      provider: aiProviderIdOf(aiSettings),
      baseUrl: aiSettings.baseUrl || '',
      apiKey: '***',
      model: aiSettings.model || '',
      effort: aiEffortOf(aiSettings)
    });
  } catch (err) {
    console.error('Failed to get AI config:', err);
    res.status(500).json({ error: 'Failed to get AI config' });
  }
});

router.get('/api/admin/ai-status', verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    res.json({ enabled: !!aiSettings.enabled });
  } catch (err) {
    res.json({ enabled: false });
  }
});

router.put('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.provider !== undefined && body.provider !== null && !isProvider(body.provider)) {
      return res.status(400).json({ error: 'The provider must be anthropic, gemini, openai or custom.' });
    }
    // The stored key only goes to the address it was entered for: a new address (or service) needs the key again
    const current = await getAiSettings(context.appConfig);
    const newBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.baseUrl;
    const next = { ...current, baseUrl: newBaseUrl, ...(isProvider(body.provider) ? { provider: body.provider } : {}) };
    const keepsKey = typeof body.apiKey !== 'string' || body.apiKey === '***';
    if (current.apiKey && keepsKey && aiAddressOf(next) !== aiAddressOf(current)) {
      return res.status(400).json({ error: 'Please enter the API key again for a new API address.' });
    }
    if (newBaseUrl && !/^https?:\/\//i.test(newBaseUrl)) {
      return res.status(400).json({ error: 'The API address must start with http:// or https://.' });
    }
    if (body.effort !== undefined && body.effort !== null && !isEffort(body.effort)) {
      return res.status(400).json({ error: 'The effort level must be low, medium, high, xhigh or max.' });
    }
    await setAiSettings(context.appConfig, body);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save AI config:', err);
    res.status(500).json({ error: 'Failed to save AI config' });
  }
});

// --- One question: the service answers, or first asks for lookups ----------------------------------------------------

/** The message of a service's error answer, as the chat shows it. */
function errorDetail(status, text) {
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {}
  return String(detail || `AI provider returned ${status}`).slice(0, 300);
}

/**
 * Answers one question ([question]: who asks, the service and its connection, the conversation, the lookups offered
 * and the limits of the effort level). The service answers, or asks for lookups first: they run (permissions checked
 * again for each), their results go back, and it answers or asks again - until the answer is complete or the lookups
 * of the effort level are used up. Without lookups offered this is a single request.
 */
async function answerQuestion(question) {
  const { send, limits, adapter } = question;
  let tools = question.tools;
  let level = question.level;
  const leaveOut = new Set(question.leaveOut);
  const startWith = (lookupsOffered) => adapter.start({ system: question.systemPrompt(lookupsOffered), messages: question.messages });
  let state = startWith(tools.length > 0);
  let lookupsLeft = limits.lookups;
  let charsLeft = limits.total;
  const lookups = [];
  const last = { content: '', reasoning: '' };

  /**
   * One turn of [current]. A part the service refused is left out (and remembered where the connection says so),
   * or a lower effort level tried, and the turn goes again.
   */
  const turnOf = async (current, { offerTools, toolChoice, laterRound }) => {
    let conversation = current;
    for (let attempt = 0; ; attempt += 1) {
      const request = { tools: offerTools ? tools : [], toolChoice, level, leaveOut };
      const out = roundOutput(send, last, laterRound);
      const turn = await adapter.turn(conversation, request, { ...question.connection, signal: question.signal, out, toolNames: AI_TOOL_NAMES });
      if (turn.ok || attempt >= 6) return { turn, conversation };
      if (turn.again) continue;
      if (turn.status !== 200) console.error('AI provider error:', turn.status, turn.text);
      const change = adapter.refused(turn, request, { lookedUp: lookups.length > 0 });
      if (!change) return { turn, conversation };
      if (change.level) level = change.level;
      if (change.part) {
        leaveOut.add(change.part);
        if (change.part === 'tools') {
          // The model can no longer look anything up: the prompt says nothing about it either
          tools = [];
          if (conversation === state) conversation = state = startWith(false);
        }
        if (change.remember) {
          console.warn(`[AI] ${question.connection.provider.id} (${question.connection.provider.model}) does not take "${change.part}": questions go without it until the AI settings are saved again.`);
          await rememberAiUnsupported(context.appConfig, question.connection.provider.key, change.part).catch((err) => console.error('[AI] could not remember the provider\'s limits:', err.message));
        }
      }
    }
  };

  /**
   * The last request when the model would not stop looking up, or the service refused what goes with the lookups:
   * the results go in as text, no tools are offered. False when the service answered with an error (it was sent on).
   */
  const answerWithResults = async () => {
    const results = lookups.map((lookup) => `${lookup.name} ${lookup.arguments || '{}'}: ${lookup.result}`).join('\n');
    const note = `\n\nLookups already made for this question, with their results:\n${results}\n\nAnswer now with these results; no further lookups are possible.`;
    const messages = question.messages.map((message) => ({ ...message }));
    const asked = messages[messages.length - 1];
    if (asked?.role === 'user') asked.content += note;
    else messages.push({ role: 'user', content: note.trim() });
    const { turn } = await turnOf(adapter.start({ system: question.systemPrompt(true), messages }), { offerTools: false, toolChoice: 'auto', laterRound: true });
    if (!turn.ok) {
      send({ error: turn.message || errorDetail(turn.status, turn.text) });
      return false;
    }
    return true;
  };

  for (let round = 0; ; round += 1) {
    const exhausted = lookupsLeft <= 0 || charsLeft < MIN_LOOKUP_CHARS;
    // Lookups used up: the tools stay in the request (the conversation holds their calls), but may not be called
    const { turn } = await turnOf(state, { offerTools: true, toolChoice: exhausted ? 'none' : 'auto', laterRound: round > 0 });
    if (!turn.ok) {
      // After lookups a service may refuse what goes with them (tool_choice "none", the results as tool messages):
      // once more with the results as text and without tools
      if (lookups.length && turn.status !== 200 && (await answerWithResults())) break;
      if (!lookups.length || turn.status === 200) send({ error: turn.message || errorDetail(turn.status, turn.text) });
      return;
    }
    if (!turn.calls.length || !tools.length) break;
    if (exhausted) {
      // The model asks again although nothing is left (some services ignore tool_choice): unless it already
      // answered, one last request with the results as text and without tools
      if (!turn.text.trim() && !(await answerWithResults())) return;
      break;
    }
    const results = [];
    for (const call of turn.calls) {
      let result = NO_MORE_LOOKUPS;
      if (lookupsLeft > 0 && charsLeft >= MIN_LOOKUP_CHARS) {
        lookupsLeft -= 1;
        // The chat shows the lookup while it runs (in the model's own words, when it gave some) and then what it found
        const id = limits.lookups - lookupsLeft;
        send({ lookup: { id, ...describeLookup(call.name, call.arguments) } });
        // The permissions are checked again for every lookup: they can change while a question runs
        const user = await question.freshUser();
        result = user
          ? await runAiTool(call.name, call.arguments, { user, limits: { rows: limits.rows, chars: Math.min(limits.chars, charsLeft) } })
          : JSON.stringify({ error: 'The asking person may no longer use the assistant: answer without lookups.' });
        charsLeft -= result.length;
        send({ lookupDone: { id, ...(user ? foundIn(result) : { error: 'forbidden' }) } });
      }
      lookups.push({ name: call.name, arguments: call.arguments, result });
      results.push({ call, result });
    }
    adapter.addLookups(state, turn, results);
    if (question.signal.aborted) throw new Error('The question was cancelled.');
  }
  send('[DONE]');
}

router.post('/api/ai/chat', aiChatRateLimit, verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    if (!aiSettings.enabled) {
      return res.status(403).json({ error: 'AI support is not enabled' });
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const messages = sanitizeAiMessages(rawMessages, 50, 12000);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'No valid non-empty messages found in payload' });
    }

    // The service (Anthropic, Google, OpenAI or an OpenAI-compatible one) and what it refused before
    const provider = aiProviderOf(aiSettings);
    const apiKey = aiSettings.apiKey || '';
    const leaveOut = aiRefusedParts(aiSettings);

    const canViewFinances = req.user?.canViewFinances === true || req.user?.canManageFinances === true;
    const dbSnapshot = await buildDatabaseSnapshot(context.appConfig, { canViewFinances, user: req.user });
    // The effort level decides whether the model may look up the full history, how much, and how deeply it thinks
    const level = aiEffortOf(aiSettings);
    const limits = AI_EFFORT_LEVELS[level];
    const tools = limits.lookups > 0 && !leaveOut.includes('tools') ? aiToolDefinitions(req.user) : [];

    // From here on everything goes out as server-sent events, errors too ("data: {error}"), so the connection
    // is open (and kept alive) while the provider is still thinking about its first word
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = event => { if (!res.writableEnded) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, AI_HEARTBEAT_MS);
    const upstream = new AbortController();
    const deadline = setTimeout(() => upstream.abort(), AI_MAX_MS);
    // The person left (new chat, other page, app closed): stop asking the provider
    res.on('close', () => upstream.abort());

    try {
      await answerQuestion({
        send,
        signal: upstream.signal,
        adapter: adapterFor(provider.id),
        connection: { provider, apiKey },
        messages,
        limits,
        level,
        tools,
        leaveOut,
        systemPrompt: (lookups) => buildSystemPrompt(context.appConfig.appName, dbSnapshot, { canViewFinances, lookups }),
        // The asking person as they are now (null: they may no longer use the assistant)
        freshUser: async () => {
          try {
            const user = await resolveRequestUser(req.authToken);
            return user.canAccessAi === true || (Array.isArray(user.permissions) && user.permissions.includes('access_ai')) ? user : null;
          } catch {
            return null;
          }
        }
      });
    } catch (err) {
      if (!res.writableEnded && !res.destroyed) {
        console.error('AI chat stream error:', err);
        send({ error: upstream.signal.aborted ? 'The AI took too long to answer.' : 'AI chat request failed' });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      res.end();
    }
  } catch (err) {
    console.error('AI chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat request failed' });
    } else {
      res.end();
    }
  }
});

module.exports = router;
