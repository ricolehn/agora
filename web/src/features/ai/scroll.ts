// The chat page's elements the chat and its replies measure, and how the chat scrolls: with its page - the list of
// the messages has no height of its own, the input bar is fixed below it.
import { activeTab } from '../../app/router';
import { scrollContainer } from '../../app/shell';

/** Set by the page (AiChatPage.tsx). */
export const chatElements: { messages?: HTMLElement; input?: HTMLTextAreaElement; inputBar?: HTMLElement } = {};

/** What scrolls the chat - only while it is the open page (a reply that still comes in must not scroll another one). */
export function aiChatScroller(): HTMLElement | null {
  if (activeTab() !== 'ai-chat') return null;
  const messages = chatElements.messages;
  return messages && messages.scrollHeight > messages.clientHeight + 1 ? messages : scrollContainer();
}

/** Whoever reads the end of the chat keeps seeing it while a reply grows; whoever scrolled back stays there. */
export function aiChatAtEnd(): boolean {
  const scroller = aiChatScroller();
  return Boolean(scroller) && scroller!.scrollHeight - scroller!.scrollTop - scroller!.clientHeight < 120;
}

/** Right away: the page scrolls softly by itself (scroll-behavior), which would trail behind a growing reply. */
export function aiChatToEnd() {
  const scroller = aiChatScroller();
  scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
}
