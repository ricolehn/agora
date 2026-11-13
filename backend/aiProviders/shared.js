// What the connections to the AI services share (backend/aiProviders): reading server-sent events, the output of one
// turn, and telling a refused part of a request apart from other errors.

// A request that is too long, a missing key or a rate limit is no refusal of a part of the request
const TOO_LONG = /context[ _-]?length|maximum context|too many tokens|too long|reduce the length|token limit/i;
const NOT_A_REFUSAL = new Set([401, 402, 403, 429]);
// A service without tool calls names them when it refuses the request
const TOOLS_REFUSED = /\btools?\b|tool[ _-]?(choice|call|use|support)|function[ _-]?call|function[ _-]?declaration/i;

/** Can [failed] ({ status, text }) be a refusal of a part of the request at all. */
const mayBeRefusal = (failed) => !NOT_A_REFUSAL.has(failed.status) && !TOO_LONG.test(failed.text || '');

/**
 * What one turn sends on to the person: thoughts ({ reasoning }), text ({ content }) and errors. The text of a later
 * round starts on a line of its own ([last]: the text sent last, per kind, across the rounds of a question).
 */
function roundOutput(send, last, laterRound) {
  const started = { content: false, reasoning: false };
  const emit = (kind) => (text) => {
    if (typeof text !== 'string' || !text) return;
    if (laterRound && !started[kind] && last[kind] && !last[kind].endsWith('\n')) send({ [kind]: '\n\n' });
    started[kind] = true;
    last[kind] = text;
    send({ [kind]: text });
  };
  return { reasoning: emit('reasoning'), content: emit('content'), error: (message) => send({ error: String(message).slice(0, 300) }) };
}

/** Reads the server-sent events of [response] and calls [onEvent](data, eventName) for each of them. */
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name = '';
  let data = [];
  const flush = () => {
    if (data.length) onEvent(data.join('\n'), name);
    data = [];
    name = '';
  };
  const handle = (line) => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
    return undefined;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(handle);
    }
    buffer += decoder.decode();
    if (buffer) handle(buffer);
    flush();
  } finally {
    reader.releaseLock();
  }
}

/** The conversation of the chat ({ role, content }), starting with a question (some services need that). */
const fromFirstQuestion = (messages) => messages.slice(Math.max(0, messages.findIndex((message) => message.role === 'user')));

/** A lookup's result as an object (for services that take results as objects). */
function resultObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* plain text */ }
  return { result: text };
}

module.exports = { TOO_LONG, TOOLS_REFUSED, mayBeRefusal, roundOutput, readEvents, fromFirstQuestion, resultObject };
