const express = require('express');
const crypto = require('crypto');
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
  aiEffortOf,
  aiProviderOf,
  aiProviderTakes,
  rememberAiUnsupported,
  addToolCallParts,
  reasoningKeyOf,
  getAiSettings,
  setAiSettings,
  buildDatabaseSnapshot,
  buildSystemPrompt,
  sanitizeAiMessages,
  aiStreamEvents
} = require('../ai');
const { aiToolDefinitions, runAiTool, describeLookup, foundIn, AI_TOOL_NAMES } = require('../aiTools');

// While a model thinks, nothing may flow for minutes: a comment line every 15 s keeps proxies and the browser
// from closing the connection. A reply never takes longer than 10 minutes.
const AI_HEARTBEAT_MS = 15000;
const AI_MAX_MS = 10 * 60 * 1000;
// A lookup needs room for its result: with less left of the question's total, the model answers with what it has
const MIN_LOOKUP_CHARS = 600;
const NO_MORE_LOOKUPS = JSON.stringify({ error: 'No more lookups for this question: answer with what you have, and say what is missing.' });

const router = express.Router();

const isEffort = (value) => typeof value === 'string' && Object.hasOwn(AI_EFFORT_LEVELS, value);

router.get('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    res.json({
      enabled: aiSettings.enabled,
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
    // The stored key only goes to the address it was entered for: a new address needs the key again
    const current = await getAiSettings(context.appConfig);
    const newBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.baseUrl;
    const keepsKey = typeof body.apiKey !== 'string' || body.apiKey === '***';
    if (current.apiKey && keepsKey && (newBaseUrl || '') !== (current.baseUrl || '')) {
      return res.status(400).json({ error: 'Please enter the API key again for a new API address.' });
    }
    if (newBaseUrl && !/^https?:\/\//i.test(newBaseUrl)) {
      return res.status(400).json({ error: 'The API address must start with http:// or https://.' });
    }
    if (body.effort !== undefined && body.effort !== null && !isEffort(body.effort)) {
      return res.status(400).json({ error: 'The effort level must be low, medium or high.' });
    }
    await setAiSettings(context.appConfig, body);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save AI config:', err);
    res.status(500).json({ error: 'Failed to save AI config' });
  }
});

// --- One question: the provider answers, or first asks for lookups --------------------------------------------------

