// The AI chat page (Extras → AI Support): header with the assistant's sign and "New chat", the conversation with a
// friendly start page, and the input fixed at the bottom (above the navigation on phones). The chat scrolls with its
// page; chat.ts keeps the conversation.
import { For, Show } from 'solid-js';
import { t } from '../../app/i18n';
import { switchTab, tabSlide } from '../../app/router';
import { canViewFinances, currentUser } from '../../app/session';
import { fullName } from '../../app/util';
import { Icon, type IconName } from '../../ui/Icon';
import { AiReplyRow } from './AiReply';
import { AiSign } from './AiSign';
import {
  adjustAiInputHeight, askAi, chatRound, clearAiChat, entries, headerSign, onAiInputKey, sendAiMessage, streaming,
  welcome, welcomeGone
} from './chat';
import { chatElements } from './scroll';

// The page's parts come in like a page of the app; the tab itself stays still (its input bar is fixed, and a moving
// tab would carry it along), the input bar only fades in
const slideIn = () => (tabSlide() === 'left' ? 'animate-slide-in-left' : 'animate-slide-in-right');

const ADMIN_IDEAS = ['Who is behind with their fee?', 'What is coming up this week?', 'Which requests are still open?'];
const MEMBER_IDEAS = ['Until when is my fee paid?', 'What is coming up this week?', 'Where am I on duty next?'];
// The suggestions in the sign's lagoon and sand, and stone
const IDEA_COLORS = ['#2d6a62', '#a8743f', '#6d6861'];

function ChatHeader() {
  return (
    <div class={['flex shrink-0 items-center gap-2 pt-3 pb-2.5 font-bold max-md:pt-2.5 max-md:pb-3', slideIn()]}>
      <button
        type="button"
        class="mr-1 inline-flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border-light bg-surface-alt text-text"
        aria-label={t('btn_back', 'Back')}
        onClick={() => switchTab('hub')}
      >
        <Icon name="chevronLeft" size={20} strokeWidth={2.4} />
      </button>
      <span class="flex min-w-0 flex-1 items-center gap-2.5 text-[1.15rem] font-bold tracking-[-0.02em]">
        <AiSign size={28} state={headerSign()} class="inline-flex size-7 shrink-0" />
        <span>{t('nav_ai', 'AI Support')}</span>
      </span>
      <button
        type="button"
        class="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 py-1.5 text-[0.86rem] font-semibold text-text shadow-card hover:bg-surface-alt"
        title={t('ai_new_chat', 'New chat')}
        onClick={() => clearAiChat()}
      >
        <Icon name="compose" size={16} strokeWidth={2.2} />
        <span>{t('ai_new_chat', 'New chat')}</span>
      </button>
    </div>
  );
}

