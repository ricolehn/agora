// The AI's work on one reply, as the chat shows it (app.js, createAiReply): while it works, one line says what it is
// doing right now - the lookup it runs (in the model's own words when it gave some) or what it is thinking about -
// and afterwards the "Thought" field holds its steps in order: thoughts, the notes it wrote between lookups, and the
// lookups with what they found. Pure functions, tested in tests/frontend.test.js.

/** Splits a reply into the answer and the thought process: reasoning sent apart, or <think>/<thought> blocks in the
 *  text (an unclosed block means the model is still thinking). */
export function splitAiThinking(rawContent, reasoningContent = '') {
    let inline = '';
    let open = false;
    const answer = String(rawContent || '').replace(/<(think|thought)>([\s\S]*?)(<\/\1>|$)/gi, (_, tag, inner, close) => {
        inline += inner;
        if (!close) open = true;
        return '';
    }).replace(/<\/?(?:think|thought)?$|<\/?(?:t|th|thi|thin|tho|thou|thoug|though)$/i, '').trim();
    return { answer, thinking: (reasoningContent + inline).trim(), open };
}

// Interjections a thought often starts with ("Okay, ...", "Gut, ..."): they say nothing about what is being done
const FILLER = /^(?:(?:ok(?:ay)?|so|alright|all right|well|hmm+|right|also|gut|also gut|alles klar|na gut)[,.!:]\s*)+/i;

const plain = (text) => String(text || '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** [text] cut at a word to at most [max] characters. */
export function shorten(text, max = 72) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * What the model is thinking about right now, as a short title from its thoughts so far: the newest heading
 * (summarized thoughts put one above every step, "**Calculating the monthly expenses**"), else its newest sentence -
 * the one it is writing once it says something, else the last one it finished. '' when there is nothing to say yet.
 */
export function liveTitle(thinking, max = 72) {
    const text = String(thinking || '').slice(-3000);
    if (!text.trim()) return '';
    let title = '';
    for (const match of text.matchAll(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]+([^\n]+)|\*\*([^*\n]{3,120})\*\*[ \t]*(?=\n|$))/g)) {
        title = match[1] || match[2];
    }
    if (!title) {
        const sentences = text.replace(/\s+/g, ' ').match(/[^.!?…]+(?:[.!?…]+|$)/g) || [];
        const last = (sentences[sentences.length - 1] || '').trim();
        const finished = /[.!?…]$/.test(last);
        title = !finished && last.length < 24 && sentences.length > 1 ? sentences[sentences.length - 2] : last;
    }
    title = plain(title).replace(FILLER, '').replace(/[\s.:;,!?…-]+$/, '');
    if (!title) return '';
    return shorten(title.charAt(0).toUpperCase() + title.slice(1), max);
}

// The lookups the server makes for the AI (backend/aiTools.js), as the chat names them
export const LOOKUP_NAMES = {
    payments: 'payments', expenses: 'expenses', donations: 'donations', money: 'money', members: 'members',
    events: 'events', money_totals: 'totals', finance_changes: 'change log', unknown: 'data'
};

/** What a lookup reads ({ tool, from, to, about }): "expenses 2019–2024 “Christmas”". [t]: the app's translator. */
export function lookupWhat(lookup = {}, t = (key, fallback, params) => fallback.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? '')) {
    const tool = Object.hasOwn(LOOKUP_NAMES, lookup.tool) ? lookup.tool : 'unknown';
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
export function lookupTitle(lookup = {}, t) {
    const step = typeof lookup.step === 'string' ? plain(lookup.step) : '';
    return step ? shorten(step.charAt(0).toUpperCase() + step.slice(1), 90) : lookupWhat(lookup, t);
}

// What a lookup counts, in one and in many ("1 entry", "12 entries")
const FOUND = {
    entries: ['{n} entry', '{n} entries'],
    events: ['{n} event', '{n} events'],
    changes: ['{n} change', '{n} changes'],
    members: ['{n} member', '{n} members'],
    periods: ['{n} period', '{n} periods']
};

/** What a finished lookup found ({ count, unit, eur, cut } or { error }): "12 entries · €345.50". */
export function lookupFound(done, t = (key, fallback, params) => fallback.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? ''), money = (eur) => `${eur} €`) {
    if (!done || typeof done !== 'object') return '';
    if (done.error) return done.error === 'forbidden' ? t('ai_found_forbidden', 'not allowed') : t('ai_found_failed', 'failed');
    if (!Object.hasOwn(FOUND, done.unit) || !Number.isFinite(done.count)) return '';
    const one = done.count === 1;
    const parts = [t(`ai_found_${done.unit}${one ? '_one' : ''}`, FOUND[done.unit][one ? 0 : 1], { n: done.count })];
    if (Number.isFinite(done.eur)) parts.push(money(done.eur));
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
export function createReplyWork() {
    const steps = [];
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
export function liveLabel(work, inlineThinking = '', t) {
    const inline = liveTitle(inlineThinking);
    if (inline) return inline;
    for (let index = work.steps.length - 1; index >= 0; index -= 1) {
        const step = work.steps[index];
        if (step.kind === 'lookup') return lookupTitle(step.lookup, t);
        if (step.kind === 'thought') {
            const title = liveTitle(step.text);
            if (title) return title;
        }
        if (step.kind === 'note') return liveTitle(step.text);
    }
    return '';
}
