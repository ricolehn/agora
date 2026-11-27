// The AI assistant: its chat page (Extras → AI Support, /ai). Its pure parts are lib/aiReply.ts (the steps of a reply
// and the pacing of its titles) and lib/aiSign.ts (the assistant's sign).
import './ai.css';
import { registerTab } from '../../app/registry';
import { onTabEnter } from '../../app/router';
import { AiChatPage } from './AiChatPage';
import { enterAiChat } from './chat';

registerTab('ai-chat', AiChatPage);
// Opening the chat with no conversation starts a new one; a conversation opens at its end
onTabEnter('ai-chat', enterAiChat);