/** A new chat's start: a greeting and three questions the assistant can answer (members, finances, requests, events). */
function Welcome() {
  const admin = () => canViewFinances();
  const firstName = () => {
    const user = currentUser();
    return (user?.firstName || fullName(user) || user?.name || '').trim().split(/\s+/)[0];
  };
  const ideas = () =>
    [1, 2, 3].map(n => (admin() ? t(`ai_suggest_admin_${n}`, ADMIN_IDEAS[n - 1]) : t(`ai_suggest_member_${n}`, MEMBER_IDEAS[n - 1])));
  const ideaIcon = (index: number): IconName => (admin() ? (['coin', 'calendar', 'clipboard'] as const) : (['coin', 'calendar', 'user'] as const))[index];
  const leaving = () => welcome() === 'leaving';
  return (
    <div
      class={[
        'flex flex-1 flex-col items-center justify-center px-1 pt-7 pb-6 text-center text-text-secondary',
        // The first message: the start page fades upwards over it and makes room
        { 'pointer-events-none absolute inset-0 animate-[aiWelcomeOut_0.34s_var(--ease)_forwards]': leaving() }
      ]}
      onAnimationEnd={e => e.target === e.currentTarget && welcomeGone()}
    >
      {/* The sign only fades in: it never turns */}
      <AiSign size={76} class="mb-[22px] flex animate-[aiWelcomeSign_0.45s_cubic-bezier(0.4,0,0.2,1)_backwards]" />
      <h2 class="m-0 flex animate-[aiWelcomeUp_0.6s_var(--ease)_0.08s_backwards] flex-col gap-0.5 text-[1.75rem] leading-[1.2] font-[750] tracking-[-0.03em] text-text">
        <Show when={firstName()}>
          <span class="text-[1.05rem] font-semibold tracking-[-0.01em] text-text-secondary">{t('ai_chat_hi_name', 'Hi {name},', { name: firstName() })}</span>
        </Show>
        <span class="pb-0.5 text-text dark:text-[#e4ded6]">{t('ai_chat_hello', 'How can I help?')}</span>
      </h2>
      <p class="mt-2.5 mb-0 max-w-[360px] animate-[aiWelcomeUp_0.6s_var(--ease)_0.14s_backwards] text-[0.93rem] leading-[1.5]">
        {admin() ? t('ai_chat_welcome_sub', 'Ask about members, finances, events or duties.') : t('ai_chat_welcome_sub_member', 'Ask about events, duties, your fee or how the app works.')}
      </p>
      {/* Wider screens: three cards side by side, the question below its sign */}
      <div class="mt-[26px] grid w-full max-w-[420px] grid-cols-1 gap-2.5 sm:max-w-[640px] sm:grid-cols-3 sm:gap-3">
        <For each={ideas()}>
          {(idea, index) => (
            <button
              type="button"
              class="group/idea relative flex min-w-0 animate-[aiWelcomeUp_0.55s_var(--ease)_calc(0.22s_+_var(--i)_*_0.07s)_backwards] items-center gap-3 rounded-[18px] border border-hairline bg-surface py-3 pr-3.5 pl-3 text-left text-[0.9rem] leading-[1.35] font-[550] text-text shadow-card transition-[transform,border-color,box-shadow,background-color] duration-[250ms] ease-app hover:[transform:translateY(-2px)] hover:border-[color-mix(in_srgb,var(--c)_35%,var(--hairline))] hover:shadow-card-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:[transform:scale(0.98)] active:duration-100 sm:min-h-32 sm:flex-col sm:items-start sm:gap-3.5 sm:p-4"
              style={{ '--i': String(index()), '--c': IDEA_COLORS[index()] }}
              onClick={() => askAi(idea)}
            >
              <span class="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--c)_13%,var(--surface))] text-(--c) dark:bg-[color-mix(in_srgb,var(--c)_22%,var(--surface))] dark:text-[color-mix(in_srgb,var(--c)_70%,#ffffff)]">
                <Icon name={ideaIcon(index())} size={17} />
              </span>
              <span class="min-w-0 flex-1">{idea}</span>
              <Icon
                name="arrowUpRight"
                size={16}
                strokeWidth={2.2}
                class="shrink-0 text-text-secondary opacity-50 transition-[transform,opacity,color] duration-[250ms] ease-app group-hover/idea:[transform:translate(2px,-2px)] group-hover/idea:text-(--c) group-hover/idea:opacity-100 sm:absolute sm:top-4 sm:right-3.5"
              />
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function ChatInput() {
  return (
    <div
      ref={el => (chatElements.inputBar = el)}
      class="fixed z-[1001] animate-[aiChatFadeIn_0.4s_cubic-bezier(0.25,1,0.5,1)] bg-(--frost-surface) backdrop-blur-[14px] backdrop-saturate-150 max-md:inset-x-0 max-md:bottom-[calc(var(--mobile-bottom-nav-offset)-1px)] max-md:border-t max-md:border-hairline max-md:px-3 max-md:pt-2 max-md:pb-2.5 md:bottom-5 md:left-1/2 md:w-[calc(100%-40px)] md:max-w-[760px] md:-translate-x-1/2 md:rounded-[18px] md:border md:border-hairline md:px-[18px] md:py-3 md:shadow-card-md"
    >
      {/* One rounded field; the send button turns teal once there is text */}
      <div class="group/input box-border flex items-center gap-2 rounded-3xl border border-hairline bg-surface py-[5px] pr-1.5 pl-4 shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-[rgba(var(--brand-rgb),0.45)] focus-within:shadow-ring">
        <textarea
          ref={el => (chatElements.input = el)}
          rows={1}
          class="m-0 block h-6 min-h-6 flex-1 resize-none border-none bg-transparent p-0 text-[0.95rem] leading-6 text-text shadow-none outline-none"
          placeholder={t('ai_chat_input_placeholder', 'Type a message…')}
          title={t('chat_enter_hint', 'Enter for new line, Ctrl+Enter to send')}
          aria-label={t('ai_chat_input_aria', 'Enter a message for the AI')}
          onKeyDown={onAiInputKey}
          onInput={e => adjustAiInputHeight(e.currentTarget)}
        />
        <button
          type="button"
          class="flex size-9 min-w-9 shrink-0 items-center justify-center rounded-full border-none bg-gradient-primary p-0 text-white transition-transform duration-150 hover:scale-105 active:scale-95 group-has-[textarea:placeholder-shown]/input:bg-surface-alt group-has-[textarea:placeholder-shown]/input:bg-none group-has-[textarea:placeholder-shown]/input:text-text-secondary"
          disabled={streaming()}
          aria-label={t('ai_chat_send_tooltip', 'Send message')}
          title={t('ai_chat_send_tooltip', 'Send message')}
          onClick={() => void sendAiMessage()}
        >
          <Icon name="send" size={18} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

export function AiChatPage() {
  return (
    <div class="flex min-h-0 flex-col md:mx-auto md:max-w-[760px] md:pb-[100px]">
      <ChatHeader />
      {/* Room for the glow of a thinking sign beside a reply: the list clips what reaches beyond it */}
      <div
        ref={el => (chatElements.messages = el)}
        class={[
          'relative -mx-3 flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-3 pt-3 pb-5 max-md:pb-[calc(var(--mobile-ai-chat-input-height)+var(--mobile-bottom-nav-offset)+16px)]',
          slideIn()
        ]}
      >
        {/* Every new chat draws its start page anew (keyed: a new round, a new one): its entrance plays again */}
        <Show when={welcome() !== 'gone' && chatRound()} keyed>
          <Welcome />
        </Show>
        <For each={entries()}>
          {entry =>
            entry.role === 'user' ? (
              <div
                class={[
                  'max-w-[82%] origin-bottom-right self-end rounded-[20px_20px_6px_20px] border border-[rgba(var(--brand-rgb),0.16)] bg-[color-mix(in_srgb,var(--brand)_13%,var(--surface))] px-[15px] py-2.5 text-[0.95rem] leading-[1.6] break-words whitespace-pre-wrap text-text',
                  entry.afterWelcome ? 'animate-[aiMsgIn_0.36s_var(--ease)_0.14s_backwards]' : 'animate-[aiMsgIn_0.36s_var(--ease)_backwards]'
                ]}
              >
                {entry.text}
              </div>
            ) : (
              <AiReplyRow reply={entry.reply} seed={entry.seed} afterWelcome={entry.afterWelcome} />
            )
          }
        </For>
      </div>
      <ChatInput />
    </div>
  );
}
