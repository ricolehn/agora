// Any OpenAI-compatible service at the address the admins enter (Ollama, LM Studio, vLLM, OpenRouter, ...): the Chat
// Completions interface, as the chat always used it. Thoughts come where the service streams them (reasoning,
// reasoning_content, <think> blocks); a service that refuses tool calls or reasoning_effort gets the question again
// without them.
const crypto = require('crypto');
const { addToolCallParts, reasoningKeyOf, aiStreamEvents } = require('../ai');
const { TOOLS_REFUSED, mayBeRefusal } = require('./shared');

// The effort levels as reasoning_effort: only from "high" on (below, the service's own default, as before)
const REASONING_EFFORT = { high: 'high', xhigh: 'high', max: 'high' };

const refusals = (sent, lookedUp) => [
  ['reasoningContent', /reasoning_content/i, sent.reasoningContent, false],
  ['reasoningEffort', /reasoning/i, sent.reasoningEffort, true],
  // Tools can only be dropped before anything was looked up
  ['tools', TOOLS_REFUSED, sent.tools && !lookedUp, true]
];

module.exports = {
  start: ({ system, messages }) => ({ messages: [{ role: 'system', content: system }, ...messages] }),

  async turn(state, request, { provider, apiKey, signal, out, toolNames }) {
    const leave = request.leaveOut;
    const messages = leave.has('reasoningContent')
      ? state.messages.map(({ reasoning_content: dropped, ...message }) => message)
      : state.messages;
    const body = { model: provider.model, messages, stream: true };
    if (request.tools.length) {
      body.tools = request.tools;
      if (request.toolChoice === 'none') body.tool_choice = 'none';
    }
    const effort = REASONING_EFFORT[request.level];
    if (effort && !leave.has('reasoningEffort')) body.reasoning_effort = effort;
    const sent = {
      tools: Boolean(body.tools),
      reasoningEffort: Boolean(body.reasoning_effort),
      reasoningContent: messages.some((message) => message.reasoning_content !== undefined)
    };

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) return { ok: false, status: response.status, text: await response.text().catch(() => ''), sent };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map();
    const turn = { content: '', reasoning: '', reasoningKey: null };
    let buffer = '';
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data);
        for (const event of aiStreamEvents(chunk)) {
          if (typeof event.content === 'string') {
            turn.content += event.content;
            out.content(event.content);
          } else if (typeof event.reasoning === 'string') {
            turn.reasoning += event.reasoning;
            out.reasoning(event.reasoning);
          } else if (event.error) {
            out.error(event.error);
          }
        }
        addToolCallParts(calls, chunk, toolNames);
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
    const named = [...calls.values()].filter((call) => call.name).map((call) => ({ ...call, id: call.id || crypto.randomBytes(5).toString('hex').slice(0, 9) }));
    return { ok: true, calls: named, text: turn.content, native: turn };
  },

  refused(failed, request, { lookedUp }) {
    if (!failed.sent || !mayBeRefusal(failed)) return null;
    const found = refusals(failed.sent, lookedUp).find(([, pattern, sent]) => sent && pattern.test(failed.text));
    return found ? { part: found[0], remember: found[3] } : null;
  },

  addLookups(state, turn, results) {
    state.messages.push({
      role: 'assistant',
      content: turn.native.content,
      // DeepSeek and Kimi want a turn's thoughts back with its tool calls (under the name they sent them)
      ...(turn.native.reasoningKey === 'reasoning_content' && turn.native.reasoning ? { reasoning_content: turn.native.reasoning } : {}),
      tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }))
    });
    for (const { call, result } of results) state.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
  }
};
