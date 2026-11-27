// The open conversation: header (back on phones, partner, menu), the messages, the input or the bar of an ended
// conversation. On phones it replaces the list; opened there, it covers the screen like a page of its own.
import { For, Show, createEffect, onSettled } from 'solid-js';
import { t } from '../../app/i18n';
import { isCurrentUser } from '../../app/session';
import { Button } from '../../ui/Button';
import { fitChatInput, onChatInputKey } from '../../ui/chatInput';
import { Icon } from '../../ui/Icon';
import { onMenuKeyDown } from '../../ui/keys';
import {
  blockCurrentThread, chatFullscreen, chatTime, closeMentoringChatMobile, draft, inChat, menuOpen, pane, paneMessageList, paneThread,
  reportCurrentThread, sendMentoringMessage, sending, setDraft, setMenuOpen, setMessagesElement, threadPartner, toggleChatMenu,
  toggleCloseCurrentThread, type ChatMessage, type SendingMessage
} from './store';

const isClosed = () => paneThread()?.status === 'closed';

export function ChatPane() {
  // Phones: hidden beside the list, the list's place in a chat, the whole screen when opened there
  const layout = () => {
    if (!inChat()) return 'max-md:hidden';
    if (!chatFullscreen()) return 'max-md:w-full';
    return [
      'max-md:fixed max-md:inset-0 max-md:z-[1002] max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0 max-md:bg-bg max-md:shadow-none',
      'max-md:pt-[env(safe-area-inset-top,0px)] max-md:pb-[env(safe-area-inset-bottom,0px)]'
    ];
  };
  return (
    <div
      id="mentoring-chat-pane"
      // mentoring.css: the tab does not slide in under the chat that covers the screen
      data-chat-fullscreen={chatFullscreen() ? '' : undefined}
      class={['flex h-full flex-col overflow-hidden rounded-[20px] border border-border-light bg-surface shadow-card', layout()]}
    >
      <ChatHeader />
      <MessageList />
      <Show when={pane()}>
        <Show when={!isClosed()} fallback={<ClosedBar />}>
          <ChatInput />
        </Show>
      </Show>
    </div>
  );
}

function ChatHeader() {
  const partner = () => threadPartner(paneThread());
  const subtitle = () => {
    if (!pane()) return '';
    if (isClosed()) return t('mentoring_sub_closed', 'Conversation ended');
    return partner().isMentor ? t('mentoring_sub_active_seeker', 'Confidential & Anonymous') : t('mentoring_sub_active_mentee', 'Your confidential mentor');
  };
  return (
    <div
      class={[
        'flex min-h-14 items-center gap-3 border-b border-border-light bg-[var(--frost-surface)] px-[18px] py-3 [backdrop-filter:var(--frost)]',
        { 'max-md:min-h-16 max-md:shrink-0 max-md:bg-bg max-md:px-3 max-md:py-2.5': chatFullscreen() }
      ]}
    >
      <button
        type="button"
        id="mentoring-chat-back-btn"
        title={t('mentoring_back_tooltip', 'Back')}
        aria-label={t('mentoring_back_tooltip', 'Back')}
        class={[
          'hidden items-center justify-center gap-1.5 border bg-surface text-text shadow-card transition-[transform,scale,box-shadow,background-color] duration-200 hover:bg-surface-alt active:scale-[0.97]',
          { 'max-md:inline-flex': inChat() },
          // Full screen: a round button with an arrow; else the small one with the chevron
          chatFullscreen() ? 'size-[42px] min-w-[42px] rounded-full border-border-light p-0' : 'h-9 min-w-9 rounded-lg border-hairline px-2.5 py-1.5 text-[0.82rem] font-bold'
        ]}
        onClick={() => closeMentoringChatMobile()}
      >
        <Icon name="chevronLeftSharp" size={18} strokeWidth={2.5} class={chatFullscreen() ? 'hidden' : 'block'} />
        <Icon name="arrowLeft" size={20} strokeWidth={2.5} class={chatFullscreen() ? 'block' : 'hidden'} />
      </button>
      <div class={['flex flex-1 flex-col gap-px', { 'max-md:min-w-0 max-md:items-start max-md:text-left': chatFullscreen() }]}>
        <div id="mentoring-chat-title" class={['text-[1.05rem] font-extrabold text-text', { 'max-md:text-[1.1rem]': chatFullscreen() }]}>
          {pane() ? partner().name : t('mentoring_no_chat_selected_title', 'No conversation selected')}
        </div>
        <div class="text-[0.78rem] text-text-secondary">{subtitle()}</div>
      </div>
      <Show when={pane()}>
        <ChatMenu />
      </Show>
    </div>
  );
}

const MENU_ITEM =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-[9px] text-left text-[0.88rem] font-semibold transition-[background] duration-150 ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary';
const MENU_DANGER = 'text-danger hover:bg-[rgba(239,68,68,0.12)]';

/**
 * The ⋮ of the open chat: report it, block the other person, end the conversation. A menu for the keyboard too: it opens
 * with the focus on its first entry, the arrows go from entry to entry, Escape and Tab close it (back to the ⋮).
 */
