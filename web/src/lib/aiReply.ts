// The AI's work on one reply, as the chat shows it (app.js, createAiReply): while it works, one line says what it is
// doing right now - the lookup it runs (in the model's own words when it gave some) or what it is thinking about -
// and afterwards the "Thought" field holds its steps in order: thoughts, the notes it wrote between lookups, and the
// lookups with what they found. The line only ever shows finished titles, each long enough to be read (the pacer at
// the end). Pure functions, tested in tests/frontend.test.js.

/** What a lookup of the server reads (backend/aiTools.js), with the model's own words for it ([step]). */
export interface Lookup {
    id?: number;
    tool?: string;
    from?: string;
    to?: string;
    about?: string;
    step?: string;
}
/** What a finished lookup found: how many of what and the sum, cut short - or why it failed. */
export interface LookupDone {
    id?: number;
    count?: number;
    unit?: string;
    eur?: number;
    cut?: boolean;
    error?: string;
}
/** One event of the answer's stream (backend/routes/ai.js): a piece of the thoughts or the answer, a lookup begun or done. */
export interface StreamPart {
    reasoning?: string;
    content?: string;
    lookup?: Lookup;
    lookupDone?: LookupDone;
}
/** A step of the work on a reply: a thought, a note written on the way, a lookup (done: what it found, null while it runs). */
export type WorkStep = { kind: 'thought' | 'note'; text: string } | { kind: 'lookup'; lookup: Lookup; done: LookupDone | null };
/** The app's translator: a key, its English text and the values of its {placeholders}. */
export type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;
// Without the app: the English text with its placeholders filled in
const english: Translate = (_key, fallback, params) => fallback.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));

/** Splits a reply into the answer and the thought process: reasoning sent apart, or <think>/<thought> blocks in the
 *  text (an unclosed block means the model is still thinking). */
export function splitAiThinking(rawContent: unknown, reasoningContent = ''): { answer: string; thinking: string; open: boolean } {
    let inline = '';
    let open = false;
    const answer = String(rawContent || '').replace(/<(think|thought)>([\s\S]*?)(<\/\1>|$)/gi, (_, _tag: string, inner: string, close: string) => {
        inline += inner;
        if (!close) open = true;
        return '';
    }).replace(/<\/?(?:think|thought)?$|<\/?(?:t|th|thi|thin|tho|thou|thoug|though)$/i, '').trim();
    return { answer, thinking: (reasoningContent + inline).trim(), open };
}

// Interjections a thought often starts with ("Okay, ...", "Gut, ..."): they say nothing about what is being done
const FILLER = /^(?:(?:ok(?:ay)?|so|alright|all right|well|hmm+|right|also|gut|also gut|alles klar|na gut)[,.!:]\s*)+/i;

const plain = (text: unknown) => String(text || '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** [text] cut at a word to at most [max] characters. */
export function shorten(text: string, max = 72): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// A list sign before a line ("- ", "• ", "2. ")
const LIST_SIGN = /^(?:[-•–]|\d+[.)])\s+/;
// A title says something from this many characters on ("Hmm." and "Yes." do not)
const MIN_TITLE = 8;

const titleOf = (text: unknown) => plain(text).replace(LIST_SIGN, '').replace(FILLER, '').replace(/[\s.:;,!?…。-]+$/, '');

/**
 * The finished sentences of [text]: a sentence ends with its line, or with . ! ? … before the next one (which begins
 * with something else than a small letter: "e.g. the" and "3.50" end nothing). [settled]: nothing more comes, so what
 * stands at the end is finished too - otherwise it may still be growing and is left out.
 */
