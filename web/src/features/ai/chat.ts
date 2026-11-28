// The AI assistant's chat: the conversation that goes to the server, what the page shows of it, sending with the
// answer streamed in, a new chat. The page (AiChatPage.tsx) draws it; each reply draws itself (reply.ts).
import { createSignal, onFlush } from 'solid-js';
import { API, auth, errorMessage, type ErrorAnswer } from '../../app/api';
import { t } from '../../app/i18n';
import { activeTab } from '../../app/router';
import { scrollContainer } from '../../app/shell';
import { fitChatInput, onChatInputKey } from '../../ui/chatInput';
import { splitAiThinking } from '../../lib/aiReply';
import type { AiSignState } from './AiSign';
import type { StreamPart } from '../../lib/aiReply';
import { createAiReply, type AiReply } from './reply';
import { aiChatAtEnd, aiChatToEnd, chatElements } from './scroll';

export type ChatEntry =
  | { role: 'user'; text: string; afterWelcome: boolean }
  | { role: 'assistant'; reply: AiReply; seed: number; afterWelcome: boolean };
type ChatMessage = { role: 'user' | 'assistant'; content: string };

// What goes to the server: the questions and the complete answers
let aiMessages: ChatMessage[] = [];
let aiStreaming = false;
// The running request; a new chat or a vanished connection cancels it
let aiChatAbort: AbortController | null = null;
// Every reply's sign starts at another moment of its motion
let aiReplyCount = 0;

const [entries, setEntries] = createSignal<ChatEntry[]>([]);
// The start page: shown, fading upwards for the first message, gone. Every new chat draws it anew (its entrance plays)
const [welcome, setWelcome] = createSignal<'shown' | 'leaving' | 'gone'>('shown');
let round = 1;
const [chatRound, setChatRound] = createSignal(round);
const [streaming, setStreaming] = createSignal(false);
// The small sign before the chat's title: livelier while a reply comes in
const [headerSign, setHeaderSign] = createSignal<AiSignState>('calm');
export { entries, welcome, chatRound, streaming, headerSign };
let welcomeState: 'shown' | 'leaving' | 'gone' = 'shown';
const putWelcome = (next: 'shown' | 'leaving' | 'gone') => {
  welcomeState = next;
  setWelcome(next);
};

// Without a single byte for this long (the server sends a sign of life every 15 s) the connection is gone
const AI_IDLE_TIMEOUT_MS = 75000;

/** The input grows with its text (up to a limit, then it scrolls). */
export const adjustAiInputHeight = (input = chatElements.input) => fitChatInput(input);

/** A new chat: a friendly start with three questions the assistant can answer. */
export function clearAiChat() {
  aiMessages = [];
  aiChatAbort?.abort();
  setHeaderSign('calm');
  aiReplyCount = 0;
  setEntries([]);
  putWelcome('shown');
  setChatRound(++round);
}

/** Opening the chat: a new one when there is no conversation; a conversation opens at its end. */
export function enterAiChat() {
  if (!aiMessages.length) clearAiChat();
  requestAnimationFrame(() => {
    adjustAiInputHeight();
    // A new chat opens on top, its header and greeting in sight (scrolled to its end, the greeting pushed the header
    // under the app's on phones, out of sight on small ones)
    if (aiMessages.length) aiChatToEnd();
    else if (activeTab() === 'ai-chat') scrollContainer()?.scrollTo({ top: 0, behavior: 'instant' });
  });
}

/** A suggestion of the start page: asked as if typed. */
export function askAi(text: string) {
  const input = chatElements.input;
  if (!input || aiStreaming) return;
  input.value = text;
  void sendAiMessage();
}

/** Ctrl/Cmd+Enter sends; plain Enter inserts a new line and grows the field. */
export function onAiInputKey(event: KeyboardEvent) {
  if (onChatInputKey(event, () => void sendAiMessage())) return;
  if (event.key === 'Enter') {
    const input = event.currentTarget as HTMLTextAreaElement;
    setTimeout(() => adjustAiInputHeight(input), 0);
  }
}

/** The start page has faded out (its animation ended, or the time for it is over). */
export function welcomeGone() {
  if (welcomeState === 'leaving') putWelcome('gone');
}

// The start page makes room for the first message: it fades upwards while the message comes in
function dismissWelcome(): boolean {
  if (welcomeState === 'gone') return false;
  // Still on its way out: the next message waits for it too
  if (welcomeState === 'leaving') return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    putWelcome('gone');
    return false;
  }
  putWelcome('leaving');
  const leaving = round;
  setTimeout(() => leaving === round && welcomeGone(), 600);
  return true;
}

function appendEntry(entry: { role: 'user'; text: string } | { role: 'assistant'; reply: AiReply; seed: number }) {
  const afterWelcome = dismissWelcome();
  setEntries(list => [...list, { ...entry, afterWelcome }]);
  // To the end once the new entry is there
  onFlush(aiChatToEnd);
}