/** One request to the provider: { ok: true, response } or { ok: false, status, text } (its error text). */
async function askProvider(question, body) {
  const response = await fetch(`${question.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${question.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: question.signal
  });
  if (response.ok) return { ok: true, response };
  return { ok: false, status: response.status, text: await response.text().catch(() => '') };
}

/** The message of a provider's error answer, as the chat shows it. */
function errorDetail(status, text) {
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {}
  return String(detail || `AI provider returned ${status}`).slice(0, 300);
}

// A provider without tool calls (or reasoning_effort) refuses the request and names what it does not take. Such a
// refusal is told apart from a question that is too long, a missing key or a rate limit.
const TOO_LONG = /context[ _-]?length|maximum context|too many tokens|too long|reduce the length|token limit/i;
const REFUSALS = [
  ['reasoningContent', /reasoning_content/i],
  ['reasoningEffort', /reasoning/i],
  ['tools', /\btools?\b|tool[ _-]?(choice|call|use|support)|function[ _-]?call/i]
];

/** Which part of the request the provider refused ([sent]: the parts it got), so it can go again without it; or null. */
function refusedPart(status, text, sent) {
  if ([401, 402, 403, 429].includes(status) || TOO_LONG.test(text)) return null;
  return REFUSALS.find(([part, pattern]) => sent[part] && pattern.test(text))?.[0] || null;
}

/**
 * Streams one answer of the provider on to the person (thoughts and text, as before) and collects the lookups it
 * asks for. Text of a later round starts on a line of its own ([last]: the text sent last, per kind).
 */
async function streamTurn(response, send, last, laterRound) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map();
  const turn = { content: '', reasoning: '', reasoningKey: null, calls: [] };
  const started = { content: false, reasoning: false };
  let buffer = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const chunk = JSON.parse(data);
      for (const event of aiStreamEvents(chunk)) {
        const kind = typeof event.content === 'string' ? 'content' : typeof event.reasoning === 'string' ? 'reasoning' : null;
        if (kind) {
          if (laterRound && !started[kind] && last[kind] && !last[kind].endsWith('\n')) send({ [kind]: '\n\n' });
          started[kind] = true;
          last[kind] = event[kind];
          turn[kind] += event[kind];
        }
        send(event);
      }
      addToolCallParts(calls, chunk, AI_TOOL_NAMES);
      turn.reasoningKey ||= reasoningKeyOf(chunk);
    } catch { /* skip malformed chunks */ }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handleLine);
    }
    handleLine(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }
  // Calls without an id get one (some providers leave it out; nine letters and digits suit every provider)
  turn.calls = [...calls.values()].filter((call) => call.name).map((call) => ({ ...call, id: call.id || crypto.randomBytes(5).toString('hex').slice(0, 9) }));
  return turn;
}

/** The provider's turn with its lookups, as it goes back into the conversation. */
function assistantTurn(turn, echoReasoning) {
  return {
    role: 'assistant',
    content: turn.content,
    // DeepSeek and Kimi want a turn's thoughts back with its tool calls (under the name they sent them)
    ...(echoReasoning && turn.reasoningKey === 'reasoning_content' && turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
    tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }))
  };
}

/**
 * Answers one question ([question]: who asks, the provider, the conversation, the lookups offered and the limits of
 * the effort level). Without lookups offered this is the one request it always was. With them, the provider answers
 * or asks for lookups first: they run (permissions checked again for each), their results go back, and the provider
 * answers or asks again - until the answer is complete or the lookups of the effort level are used up.
 */
async function answerQuestion(question) {
  const { send, limits } = question;
  const conversation = [{ role: 'system', content: question.systemPrompt(question.tools.length > 0) }, ...question.messages];
  let tools = question.tools;
  let reasoningEffort = question.reasoningEffort;
  let echoReasoning = true;
  let lookupsLeft = limits.lookups;
  let charsLeft = limits.total;
  const lookups = [];
  const last = { content: '', reasoning: '' };

  /** One request; a part the provider refused is left out (and remembered) and the request goes again without it. */
  const request = async (messages, { offerTools, toolChoice } = {}) => {
    for (;;) {
      const body = { model: question.provider.model, messages, stream: true };
      if (offerTools && tools.length) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
      }
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;
      const reply = await askProvider(question, body);
      if (reply.ok) return reply;
      console.error('AI provider error:', reply.status, reply.text);
      const part = refusedPart(reply.status, reply.text, {
        reasoningContent: messages.some((message) => message.reasoning_content !== undefined),
        reasoningEffort: Boolean(reasoningEffort),
        // Tools can only be dropped before anything was looked up
        tools: Boolean(body.tools) && lookups.length === 0
      });
      if (!part) return reply;
      if (part === 'reasoningContent') {
        echoReasoning = false;
        for (const message of messages) delete message.reasoning_content;
        continue;
      }
      if (part === 'reasoningEffort') reasoningEffort = null;
      if (part === 'tools') {
        tools = [];
        // The model can no longer look anything up: the prompt says nothing about it either
        messages[0] = { role: 'system', content: question.systemPrompt(false) };
      }
      console.warn(`[AI] ${question.provider.baseUrl} (${question.provider.model}) does not take ${part === 'tools' ? 'tool calls: questions go without lookups' : 'reasoning_effort: questions go without it'} until the AI settings are saved again.`);
      await rememberAiUnsupported(context.appConfig, question.provider.key, part).catch((err) => console.error('[AI] could not remember the provider\'s limits:', err.message));
    }
  };

  for (let round = 0; ; round += 1) {
    const exhausted = lookupsLeft <= 0 || charsLeft < MIN_LOOKUP_CHARS;
    // Lookups used up: the tools stay in the request (the conversation holds their calls), but may not be called
    const reply = await request(conversation, { offerTools: true, toolChoice: exhausted ? 'none' : null });
    if (!reply.ok) {
      // After lookups a provider may refuse what goes with them (tool_choice "none", the results as tool
      // messages): once more with the results as text and without tools
      if (lookups.length && (await answerWithResults(question, lookups, request, send, last))) break;
      if (!lookups.length) send({ error: errorDetail(reply.status, reply.text) });
      return;
    }
    const turn = await streamTurn(reply.response, send, last, round > 0);
    if (!turn.calls.length || !tools.length) break;
    if (exhausted) {
      // The model asks again although nothing is left (some providers ignore tool_choice): unless it already
      // answered, one last request with the results as text and without tools
      if (!turn.content.trim() && !(await answerWithResults(question, lookups, request, send, last))) return;
      break;
    }
    conversation.push(assistantTurn(turn, echoReasoning));
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
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (question.signal.aborted) throw new Error('The question was cancelled.');
  }
  send('[DONE]');
}

/**
 * The last request when the model would not stop looking up: the results go in as text, no tools are offered.
 * False when the provider answered with an error (it was sent on).
 */
async function answerWithResults(question, lookups, request, send, last) {
  const results = lookups.map((lookup) => `${lookup.name} ${lookup.arguments || '{}'}: ${lookup.result}`).join('\n');
  const note = `\n\nLookups already made for this question, with their results:\n${results}\n\nAnswer now with these results; no further lookups are possible.`;
  const messages = question.messages.map((message) => ({ ...message }));
  const asked = messages[messages.length - 1];
  if (asked?.role === 'user') asked.content += note;
  else messages.push({ role: 'user', content: note.trim() });
  const reply = await request([{ role: 'system', content: question.systemPrompt(true) }, ...messages], { offerTools: false });
  if (!reply.ok) {
    send({ error: errorDetail(reply.status, reply.text) });
    return false;
  }
  await streamTurn(reply.response, send, last, true);
  return true;
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

    const provider = aiProviderOf(aiSettings);
    const apiKey = aiSettings.apiKey || '';

    const canViewFinances = req.user?.canViewFinances === true || req.user?.canManageFinances === true;
    const dbSnapshot = await buildDatabaseSnapshot(context.appConfig, { canViewFinances, user: req.user });
    // The effort level decides whether the model may look up the full history, and how much (ai.js)
    const limits = AI_EFFORT_LEVELS[aiEffortOf(aiSettings)];
    const tools = limits.lookups > 0 && aiProviderTakes(aiSettings, 'tools') ? aiToolDefinitions(req.user) : [];
    const reasoningEffort = limits.reasoningEffort && aiProviderTakes(aiSettings, 'reasoningEffort') ? limits.reasoningEffort : null;

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
        provider,
        apiKey,
        messages,
        limits,
        tools,
        reasoningEffort,
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
