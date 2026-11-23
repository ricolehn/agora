// The message field of a chat (a mentoring conversation, the AI chat): one line that grows with its text, then
// scrolls; Ctrl+Enter (⌘+Enter) sends, Enter alone makes a new line. How the field looks is each chat's own.

/** The field's height for its text: one line (24px) up to 110px. */
export function fitChatInput(input: HTMLTextAreaElement | undefined) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.max(24, Math.min(input.scrollHeight, 110))}px`;
}

/** From the field's onKeyDown: Ctrl+Enter or ⌘+Enter runs [send]; true when it did. */
export function onChatInputKey(e: KeyboardEvent, send: () => unknown): boolean {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return false;
  e.preventDefault();
  send();
  return true;
}
