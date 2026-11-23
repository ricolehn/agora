// An assistant reply in the chat: its sign beside it, the thinking line that opens to the steps, the answer and
// "Report reply". reply.ts keeps its state and moves it; this draws it and hands it the elements it measures.
import type { JSX } from '@solidjs/web';
import { For, Show, createEffect, createSignal, onSettled } from 'solid-js';
import { t } from '../../app/i18n';
import { sendReport } from '../../app/reports';
import { showToast } from '../../app/toast';
import { Icon } from '../../ui/Icon';
import { renderMarkdown } from '../../ui/markdown';
import { AiSign } from './AiSign';
import type { AiReply, StepView } from './reply';

// Words the AI is still working on: a light in the sign's lagoon runs through them ([--shimmer] is their colour)
const SHIMMER = 'bg-[linear-gradient(90deg,var(--shimmer)_0%,var(--shimmer)_35%,#2d625b_50%,var(--shimmer)_65%,var(--shimmer)_100%)] dark:bg-[linear-gradient(90deg,var(--shimmer)_0%,var(--shimmer)_35%,#b5ddd5_50%,var(--shimmer)_65%,var(--shimmer)_100%)] bg-[length:250%_100%] bg-clip-text text-transparent animate-[aiShimmer_1.8s_linear_infinite] motion-reduce:animate-none';
// A small arrow drawn by two borders of a turned square (the line's and "Show more"'s); it turns up when open
const ARROW = "after:box-content after:content-[''] after:border-current after:transition-[rotate,margin,width,border-width,opacity] after:duration-[250ms] after:ease-app";
const ARROW_SHOWN = 'after:border-r-[1.6px] after:border-b-[1.6px] after:opacity-70';

/** Markdown of the model, drawn with DOM nodes only (the app's renderer, as for event descriptions) into this
 *  element - the model's text never goes through innerHTML (ai.css styles the blocks). */
function Markdown(props: { text: string; class?: JSX.HTMLAttributes<HTMLDivElement>['class']; ref?: (el: HTMLDivElement) => void }) {
  let el!: HTMLDivElement;
  createEffect(
    () => props.text,
    text => el.replaceChildren(...renderMarkdown(text))
  );
  return (
    <div
      ref={node => {
        el = node;
        props.ref?.(node);
      }}
      class={props.class}
    />
  );
}

function ReplyStep(props: { step: StepView; live: boolean }) {
  return (
    <div class={['min-w-0 flex-none', { 'flex items-start gap-[9px]': props.step.kind === 'lookup' }]}>
      <Show
        when={props.step.kind === 'lookup'}
        fallback={<Markdown class={['ai-step-text [overflow-wrap:anywhere]', { 'text-text': props.step.kind === 'note' }]} text={(props.step.text ?? '').trim()} />}
      >
        <span class="mt-px inline-flex size-[22px] flex-[0_0_auto] items-center justify-center rounded-[7px] bg-[color-mix(in_srgb,#2d6a62_12%,var(--surface))] text-[#2d625b] dark:bg-[color-mix(in_srgb,#2d6a62_26%,var(--surface))] dark:text-[#8fc2b9]">
          <Icon name={props.step.icon ?? 'search'} size={13} />
        </span>
        <div class="min-w-0">
          <div class={['font-medium [overflow-wrap:anywhere]', props.live && props.step.running ? ['[--shimmer:var(--text)]', SHIMMER] : 'text-text']}>{props.step.title}</div>
          <div class="mt-px text-[0.78rem] text-text-secondary [overflow-wrap:anywhere] empty:hidden">{props.step.detail}</div>
        </div>
      </Show>
    </div>
  );
}