function finishedSentences(text: string, settled: boolean): string[] {
    const sentences: string[] = [];
    let start = 0;
    for (const end of text.matchAll(/[.!?…]+["”“’')\]]*(?=\s+[^a-zäöüßàâçéèêëîïôûùÿñæœ\s])|[。！？]+|\n+/g)) {
        sentences.push(text.slice(start, end.index + end[0].length));
        start = end.index + end[0].length;
    }
    if (settled) sentences.push(text.slice(start));
    return sentences;
}

/**
 * What the model is thinking about, as a short title from its thoughts so far: the newest heading (summarized
 * thoughts put one above every step, "**Calculating the monthly expenses**"), else its newest sentence. Only what is
 * finished counts - a heading whose line is over, a sentence that has ended - so the title never writes itself letter
 * by letter in front of the reader. [settled]: the thoughts are complete, their last line counts as well (false while
 * they are still coming in). '' when there is nothing to say yet.
 */
export function liveTitle(thinking: unknown, { max = 72, settled = true } = {}): string {
    const text = String(thinking || '').slice(-3000);
    if (!text.trim()) return '';
    let title = '';
    const lineEnd = settled ? '(?=\\n|$)' : '(?=\\n)';
    const headings = new RegExp(`(?:^|\\n)[ \\t]*(?:#{1,6}[ \\t]+([^\\n]+)|\\*\\*([^*\\n]{3,120})\\*\\*[ \\t]*)${lineEnd}`, 'g');
    for (const match of text.matchAll(headings)) title = titleOf(match[1] || match[2]);
    if (!title) {
        const sentences = finishedSentences(text, settled);
        for (let index = sentences.length - 1; index >= 0 && !title; index -= 1) {
            const candidate = titleOf(sentences[index]);
            if (candidate.length >= MIN_TITLE) title = candidate;
        }
    }
    if (!title) return '';
    return shorten(title.charAt(0).toUpperCase() + title.slice(1), max);
}

// The lookups the server makes for the AI (backend/aiTools.js), as the chat names them
export const LOOKUP_NAMES: Record<string, string> = {
    payments: 'payments', expenses: 'expenses', donations: 'donations', money: 'money', members: 'members',
    events: 'events', money_totals: 'totals', finance_changes: 'change log', unknown: 'data'
};

/** What a lookup reads ({ tool, from, to, about }): "expenses 2019–2024 “Christmas”". [t]: the app's translator. */
export function lookupWhat(lookup: Lookup = {}, t: Translate = english): string {
    const tool = lookup.tool && Object.hasOwn(LOOKUP_NAMES, lookup.tool) ? lookup.tool : 'unknown';
    const parts = [t(`ai_lookup_${tool}`, LOOKUP_NAMES[tool])];
    const from = typeof lookup.from === 'string' ? lookup.from : '';
    const to = typeof lookup.to === 'string' ? lookup.to : '';
    if (from && to) parts.push(from === to ? from : `${from}–${to}`);
    else if (from) parts.push(t('ai_lookup_since', 'since {from}', { from }));
    else if (to) parts.push(t('ai_lookup_until', 'until {to}', { to }));
    if (typeof lookup.about === 'string' && lookup.about) parts.push(t('ai_lookup_about', '“{about}”', { about: lookup.about }));
    return parts.join(' ');
}

/** A lookup's line: the model's own words for what it does, when it gave some - else what is looked up. */
export function lookupTitle(lookup: Lookup = {}, t?: Translate): string {
    const step = typeof lookup.step === 'string' ? plain(lookup.step) : '';
    return step ? shorten(step.charAt(0).toUpperCase() + step.slice(1), 90) : lookupWhat(lookup, t);
}

// What a lookup counts, in one and in many ("1 entry", "12 entries")
const FOUND: Record<string, [string, string]> = {
    entries: ['{n} entry', '{n} entries'],
    events: ['{n} event', '{n} events'],
    changes: ['{n} change', '{n} changes'],
    members: ['{n} member', '{n} members'],
    periods: ['{n} period', '{n} periods']
};

/** What a finished lookup found ({ count, unit, eur, cut } or { error }): "12 entries · €345.50". */
export function lookupFound(done: LookupDone | null | undefined, t: Translate = english, money: (eur: number) => string = eur => `${eur} €`): string {
    if (!done || typeof done !== 'object') return '';
    if (done.error) return done.error === 'forbidden' ? t('ai_found_forbidden', 'not allowed') : t('ai_found_failed', 'failed');
    const { unit, count, eur } = done;
    if (!unit || !Object.hasOwn(FOUND, unit) || typeof count !== 'number' || !Number.isFinite(count)) return '';
    const one = count === 1;
    const parts = [t(`ai_found_${unit}${one ? '_one' : ''}`, FOUND[unit][one ? 0 : 1], { n: count })];
    if (typeof eur === 'number' && Number.isFinite(eur)) parts.push(money(eur));
    if (done.cut) parts.push(t('ai_found_cut', 'shortened'));
    return parts.join(' · ');
}

/**
 * The steps of one reply, built up from what the server streams: { reasoning } (thoughts), { content } (text),
 * { lookup } and { lookupDone }. Text written before a lookup was a note on the way, not the answer: when the lookup
 * comes, it moves into the steps (with any <think> block in it). [steps]: { kind: 'thought', text } |
 * { kind: 'note', text } | { kind: 'lookup', lookup, done }; [content]: the text of the current round, the answer
 * unless a lookup follows.
 */
/** The work on one reply: its steps, the text of the current round, how many lookups it made. */
export interface ReplyWork {
    readonly steps: WorkStep[];
    readonly content: string;
    readonly lookups: number;
    add(part: StreamPart | null | undefined): void;
}
export function createReplyWork(): ReplyWork {
    const steps: WorkStep[] = [];
    let content = '';
    let lookups = 0;
    return {
        steps,
        get content() { return content; },
        get lookups() { return lookups; },
        add(part) {
            if (!part || typeof part !== 'object') return;
            if (typeof part.reasoning === 'string' && part.reasoning) {
                const last = steps[steps.length - 1];
                if (last?.kind === 'thought') last.text += part.reasoning;
                else steps.push({ kind: 'thought', text: part.reasoning });
            }
            if (typeof part.content === 'string') content += part.content;
            if (part.lookup && typeof part.lookup === 'object') {
                const { answer, thinking } = splitAiThinking(content);
                if (thinking) steps.push({ kind: 'thought', text: thinking });
                if (answer) steps.push({ kind: 'note', text: answer });
                content = '';
                lookups += 1;
                steps.push({ kind: 'lookup', lookup: part.lookup, done: null });
            }
            if (part.lookupDone && typeof part.lookupDone === 'object') {
                const id = part.lookupDone.id;
                for (let index = steps.length - 1; index >= 0; index -= 1) {
                    const step = steps[index];
                    if (step.kind === 'lookup' && !step.done && (id === undefined || step.lookup.id === id)) {
                        step.done = part.lookupDone;
                        break;
                    }
                }
            }
        }
    };
}

/**
 * What the reply's top line says while the AI works: the newest step it is on - a lookup (running, or the last one
 * while the model reads its results), or the title of what it is thinking - '' when nothing is known yet.
 * [inlineThinking]: a <think> block of the current text that is still being written.
 */
export function liveLabel(work: ReplyWork, inlineThinking = '', t?: Translate): string {
    const inline = liveTitle(inlineThinking, { settled: false });
    if (inline) return inline;
    // Only the newest thoughts can still be growing - and not even they once the text of this round has begun
    const growing = work.content ? -1 : work.steps.length - 1;
    for (let index = work.steps.length - 1; index >= 0; index -= 1) {
        const step = work.steps[index];
        if (step.kind === 'lookup') return lookupTitle(step.lookup, t);
        const title = liveTitle(step.text, { settled: step.kind !== 'thought' || index !== growing });
        if (title) return title;
    }
    return '';
}

/** How long a title stays at least before the next one may take its place (ms): the longer it is, the longer it takes to read. */
export const readingTime = (title: string | null | undefined) => Math.min(2600, Math.max(1400, 700 + String(title || '').length * 26));

/**
 * Paces what the top line says: a title stays for at least [minShown] ms before the next one takes its place, and of
 * the titles that come in meanwhile only the newest is shown - a line that changes several times a second cannot be
 * read and makes the page restless. [show](title, tag) puts a title on the line; [now], [later] and [cancel] are the
 * clock (the tests bring their own).
 */
export interface TitlePacer<Tag> {
    /** The title on the line (null: none yet) and its tag. */
    readonly title: string | null;
    readonly tag: Tag | undefined;
    want(title: string, options?: { tag?: Tag; hold?: number; delay?: number }): void;
    stop(): void;
}
interface PacerClock {
    minShown?: number;
    now?: () => number;
    later?: (run: () => void, ms: number) => unknown;
    cancel?: (timer: unknown) => void;
}
export function createTitlePacer<Tag>(
    show: (title: string, tag: Tag | undefined) => void,
    {
        minShown = 1400,
        now = () => Date.now(),
        later = (run, ms) => setTimeout(run, ms),
        cancel = timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
    }: PacerClock = {}
): TitlePacer<Tag> {
    let shown: { title: string; tag: Tag | undefined; at: number } | null = null;
    let next: { title: string; tag: Tag | undefined; since: number; due: number; timer: unknown } | null = null;
    const drop = () => {
        if (next) cancel(next.timer);
        next = null;
    };
    const put = (title: string, tag: Tag | undefined) => {
        drop();
        shown = { title, tag, at: now() };
        show(title, tag);
    };
    return {
        /** The title on the line (null: none yet) and its tag. */
        get title() { return shown ? shown.title : null; },
        get tag() { return shown?.tag; },
        /**
         * The line should say [title] ([tag]: anything the line needs to know with it, e.g. whether the AI still
         * works). [hold]: how long the title before it stays at least; [delay]: how long this one has to be wanted
         * before it shows - a title that is replaced within that time never appears.
         */
        want(title: string, { tag, hold = minShown, delay = 0 }: { tag?: Tag; hold?: number; delay?: number } = {}) {
            if (shown && shown.title === title && shown.tag === tag) return drop();
            const same = next && next.title === title && next.tag === tag;
            const since = same && next ? next.since : now();
            const due = Math.max(shown ? shown.at + hold : 0, since + delay);
            if (due <= now()) return put(title, tag);
            if (same && next?.due === due) return undefined;
            drop();
            next = { title, tag, since, due, timer: later(() => put(title, tag), due - now()) };
            return undefined;
        },
        /** Nothing more is shown (the reply was cancelled). */
        stop: drop
    };
}
