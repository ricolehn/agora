// Entry points of mentoring other parts call.
import { openChatDirect } from './store';

/** Opens the mentoring tab with the conversation [threadId] (from the start page, an address, a notification). */
export function openMentoringChatDirect(threadId: string, source?: string): void {
  void openChatDirect(threadId, source);
}
