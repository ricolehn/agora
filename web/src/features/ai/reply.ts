// One assistant reply while it streams in (lib/aiReply.ts keeps its steps). A small line on top says what the AI is
// doing right now - "Thinking", the title of its newest thought, or the lookup it runs, in its own words - with the
// seconds; then the answer comes. Afterwards the line says "Thought" and opens on a tap: the thoughts, the notes it
// wrote on the way and the lookups with what they found, in order.
//
// The line stays calm: it is one line high whatever it says, only shows finished titles, keeps each long enough to be
// read and changes with a short fade (its width glides along). The steps open and close with a slide, first as a
// window of a few lines that follows the newest step while the AI works; "Show more" opens them in full. They are
// only drawn while they are open, at most once per frame, so long thoughts cost nothing while nobody looks.
//
// The logic reads its own state at once (`state`, `shownWords`, `shownSteps`); the view (AiReply.tsx) draws the store
// `view` and the lists `words` and `steps` (fresh arrays of unchanged items: the lists keep what did not change), and
// hands in its elements, which the motion measures and animates. All of it runs from frames, timers, handlers and the stream;
// what measures a change waits until it is on the page (onFlush).
import { createSignal, createStore, onFlush } from 'solid-js';
import { euro, t } from '../../app/i18n';
import { newestWins } from '../../app/util';
import {
  createReplyWork, createTitlePacer, liveLabel, lookupFound, lookupTitle, lookupWhat, readingTime, splitAiThinking, type StreamPart, type WorkStep
} from '../../lib/aiReply';
import type { IconName } from '../../ui/Icon';
import type { AiSignState } from './AiSign';
import { aiChatAtEnd, aiChatScroller, aiChatToEnd, chatElements } from './scroll';


/** The words on the line: the current ones last, the ones before still leaving upwards. */
export interface LineWords {
  key: number;
  text: string;
  leaving: boolean;
  /** While the AI works the title ends in "…" (unless it was cut and has one). */
  dots: string;
  /** The shimmer runs on in step from one title to the next (ms, negative). */
  delay: number;
}
export interface StepView {
  kind: 'thought' | 'note' | 'lookup';
  text?: string;
  icon?: IconName;
  title?: string;
  detail?: string;
  running?: boolean;
}
export interface ReplyView {
  /** The AI still works on it (the words shimmer). */
  live: boolean;
  /** Nothing to open yet: no arrow, no toggle. */
  empty: boolean;
  /** The line folded away (a reply without thoughts or lookups only needed it while it waited). */
  gone: boolean;
  folding: boolean;
  open: boolean;
  closing: boolean;
  expanded: boolean;
  seconds: string;
  fadeAbove: boolean;
  fadeBelow: boolean;
  moreHidden: boolean;
  answer: string;
  /** Text that turned out to be a note on the way, folding away from the answer. */
  leavingAnswer: string;
  /** The sign beside the reply: livelier while the AI works, calm while the answer comes, at rest once complete. */
  sign: AiSignState;
  error: string;
  report: { answer: string; prompt: string } | null;
}
export interface ReplyElements {
  details?: HTMLDetailsElement;
  summary?: HTMLElement;
  label?: HTMLElement;
  time?: HTMLElement;
  panel?: HTMLElement;
  steps?: HTMLElement;
  answer?: HTMLElement;
  ghost?: HTMLElement;
}

// The icon of each lookup among the steps
const LOOKUP_ICONS: Record<string, IconName> = {
  payments: 'coin', expenses: 'receipt', donations: 'heart', money: 'coin', members: 'users',
  events: 'calendar', money_totals: 'poll', finance_changes: 'history'
};