/** The line and the steps it opens to. */
function ThinkingLine(props: { reply: AiReply }) {
  const view = () => props.reply.view;
  onSettled(() => {
    // The screen was turned or the steps grew: their window and "Show more" follow
    const observer = new ResizeObserver(() => props.reply.fitSteps());
    if (props.reply.els.panel) observer.observe(props.reply.els.panel);
    return () => observer.disconnect();
  });
  return (
    <details
      ref={el => (props.reply.els.details = el)}
      open={view().open}
      // scroll-margin: scrolled back to, the line stays clear of the header that slides in from the top
      class={['mb-2.5 scroll-mt-[88px]', { hidden: view().gone, 'pointer-events-none overflow-hidden': view().folding }]}
      onToggle={e => props.reply.toggled(e.currentTarget.open)}
    >
      <summary
        ref={el => (props.reply.els.summary = el)}
        class={[
          // One line whatever it says: a long title ends in "…", the seconds and the arrow never move to a second line
          'relative box-border inline-flex min-h-[30px] max-w-full touch-manipulation list-none items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline bg-surface py-1 pr-2.5 pl-[11px] text-[0.8rem] leading-[1.5] font-semibold text-text-secondary select-none transition-[background-color,color,scale] duration-200 ease-app [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
          // A finger needs more room than the line is high
          "before:absolute before:-inset-x-1.5 before:-top-2 before:-bottom-1.5 before:content-['']",
          ARROW,
          'after:h-1.5 after:flex-none',
          view().empty
            // Nothing to open yet: no arrow (it takes no room either, and glides in when the first step is there)
            ? 'cursor-default after:mr-0 after:-ml-1.5 after:w-0 after:border-0 after:opacity-0'
            : ['cursor-pointer after:mr-px after:ml-0.5 after:w-1.5 hover:bg-surface-alt hover:text-text active:scale-[0.98] active:bg-surface-alt active:duration-100', ARROW_SHOWN],
          view().open && !view().closing ? 'after:mt-[3px] after:-rotate-135' : 'after:-mt-0.5 after:rotate-45'
        ]}
        onClick={e => props.reply.toggle(e)}
      >
        {/* The words change inside the label: the old ones leave upwards (out of the flow, so the label is as wide
            as the new ones), the new ones come from below */}
        <span ref={el => (props.reply.els.label = el)} class="relative block min-w-0 flex-[0_1_auto] overflow-hidden">
          <For each={props.reply.words()} keyed={words => words.key}>
            {words => (
              <span
                class={[
                  'block text-ellipsis whitespace-nowrap',
                  words().leaving ? 'absolute top-0 left-0 overflow-visible' : 'overflow-hidden',
                  { [`[--shimmer:var(--text-secondary)] ${SHIMMER} after:content-[attr(data-dots)]`]: view().live }
                ]}
                data-dots={words().dots}
                style={{ 'animation-delay': `${words().delay}ms` }}
              >
                {words().text}
              </span>
            )}
          </For>
        </span>
        <span
          ref={el => (props.reply.els.time = el)}
          class="flex-none overflow-hidden font-medium tabular-nums empty:hidden before:mr-1.5 before:opacity-60 before:content-['·']"
        >
          {view().seconds}
        </span>
      </summary>
      <div ref={el => (props.reply.els.panel = el)} class="overflow-hidden">
        {/* The steps open as a window of a few lines (what is hidden above or below fades out, a finger scrolls it);
            "Show more" opens them in full, as part of the page */}
        <div
          ref={el => (props.reply.els.steps = el)}
          class={[
            'mt-2.5 ml-1.5 flex flex-col gap-2.5 border-l-2 border-[rgba(210,164,110,0.6)] py-0.5 pl-3.5 text-[0.84rem] leading-[1.55] text-text-secondary [scrollbar-width:thin] dark:border-[rgba(217,188,143,0.5)]',
            '[mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--fade-above),#000_calc(100%_-_var(--fade-below)),transparent_100%)]',
            view().fadeAbove ? '[--fade-above:26px]' : '[--fade-above:0px]',
            view().fadeBelow ? '[--fade-below:26px]' : '[--fade-below:0px]',
            view().expanded ? 'max-h-none overflow-visible' : 'max-h-[232px] overflow-y-auto min-[768px]:max-h-[320px]'
          ]}
          onScroll={() => props.reply.fitSteps()}
        >
          <For each={props.reply.steps()} keyed={false}>
            {step => <ReplyStep step={step()} live={view().live} />}
          </For>
        </div>
        <button
          type="button"
          hidden={view().moreHidden}
          aria-expanded={view().expanded ? 'true' : 'false'}
          class={[
            "relative mt-2 ml-[22px] inline-flex touch-manipulation items-center gap-[7px] border-0 bg-transparent py-0.5 text-[0.8rem] leading-[1.5] font-semibold text-text-secondary transition-colors duration-200 ease-app before:absolute before:-inset-x-3 before:-inset-y-2.5 before:content-[''] hover:text-text active:text-text focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary",
            ARROW,
            ARROW_SHOWN,
            'after:size-[5px]',
            view().expanded ? 'after:mt-[3px] after:-rotate-135' : 'after:-mt-[3px] after:rotate-45'
          ]}
          onClick={() => props.reply.toggleMore()}
        >
          {view().expanded ? t('ai_steps_less', 'Show less') : t('ai_steps_more', 'Show more')}
        </button>
      </div>
    </details>
  );
}