function ChatMenu() {
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const closeToButton = () => {
    setMenuOpen(false);
    button?.focus();
  };
  createEffect(menuOpen, open => {
    if (open) menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  });
  onSettled(() => {
    // A click anywhere else closes the menu
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuOpen() && !button?.contains(target) && !menu?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  });
  return (
    <div class="relative flex items-center gap-2">
      <button
        ref={button}
        type="button"
        title={t('mentoring_chat_options', 'Options')}
        aria-label={t('mentoring_chat_options', 'Options')}
        aria-haspopup="menu"
        aria-expanded={menuOpen() ? 'true' : 'false'}
        class={[
          'inline-flex size-9 items-center justify-center rounded-[10px] border border-border-light bg-surface-alt p-0 text-text-secondary',
          'transition-[transform,scale,background-color,border-color,color] duration-150 hover:border-border hover:bg-[rgba(255,255,255,0.08)] hover:text-text active:scale-[0.97]',
          { 'max-md:size-[42px] max-md:rounded-full': chatFullscreen() }
        ]}
        onClick={e => toggleChatMenu(e)}
      >
        <Icon name="kebab" size={18} strokeWidth={2.5} />
      </button>
      <Show when={menuOpen()}>
        <div
          ref={menu}
          role="menu"
          aria-label={t('mentoring_chat_options', 'Options')}
          class="absolute top-[calc(100%+8px)] right-0 z-[100] min-w-[190px] rounded-xl border border-border bg-surface p-1.5 shadow-[0_10px_25px_rgba(0,0,0,0.25)]"
          onKeyDown={e => onMenuKeyDown(e, closeToButton)}
        >
          <button type="button" role="menuitem" class={[MENU_ITEM, 'text-text hover:bg-surface-alt']} onClick={() => void reportCurrentThread()}>
            <Icon name="flagSharp" size={16} />
            <span>{t('mentoring_chat_report', 'Report conversation')}</span>
          </button>
          {/* Like the Android app: "Report" always; "Block" until blocked, "End" while it is open */}
          <Show when={!paneThread()?.blocked}>
            <button type="button" role="menuitem" class={[MENU_ITEM, MENU_DANGER]} onClick={() => void blockCurrentThread()}>
              <Icon name="block" size={16} />
              <span>{t('mentoring_chat_block', 'Block')}</span>
            </button>
          </Show>
          <Show when={!isClosed()}>
            <button type="button" role="menuitem" class={[MENU_ITEM, MENU_DANGER]} onClick={() => void toggleCloseCurrentThread('closed')}>
              <Icon name="xCircle" size={16} />
              <span>{t('mentoring_chat_end', 'End conversation')}</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function MessageList() {
  const messages = () => {
    const list = paneMessageList();
    return Array.isArray(list) ? list : null;
  };
  return (
    <div
      ref={el => setMessagesElement(el)}
      id="mentoring-chat-messages"
      class={['flex flex-1 flex-col gap-2.5 overflow-y-auto scroll-smooth p-[18px]', { 'max-md:min-h-0 max-md:px-3.5 max-md:py-2': chatFullscreen() }]}
    >
      <Show
        when={pane()}
        fallback={<Notice icon="💬" title={t('mentoring_no_chat_selected_title', 'No conversation selected')} text={t('mentoring_no_chat_selected_desc', 'Select a contact from the list or contact a mentor.')} />}
      >
        <Show when={paneMessageList() !== 'denied'} fallback={<div class="m-auto p-5 text-center text-danger">{t('mentoring_access_denied', 'Access denied (Protected connection).')}</div>}>
          <Show when={messages()?.length === 0 && !sending().length}>
            <Notice icon="✨" title={t('mentoring_no_messages_yet', 'No messages yet')} text={t('mentoring_start_conversation_desc', 'Start the conversation! Everything you write is strictly confidential.')} />
          </Show>
          <For each={messages() || []} keyed={message => message.id}>
            {message => <Bubble message={message()} />}
          </For>
          <For each={sending()}>{entry => <SendingBubble entry={entry} />}</For>
        </Show>
      </Show>
    </div>
  );
}

function Notice(props: { icon: string; title: string; text: string }) {
  return (
    <div class="m-auto px-5 py-[30px] text-center text-text-secondary">
      <div class="mb-2 text-[2rem]">{props.icon}</div>
      <div class="mb-1 font-semibold">{props.title}</div>
      <div class="text-[0.85rem] text-text-secondary">{props.text}</div>
    </div>
  );
}

const MESSAGE = 'flex max-w-[78%] flex-col max-md:max-w-[88%]';
const BUBBLE = 'whitespace-pre-wrap px-[15px] py-2.5 text-[0.92rem] leading-[1.45] [word-break:break-word]';
const MINE = 'rounded-[18px_18px_4px_18px] bg-gradient-primary text-white shadow-[0_2px_6px_rgba(var(--glow-rgb),0.22)]';
const TIME = 'mt-[3px] px-1 text-[0.68rem] text-text-secondary';

function Bubble(props: { message: ChatMessage }) {
  const mine = () => isCurrentUser(props.message.sender);
  return (
    <div class={[MESSAGE, mine() ? 'items-end self-end' : 'items-start self-start']}>
      <Show when={!mine()}>
        <div class="mb-0.5 px-1 text-[0.74rem] font-bold text-primary-dark dark:text-primary">
          {props.message.sender_name || t('mentoring_partner_generic', 'Conversation partner')}
        </div>
      </Show>
      <div class={[BUBBLE, mine() ? MINE : 'rounded-[18px_18px_18px_4px] border border-border-light bg-surface-alt text-text shadow-[0_1px_3px_rgba(0,0,0,0.04)]']}>
        {props.message.message || props.message.text || ''}
      </div>
      <div class={TIME}>{chatTime(props.message.created)}</div>
    </div>
  );
}

/** The own message while it is on its way (as before: with the time and "Sending…"). */
function SendingBubble(props: { entry: SendingMessage }) {
  return (
    <div class={[MESSAGE, 'items-end self-end']}>
      <div class={[BUBBLE, MINE]}>{props.entry.text}</div>
      <div class={TIME}>
        {props.entry.time} • {t('mentoring_sending_optimistic', 'Sending…')}
      </div>
    </div>
  );
}

/** The field grows with its text (up to about five lines). */
function ChatInput() {
  let input: HTMLTextAreaElement | undefined;
  createEffect(
    () => [draft(), pane()?.id],
    () => fitChatInput(input)
  );
  return (
    <div class={['border-t border-border-light bg-surface px-[18px] py-3', chatFullscreen() ? 'max-md:shrink-0 max-md:px-3 max-md:py-2' : 'max-md:px-3 max-md:py-2.5']}>
      <div class="flex items-center gap-2 rounded-3xl border-[1.5px] border-border bg-surface-alt py-[5px] pr-1.5 pl-4 transition-[border-color,box-shadow] duration-200 focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(var(--brand-rgb),0.15)]">
        <textarea
          ref={el => (input = el)}
          id="mentoring-chat-input"
          rows={1}
          value={draft()}
          placeholder={t('mentoring_chat_input_placeholder', 'Write a confidential message…')}
          title={t('chat_enter_hint', 'Enter for new line, Ctrl+Enter to send')}
          class="m-0 block h-6 max-h-[110px] min-h-6 flex-1 resize-none border-none bg-transparent p-0 font-[inherit] text-[0.95rem] leading-6 text-text shadow-none outline-none"
          onInput={e => setDraft(e.currentTarget.value)}
          onKeyDown={e => onChatInputKey(e, () => void sendMentoringMessage())}
        />
        <button
          type="button"
          id="mentoring-send-btn"
          title={t('mentoring_chat_send_tooltip', 'Send message')}
          aria-label={t('mentoring_chat_send_label', 'Send')}
          class={[
            'flex size-9 min-w-9 shrink-0 items-center justify-center rounded-full border-none bg-gradient-primary text-white transition-[transform,scale,box-shadow] duration-150',
            'shadow-[0_2px_6px_rgba(var(--glow-rgb),0.3)] hover:scale-105 hover:bg-gradient-hover hover:shadow-[0_3px_10px_rgba(var(--glow-rgb),0.4)] active:scale-95'
          ]}
          onClick={() => void sendMentoringMessage()}
        >
          <Icon name="send" size={18} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

/** An ended (or blocked) conversation: why, and "Reopen" for whoever may (a block only by the one who blocked). */
function ClosedBar() {
  const text = () => {
    const thread = paneThread();
    if (!thread?.blocked) return t('mentoring_chat_closed_info', 'This conversation has ended.');
    return thread.blockedByMe ? t('mentoring_chat_blocked_by_me', 'You blocked this conversation.') : t('mentoring_chat_blocked', 'This conversation has been blocked.');
  };
  return (
    <div
      class={[
        'flex items-center justify-between gap-3 border-t border-border-light bg-surface px-[18px] py-3.5 max-md:flex-col max-md:items-stretch max-md:gap-2.5',
        chatFullscreen() ? 'max-md:shrink-0 max-md:px-3.5 max-md:py-2.5' : 'max-md:px-3.5 max-md:py-3'
      ]}
    >
      <div class="flex items-center gap-2 text-[0.88rem] font-medium text-text-secondary max-md:justify-center max-md:text-center">
        <Icon name="alert" size={18} class="shrink-0 text-[#f59e0b]" />
        <span>{text()}</span>
      </div>
      <Show when={!paneThread()?.blocked || paneThread()?.blockedByMe}>
        <Button size="small" class="max-md:h-[42px] max-md:w-full" onClick={() => void toggleCloseCurrentThread('active')}>
          <Icon name="undo" size={15} />
          <span>{t('mentoring_chat_reopen', 'Reopen')}</span>
        </Button>
      </Show>
    </div>
  );
}