// How the line moves: the app's easing (--ease), how long "Thinking" stays at least before the first real title takes
// its place (later titles stay as long as they take to read, readingTime in lib/aiReply.ts), and how long text has to
// be coming in before the line says "Thought" - text the AI writes right before a lookup is only a note on the way,
// and the line should not say "Thought" for half a second in between
const AI_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const AI_FIRST_TITLE_MIN_MS = 400;
const AI_ANSWER_GRACE_MS = 700;
// A thought that is still growing is laid out anew this often at most (ms): fluent to read, and a long one does not
// keep a phone busy with every word
const AI_STEP_TEXT_MS = 90;

const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const moves = (el: Element | undefined): el is HTMLElement => !!el && typeof el.animate === 'function' && !calm() && el.getClientRects().length > 0;

const initialView = (): ReplyView => ({
  live: true, empty: true, gone: false, folding: false, open: false, closing: false, expanded: false,
  seconds: '', fadeAbove: false, fadeBelow: false, moreHidden: true, answer: '', leavingAnswer: '',
  sign: 'thinking', error: '', report: null
});

export function createAiReply() {
  const els: ReplyElements = {};
  const state = initialView();
  const [view, setView] = createStore(initialView());
  const put = (changes: Partial<ReplyView>) => {
    Object.assign(state, changes);
    setView(draft => {
      Object.assign(draft, changes);
    });
  };
  const [words, setWords] = createSignal<LineWords[]>([]);
  let shownWords: LineWords[] = [];
  const putWords = (list: LineWords[]) => {
    shownWords = list;
    setWords(list);
  };
  const [steps, setSteps] = createSignal<StepView[]>([]);
  let shownSteps: StepView[] = [];

  const work = createReplyWork();
  const workSteps = () => work.steps;
  const started = Date.now();
  const thinkingTitle = t('ai_thinking', 'Thinking');
  let complete = false;
  let stopped = false;
  const signState = (live: boolean) => put({ sign: live ? 'thinking' : complete ? 'resting' : 'calm' });

  // --- The line: what it says ---
  let wordKey = 0;
  const wordsOf = (text: string): LineWords => ({
    key: ++wordKey, text, leaving: false, dots: text.endsWith('…') ? '' : '…', delay: -((Date.now() - started) % 1800)
  });
  let lineTitle = '';
  let folded = false;
  let folding: Animation | null = null;
  const foldLine = (away: boolean) => {
    if (away === folded) return;
    folded = away;
    folding?.cancel();
    folding = null;
    const details = els.details;
    if (!away || !moves(details)) {
      put({ gone: away });
      // Back again: with what it says by now
      if (!away && shownWords.at(-1)?.text !== lineTitle) putWords([wordsOf(lineTitle)]);
      return;
    }
    const height = details.getBoundingClientRect().height;
    const marginBottom = getComputedStyle(details).marginBottom;
    put({ folding: true });
    const animation = details.animate([{ height: `${height}px`, marginBottom, opacity: 1 }, { height: '0px', marginBottom: '0px', opacity: 0 }], { duration: 240, easing: AI_EASE });
    folding = animation;
    const done = () => {
      if (folding !== animation) return;
      folding = null;
      put({ folding: false, gone: folded });
    };
    animation.finished.then(done, done);
  };
  const refold = () => foldLine(!state.live && state.empty);

  // (Every title is wanted with its tag: the AI still works, or it is done)
  const showTitle = (text: string, tag: boolean | undefined) => {
    const live = tag === true;
    lineTitle = text;
    put({ live });
    signState(live);
    refold();
    const current = shownWords.at(-1);
    // While it folds away the line keeps its words
    if (folded || current?.text === text) return;
    const next = wordsOf(text);
    const label = els.label;
    if (!current || !moves(label)) {
      putWords([next]);
      return;
    }
    // The old words leave upwards, the new ones come from below, and the line's width glides from one to the other
    const from = label.getBoundingClientRect().width;
    putWords([{ ...current, leaving: true }, next]);
    const drop = () => putWords(shownWords.filter(shown => shown.key !== current.key));
    // Measured and moved once both are on the page (a newer title meanwhile: no move, the old words just go)
    onFlush(() => {
      const [leaving, entering] = Array.from(label.children);
      if (shownWords.at(-1)?.key !== next.key || !leaving || !entering) return drop();
      const to = label.getBoundingClientRect().width;
      leaving.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-60%)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished.then(drop, drop);
      entering.animate([{ opacity: 0, transform: 'translateY(60%)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, delay: 70, easing: AI_EASE, fill: 'backwards' });
      if (Math.abs(to - from) > 0.5) label.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 300, easing: AI_EASE });
    });
  };
  const pacer = createTitlePacer<boolean>(showTitle);
  pacer.want(thinkingTitle, { tag: true });
  signState(true);

  // When the answer began (0: the AI is still working - a lookup after some text makes that text a note again)
  let answeringSince = 0;
  let shownAnswer: string | null = null;
  let frame = 0;
  const schedule = () => {
    if (!frame && !stopped) frame = requestAnimationFrame(draw);
  };
  const seconds = () => Math.max(1, Math.round(((answeringSince || Date.now()) - started) / 1000));
  const showSeconds = () => {
    const first = !state.seconds;
    put({ seconds: t('ai_thinking_seconds', '{n} s', { n: seconds() }) });
    if (!first) return;
    // The seconds do not pop into the line after the first one: they glide in, once they are on the page
    onFlush(() => {
      const time = els.time;
      if (moves(time)) time.animate([{ width: '0px', marginLeft: '-6px', opacity: 0 }, { width: `${time.getBoundingClientRect().width}px`, marginLeft: '0px', opacity: 1 }], { duration: 260, easing: AI_EASE });
    });
  };
  const tick = setInterval(() => {
    if (!answeringSince) showSeconds();
  }, 1000);
  const doneLabel = () => (work.lookups ? t('ai_thought_lookups', 'Thought · looked up {n}×', { n: work.lookups }) : t('ai_thought', 'Thought'));

  // --- The steps ---
  let stepsNow = workSteps();
  const textDrawnAt: number[] = [];
  const stepView = (step: WorkStep, index: number, all: boolean, now: number): StepView | 'waits' => {
    const drawn = shownSteps[index];
    if (step.kind === 'lookup') {
      // The model's words on top, below what was looked up and what was found
      const title = lookupTitle(step.lookup, t);
      const what = lookupWhat(step.lookup, t);
      const next: StepView = {
        kind: 'lookup', icon: LOOKUP_ICONS[step.lookup.tool ?? ''] || 'search', title,
        detail: [title !== what ? what : '', lookupFound(step.done, t, euro)].filter(Boolean).join(' · '), running: !step.done
      };
      const same = drawn?.kind === 'lookup' && drawn.title === next.title && drawn.detail === next.detail && drawn.running === next.running && drawn.icon === next.icon;
      return same ? drawn : next;
    }
    if (drawn?.kind === step.kind && drawn.text === step.text) return drawn;
    if (drawn?.kind === step.kind && !all && now - (textDrawnAt[index] || 0) < AI_STEP_TEXT_MS) return 'waits';
    textDrawnAt[index] = now;
    return { kind: step.kind, text: step.text };
  };
  // The window of the steps: what is hidden above and below fades out, and "Show more" is there while something is
  const fitSteps = () => {
    const list = els.steps;
    if (!state.open || !list) return;
    const above = list.scrollTop;
    const below = list.scrollHeight - list.scrollTop - list.clientHeight;
    put({ fadeAbove: !state.expanded && above > 2, fadeBelow: !state.expanded && below > 2, moreHidden: !state.expanded && above + below <= 2 });
  };
  // [all]: every step as it is now, also while they are closed (when the reply is complete - the search of the browser
  // finds them - and when they are opened)
  const drawSteps = (all = false) => {
    const list = els.steps;
    if ((!state.open && !all) || !list) return;
    // Whoever reads the newest step keeps seeing it; whoever scrolled back stays there
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    const now = Date.now();
    let textWaits = false;
    shownSteps = stepsNow.map((step, index) => {
      const drawn = stepView(step, index, all, now);
      if (drawn !== 'waits') return drawn;
      textWaits = true;
      return shownSteps[index];
    });
    setSteps(shownSteps);
    // Once the steps are on the page: still at the newest one, and the window fitted to them
    onFlush(() => {
      if (follow && state.live) list.scrollTop = list.scrollHeight;
      fitSteps();
    });
    if (textWaits) schedule();
  };

  // Opening and closing slide. While the AI works and the chat is at its end, it stays there (the newest step is what
  // one wants to see); afterwards the line stays where the finger is and the steps open below it.
  let sliding: Animation | null = null;
  const slide = (to: number | null, change: () => void, after?: (pinned: boolean) => void) => {
    const panel = els.panel;
    if (!panel) return;
    const from = panel.getBoundingClientRect().height;
    const pinned = state.live && aiChatAtEnd();
    sliding?.cancel();
    change();
    // What the change put in the view (its last fitSteps: "Show more" shown) is on the page before the panel is
    // measured - else the slide ends short of it and the panel jumps to its height at the end. The change's own steps
    // after drawing came first (onFlush runs them in turn)
    onFlush(() => {
      const height = to === null ? panel.getBoundingClientRect().height : to;
      const finish = () => {
        sliding = null;
        if (pinned) aiChatToEnd();
        after?.(pinned);
      };
      if (!moves(els.summary)) return finish();
      const animation = panel.animate([{ height: `${from}px`, opacity: from ? 1 : 0 }, { height: `${height}px`, opacity: height ? 1 : 0 }], { duration: height > from ? 280 : 220, easing: AI_EASE });
      sliding = animation;
      animation.onfinish = finish;
      const keepAtEnd = () => {
        if (sliding !== animation || !pinned) return;
        aiChatToEnd();
        requestAnimationFrame(keepAtEnd);
      };
      requestAnimationFrame(keepAtEnd);
    });
  };
  // Steps that opened below the edge of the screen (the input lies over it) come up far enough to be seen
  const reveal = (pinned: boolean) => {
    const scroller = aiChatScroller();
    const panel = els.panel;
    if (pinned || !scroller || !panel) return;
    const input = chatElements.inputBar;
    const edge = input ? input.getBoundingClientRect().top : scroller.getBoundingClientRect().bottom;
    const box = panel.getBoundingClientRect();
    const hidden = Math.min(box.bottom, box.top + 150) - (edge - 12);
    if (hidden > 0) scroller.scrollBy({ top: hidden, behavior: calm() ? 'instant' : 'smooth' });
  };
  const setOpen = (open: boolean) => {
    put({ closing: !open });
    if (open) {
      slide(null, () => {
        put({ open: true });
        drawSteps(true);
        // While the AI works the newest step is the one to see, afterwards the steps start at their beginning
        onFlush(() => {
          const list = els.steps;
          if (list) list.scrollTop = state.live ? list.scrollHeight : 0;
          fitSteps();
        });
      }, reveal);
    } else {
      slide(0, () => {}, () => put({ open: false, closing: false, expanded: false }));
    }
  };

  // Text that turned out to be a note on the way (a lookup followed) leaves the answer: it folds away
  const ghostRound = newestWins();
  const foldAway = (text: string) => {
    if (!moves(els.answer)) return put({ answer: '' });
    const isNewest = ghostRound();
    put({ leavingAnswer: text, answer: '' });
    const gone = () => isNewest() && put({ leavingAnswer: '' });
    // It folds away once it stands where the answer was
    onFlush(() => {
      const ghost = els.ghost;
      if (!moves(ghost)) return gone();
      ghost.animate([{ height: `${ghost.getBoundingClientRect().height}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 220, easing: AI_EASE }).finished.then(gone, gone);
    });
    return undefined;
  };

  function draw() {
    frame = 0;
    const { answer, thinking: inline, open } = splitAiThinking(work.content);
    const answering = Boolean(answer) && !open;
    // A <think> block in the current text is the newest thought
    stepsNow = inline ? [...workSteps(), { kind: 'thought', text: inline }] : workSteps();
    put({ empty: !stepsNow.some(step => step.kind !== 'thought' || step.text.trim()) });
    refold();
    drawSteps();
    if (answering && !answeringSince) {
      answeringSince = Date.now();
      showSeconds();
    } else if (!answering && answeringSince) {
      answeringSince = 0;
    }
    if (answering) {
      pacer.want(doneLabel(), { tag: false, delay: AI_ANSWER_GRACE_MS });
    } else {
      // "Thinking" makes room for the first real title soon, and a "Thought" that came too early right away
      const hold = pacer.tag === false ? 0 : pacer.title === thinkingTitle ? AI_FIRST_TITLE_MIN_MS : readingTime(pacer.title);
      pacer.want(liveLabel(work, inline, t) || thinkingTitle, { tag: true, hold });
    }
    if (answer !== shownAnswer) {
      if (!answer && shownAnswer) foldAway(shownAnswer);
      else put({ answer });
      shownAnswer = answer;
    }
  }

  return {
    els,
    view,
    /** The words on the line. */
    words,
    /** The steps as drawn (only while they are open, and in full once the reply is complete). */
    steps,
    /** One event of the stream: drawn with the next frame. */
    add(part: StreamPart) {
      work.add(part);
      schedule();
    },
    /** The text of the answer (what came after the last lookup). */
    get content(): string {
      return work.content;
    },
    /** All thoughts. */
    get reasoning(): string {
      return workSteps().filter(step => step.kind === 'thought').map(step => (step as { text: string }).text).join('');
    },
    /** The reply is complete: last drawing; the line says how long it took (it is gone when there was nothing to show). */
    finish() {
      clearInterval(tick);
      complete = true;
      draw();
      drawSteps(true);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!answeringSince) answeringSince = Date.now();
      showSeconds();
      pacer.want(doneLabel(), { tag: false, hold: 0 });
      signState(false);
    },
    /** Cancelled or failed: nothing moves any more. */
    stop() {
      clearInterval(tick);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      stopped = true;
      pacer.stop();
      put({ live: false });
      complete = true;
      signState(false);
    },
    /** The reply failed: the bubble says why instead. */
    fail(message: string) {
      put({ error: message });
    },
    /** A complete answer can be reported (with the question it answers). */
    allowReport(report: { answer: string; prompt: string }) {
      put({ report });
    },
    /** A tap on the line: opens or closes the steps. */
    toggle(event: MouseEvent) {
      event.preventDefault();
      // A closed "Thinking" line is not a toggle until there is something to show
      if (state.empty) return;
      setOpen(!state.open || state.closing);
    },
    /** "Show more" / "Show less". */
    toggleMore() {
      const expand = !state.expanded;
      const list = els.steps;
      const details = els.details;
      if (!list || !details) return;
      const change = () => {
        put({ expanded: expand });
        onFlush(() => {
          if (!expand) list.scrollTop = 0;
          fitSteps();
        });
      };
      // "Show less" far down in long steps, their beginning scrolled away: back to the line, without a slide
      if (!expand && details.getBoundingClientRect().top < (aiChatScroller()?.getBoundingClientRect().top ?? 0) + 72) {
        sliding?.cancel();
        change();
        onFlush(() => details.scrollIntoView({ block: 'start', behavior: 'instant' }));
      } else {
        slide(null, change);
      }
    },
    /** The steps were opened by the browser (its search found something in them). */
    toggled(open: boolean) {
      if (open !== state.open) put({ open, closing: false });
      fitSteps();
    },
    /** Scrolled, or the screen was turned. */
    fitSteps
  };
}

export type AiReply = ReturnType<typeof createAiReply>;