/** "Report reply" under a finished answer: sends it with the question to the admins (Google Play AI content policy). */
function ReportButton(props: { answer: string; prompt: string }) {
  const [sent, setSent] = createSignal(false);
  const report = async () => {
    try {
      const question = t('ai_report_reason', 'What is wrong with this reply? (optional)');
      if (await sendReport(question, { type: 'ai', content: props.answer, prompt: props.prompt })) setSent(true);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };
  return (
    <button
      type="button"
      disabled={sent()}
      class="mt-2 inline-flex items-center gap-1.5 rounded-full border border-hairline bg-transparent px-2.5 py-1 text-[0.75rem] leading-[normal] font-semibold text-text-secondary opacity-70 transition-[color,border-color] duration-150 enabled:hover:border-danger enabled:hover:text-danger disabled:cursor-default"
      onClick={report}
    >
      <Icon name="flag" size={13} />
      <span>{sent() ? t('report_sent', 'Reported – thank you!') : t('ai_report', 'Report reply')}</span>
    </button>
  );
}

/** A reply's row: the sign, then the reply (or why it failed). */
export function AiReplyRow(props: { reply: AiReply; seed: number; afterWelcome: boolean }) {
  const view = () => props.reply.view;
  return (
    <div
      class={[
        'flex max-w-full origin-top-left items-start gap-2.5',
        props.afterWelcome ? 'animate-[aiMsgIn_0.36s_var(--ease)_0.22s_backwards]' : 'animate-[aiMsgIn_0.36s_var(--ease)_backwards]'
      ]}
    >
      <AiSign size={28} seed={props.seed} state={view().sign} class="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-primary" />
      <div
        class={[
          'ai-chat-bubble-assistant min-w-0 flex-1 pt-1 text-[0.95rem] leading-[1.6] break-words',
          view().error
            ? 'self-start rounded-2xl border border-[color-mix(in_srgb,var(--danger)_20%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))] px-3.5 pb-2.5 text-danger'
            : 'text-text'
        ]}
      >
        <Show when={!view().error} fallback={view().error}>
          <ThinkingLine reply={props.reply} />
          <Show when={view().leavingAnswer}>
            <Markdown ref={el => (props.reply.els.ghost = el)} class="ai-answer pointer-events-none overflow-hidden" text={view().leavingAnswer} />
          </Show>
          <Markdown ref={el => (props.reply.els.answer = el)} class="ai-answer empty:hidden" text={view().answer} />
          <Show when={view().report}>{report => <ReportButton answer={report().answer} prompt={report().prompt} />}</Show>
        </Show>
      </div>
    </div>
  );
}