// Normalizes text for AI providers: NFC, no control characters or lone surrogates, LF line endings
function sanitizeAiText(input: unknown): string {
  let text = typeof input === 'string' ? input : String(input || '');
  try {
    text = text.normalize('NFC');
  } catch {
    /* keep it as it is */
  }
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  const wellFormed = (text as string & { toWellFormed?: () => string }).toWellFormed;
  text = wellFormed ? wellFormed.call(text) : text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return text.replace(/\r\n?/g, '\n');
}

function sanitizeAiMessages(rawMessages: ChatMessage[], maxMessages = 50, maxCharPerMsg = 12000): ChatMessage[] {
  return rawMessages
    .filter(msg => msg && (msg.role === 'assistant' || msg.role === 'user'))
    .map(msg => ({ role: msg.role, content: sanitizeAiText(msg.content).trim().slice(0, maxCharPerMsg) }))
    .filter(msg => msg.content)
    .slice(-maxMessages);
}

// Server-sent events: "data: {content | reasoning | lookup | lookupDone | error}" lines, terminated by "data: [DONE]";
// ": ping" lines only keep the connection alive
async function readReplyStream(res: Response, reply: AiReply, keepAlive: () => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const handleLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let parsed: StreamPart & { error?: string };
    try {
      parsed = JSON.parse(data) as StreamPart & { error?: string };
    } catch {
      return;
    }
    if (parsed.error) throw new Error(parsed.error);
    const follow = aiChatAtEnd();
    reply.add(parsed);
    if (follow) requestAnimationFrame(aiChatToEnd);
  };
  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) break;
    keepAlive();
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handleLine);
  }
  if (!finished) handleLine(buffer + decoder.decode());
  if (finished) reader.cancel().catch(() => {});
}

/** Sends what is typed; the reply appears right away as "Thinking…" and fills in when the words come. */
export async function sendAiMessage() {
  const input = chatElements.input;
  if (aiStreaming || !input) return;
  const text = sanitizeAiText(input.value).trim();
  if (!text) return;
  input.value = '';
  adjustAiInputHeight(input);
  aiMessages.push({ role: 'user', content: text });
  appendEntry({ role: 'user', text });
  aiStreaming = true;
  setStreaming(true);
  setHeaderSign('thinking');

  const reply = createAiReply();
  appendEntry({ role: 'assistant', reply, seed: aiReplyCount++ * 7.3 });
  const controller = new AbortController();
  aiChatAbort = controller;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const keepAlive = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AI_IDLE_TIMEOUT_MS);
  };
  keepAlive();

  try {
    let token: string;
    try {
      token = await auth.currentUser!.getIdToken();
    } catch {
      throw new Error(t('error_auth_failed_short', 'Authentication failed'));
    }
    const messages = sanitizeAiMessages(aiMessages);
    if (messages.length === 0) throw new Error(t('ai_no_valid_message', 'No valid message to send'));
    const res = await fetch(`${API}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errData = (await res.json().catch(() => ({}))) as ErrorAnswer;
      throw new Error(errData.detail || errData.error || `HTTP ${res.status}`);
    }
    await readReplyStream(res, reply, keepAlive);
    reply.finish();
    const clean = sanitizeAiText(splitAiThinking(reply.content).answer).trim();
    // A model that only thought (or the connection ended early) gave no answer: say so instead of an empty row
    if (!clean) throw new Error(reply.reasoning ? t('ai_only_thought', 'The AI thought about it but sent no answer. Please try again.') : t('ai_no_answer', 'No answer came back. Please try again.'));
    // "Report reply" under a finished answer: sends it with the question to the admins (Google Play AI content policy)
    reply.allowReport({ answer: clean, prompt: [...aiMessages].reverse().find(m => m.role === 'user')?.content || '' });
    // Still at the end once the report link is there
    onFlush(() => aiChatAtEnd() && aiChatToEnd());
    aiMessages.push({ role: 'assistant', content: clean });
  } catch (err) {
    reply.stop();
    // A new chat cancelled this reply: nothing to show
    if (controller.signal.aborted && !timedOut) return;
    console.error('AI chat error:', err);
    const reason = timedOut ? t('ai_timeout', 'The AI stopped answering. Please try again.') : errorMessage(err) || t('error_unknown', 'Unknown error');
    reply.fail(t('ai_error', 'Error: {message}', { message: reason }));
    // Drop the failed question so it can be asked again
    if (aiMessages[aiMessages.length - 1]?.role === 'user') aiMessages.pop();
  } finally {
    clearTimeout(idleTimer);
    if (aiChatAbort === controller) {
      aiChatAbort = null;
      aiStreaming = false;
      setStreaming(false);
      setHeaderSign('calm');
    }
  }
}
