// The assistant's sign, as in the Android app (AiOrb.kt): two soft forms in the app's colours - lagoon in front, sand
// behind - whose outlines slowly change. Every point of an outline moves in and out on its own slow path and the forms
// drift a little against each other, so the sign never turns and never looks the same twice. While the AI works it
// moves faster and livelier, with a soft glow; once a reply is complete it slows down and comes to rest (every reply's
// sign a little different), so a long chat stays calm. Asked for less motion, it stays still.
//
// Drawn as SVG in a box of 100 × 100: sharp at every size, its colours follow the theme (polish.css, .ai-sign-*). The
// geometry is the app's own, so the sign looks alike in both, and pure (tested in tests/frontend.test.js); only
// aiSignMarkup, wakeAiSigns and setAiSignState touch the page.

const FORM_POINTS = 7;
// Catmull-Rom handles stretched so that seven points at rest make a true circle
const FORM_HANDLE = 4 * Math.tan(Math.PI / (2 * FORM_POINTS)) / Math.sin(2 * Math.PI / FORM_POINTS);

/** A slow wander around 0: two sines of unrelated periods, so it never repeats within the time anyone looks. */
export const wander = (t, speed, phase) => 0.65 * Math.sin(t * speed + phase) + 0.35 * Math.sin(t * speed * 1.618 + phase * 2.3);

// Two decimals are sharp at every size a sign or a field is drawn and keep the paths short
export const fixed = value => String(Math.round(value * 100) / 100);

/**
 * A closed soft outline (SVG path data) through seven points around (x, y): the points keep their directions and only
 * move in and out, each on its own slow path - the form changes, it never turns. At a fixed [t] it is still: the quiet
 * forms in the painted fields of Extras and the media library (motifs.js).
 */
export function softFormPath(x, y, radius, t, amp, seed) {
    const n = FORM_POINTS;
    const points = [];
    for (let i = 0; i < n; i++) {
        const angle = 2 * Math.PI * i / n - Math.PI / 2;
        const reach = radius * (1 + amp * wander(t, 0.42 + 0.11 * ((i * 5 + 3) % n), seed + i * 1.9));
        points.push([x + Math.cos(angle) * reach, y + Math.sin(angle) * reach]);
    }
    const k = FORM_HANDLE / 6;
    let d = `M${fixed(points[0][0])} ${fixed(points[0][1])}`;
    for (let i = 0; i < n; i++) {
        const [p0, p1, p2, p3] = [-1, 0, 1, 2].map(step => points[(i + step + n) % n]);
        d += `C${fixed(p1[0] + (p2[0] - p0[0]) * k)} ${fixed(p1[1] + (p2[1] - p0[1]) * k)} `
            + `${fixed(p2[0] - (p3[0] - p1[0]) * k)} ${fixed(p2[1] - (p3[1] - p1[1]) * k)} ${fixed(p2[0])} ${fixed(p2[1])}`;
    }
    return `${d}Z`;
}

/**
 * One moment of the sign in its box of 100 × 100: [t] in seconds of its motion, [energy] from 0 (calm) to 1 (thinking),
 * [glow] the soft light large signs have at rest. The sand form lies behind, up and right, the lagoon form in front,
 * down and left - the two overlap in the middle; each is a gentle fall of its colour whose direction sways a little
 * ({ d, x1, y1, x2, y2 }: its outline and the line of its gradient). The halo breathes and grows while the AI thinks
 * ({ strength, r, stops }: a strength of 0 is no halo).
 */
export function signFrame(t, energy = 0, glow = false) {
    const r = 50;
    const amp = 1 + energy;
    const sway = 0.35 * wander(t, 0.29, 1.1);
    const form = ([x, y], radius, formAmp, seed, angle) => ({
        d: softFormPath(x, y, radius, t, formAmp, seed),
        x1: x + Math.cos(angle) * r,
        y1: y + Math.sin(angle) * r,
        x2: x - Math.cos(angle) * r,
        y2: y - Math.sin(angle) * r
    });
    const backAt = [50 + r * (0.2 + 0.06 * wander(t, 0.46, 0.4)), 50 + r * (-0.17 + 0.06 * wander(t, 0.36, 1.7))];
    const frontAt = [50 + r * (-0.17 + 0.06 * wander(t, 0.39, 2.9)), 50 + r * (0.16 + 0.06 * wander(t, 0.54, 0.8))];
    const breathe = 1 + (0.03 + 0.05 * energy) * Math.sin(t * (1.1 + 1.4 * energy));
    const outer = r * (1.55 + 0.1 * energy) * breathe;
    const inner = r / outer;
    return {
        back: form(backAt, r * 0.74, 0.09 * amp, 1.3, -2.4 + sway),
        front: form(frontAt, r * 0.76, 0.085 * amp, 4.1, -2.0 - sway),
        halo: { strength: (glow ? 0.25 : 0) + 0.95 * energy, r: outer, stops: [inner * 0.86, (inner + 1) / 2] }
    };
}

/** The app's FastOutSlowInEasing, cubic-bezier(0.4, 0, 0.2, 1), at [x] from 0 to 1. */
export function fastOutSlowIn(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const curve = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    // The curve's parameter for x (it rises steadily, so halving finds it), then its height there
    let low = 0;
    let high = 1;
    let s = x;
    for (let i = 0; i < 24; i++) {
        s = (low + high) / 2;
        if (curve(0.4, 0.2, s) < x) low = s;
        else high = s;
    }
    return curve(0, 1, s);
}

/** A value that eases to each new target over [ms], from wherever it is at that moment. */
function easedValue(value) {
    let from = value;
    let to = value;
    let start = 0;
    let duration = 0;
    const at = now => (!duration || now >= start + duration ? to : from + (to - from) * fastOutSlowIn((now - start) / duration));
    return {
        at,
        settled: now => !duration || now >= start + duration,
        to(target, ms, now) {
            if (target === to) return;
            from = at(now);
            to = target;
            start = now;
            duration = ms;
        }
    };
}

const PACE = { calm: 1, thinking: 2.4, resting: 0 };

/**
 * How a sign moves: its time runs at a pace - calm 1, thinking 2.4, resting 0 - and it is livelier while the AI thinks;
 * both ease into each other (1.4 s and 0.9 s), so the motion never jumps when the AI starts or stops working.
 * [advance] moves its time on to [now] (ms) and says whether it still moves; [pause] forgets the last frame, so the
 * time out of sight is not made up for at once.
 */
export function createSignMotion(seed = 0) {
    let time = seed;
    let last = null;
    const pace = easedValue(PACE.calm);
    const energy = easedValue(0);
    return {
        get time() { return time; },
        set(state, now) {
            pace.to(PACE[state] ?? PACE.calm, 1400, now);
            energy.to(state === 'thinking' ? 1 : 0, 900, now);
        },
        advance(now) {
            const speed = pace.at(now);
            if (last !== null) time += Math.min(0.1, Math.max(0, (now - last) / 1000)) * speed;
            last = now;
            return { time, energy: energy.at(now), moving: speed > 0 || !pace.settled(now) || !energy.settled(now) };
        },
        pause() { last = null; }
    };
}

// --- On the page: the signs that may move, which of them are on screen, one frame loop for all ---

let signCount = 0;
const awake = new Set();
let observer = null;
let frame = 0;

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The sign's markup, still at [time] until [wakeAiSigns] lets it move: [size] in px, [glow] its soft light at rest
 * (signs of 48 px and more, like the app's), [seed] where in its motion it starts, [still] never moves (the faint
 * sign in the corner of the AI's tile in Extras).
 */
export function aiSignMarkup({ size = 28, seed = 0, glow = size >= 48, still = false, time = seed, className = '' } = {}) {
    const id = `ai-sign-${++signCount}`;
    const f = signFrame(time, 0, glow);
    const stop = (offset, name) => `<stop offset="${fixed(offset)}" class="${name}"/>`;
    const line = (form, key, from, to) => `<linearGradient id="${id}-${key}" gradientUnits="userSpaceOnUse" x1="${fixed(form.x1)}" y1="${fixed(form.y1)}" `
        + `x2="${fixed(form.x2)}" y2="${fixed(form.y2)}">${stop(0, from)}${stop(1, to)}</linearGradient>`;
    return `<span class="ai-sign${className ? ` ${className}` : ''}" style="--ai-sign-size: ${size}px; --ai-sign-glow: ${fixed(f.halo.strength)}" `
        + `data-seed="${fixed(seed)}"${glow ? ' data-glow=""' : ''}${still ? ' data-still=""' : ''} aria-hidden="true">`
        + '<svg viewBox="0 0 100 100" focusable="false"><defs>'
        + `<radialGradient id="${id}-h" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="${fixed(f.halo.r)}">`
        + `${stop(0, 'ai-sign-h0')}${stop(f.halo.stops[0], 'ai-sign-h1')}${stop(f.halo.stops[1], 'ai-sign-h2')}${stop(1, 'ai-sign-h3')}</radialGradient>`
        + line(f.back, 'b', 'ai-sign-b0', 'ai-sign-b1')
        + line(f.front, 'f', 'ai-sign-f0', 'ai-sign-f1')
        + `</defs><circle class="ai-sign-halo" cx="50" cy="50" r="${fixed(f.halo.r)}" fill="url(#${id}-h)"/>`
        + `<path class="ai-sign-back" d="${f.back.d}" fill="url(#${id}-b)"/>`
        + `<path class="ai-sign-front" d="${f.front.d}" fill="url(#${id}-f)"/></svg></span>`;
}

function draw(sign, time, energy) {
    const f = signFrame(time, energy, sign.glow);
    const { back, front, backLine, frontLine, haloLine, haloCircle, stops } = sign.parts;
    back.setAttribute('d', f.back.d);
    front.setAttribute('d', f.front.d);
    for (const [line, form] of [[backLine, f.back], [frontLine, f.front]]) {
        for (const key of ['x1', 'y1', 'x2', 'y2']) line.setAttribute(key, fixed(form[key]));
    }
    haloLine.setAttribute('r', fixed(f.halo.r));
    haloCircle.setAttribute('r', fixed(f.halo.r));
    stops[1].setAttribute('offset', fixed(f.halo.stops[0]));
    stops[2].setAttribute('offset', fixed(f.halo.stops[1]));
    sign.el.style.setProperty('--ai-sign-glow', fixed(f.halo.strength));
}

function tick(now) {
    frame = 0;
    let again = false;
    for (const sign of awake) {
        if (!sign.el.isConnected) {
            forget(sign);
            continue;
        }
        if (!sign.shown) continue;
        const { time, energy, moving } = sign.motion.advance(now);
        // A sign that has come to rest is drawn once more, then no longer
        if (moving || !sign.rested) draw(sign, time, energy);
        sign.rested = !moving;
        if (moving) again = true;
        else sign.motion.pause();
    }
    if (again) frame = requestAnimationFrame(tick);
}

const run = () => {
    if (!frame && !calm() && [...awake].some(sign => sign.shown)) frame = requestAnimationFrame(tick);
};

function forget(sign) {
    awake.delete(sign);
    observer?.unobserve(sign.el);
    delete sign.el._aiSign;
}

/**
 * Lets the signs in [root] move (each once; still ones stay as drawn). Only those on screen are drawn, all in one
 * frame loop that stops when none of them moves.
 */
export function wakeAiSigns(root) {
    if (!root?.querySelectorAll) return;
    for (const sign of awake) if (!sign.el.isConnected) forget(sign);
    for (const el of root.querySelectorAll('.ai-sign:not([data-awake])')) {
        el.setAttribute('data-awake', '');
        if (el.hasAttribute('data-still')) continue;
        const svg = el.querySelector('svg');
        if (!svg) continue;
        const sign = {
            el,
            glow: el.hasAttribute('data-glow'),
            motion: createSignMotion(Number(el.dataset.seed) || 0),
            parts: {
                back: svg.querySelector('.ai-sign-back'),
                front: svg.querySelector('.ai-sign-front'),
                backLine: svg.querySelector('linearGradient[id$="-b"]'),
                frontLine: svg.querySelector('linearGradient[id$="-f"]'),
                haloLine: svg.querySelector('radialGradient'),
                haloCircle: svg.querySelector('.ai-sign-halo'),
                stops: [...svg.querySelectorAll('radialGradient stop')]
            },
            shown: typeof IntersectionObserver !== 'function',
            rested: false,
            state: 'calm'
        };
        el._aiSign = sign;
        awake.add(sign);
        if (typeof IntersectionObserver === 'function') {
            observer ||= new IntersectionObserver(entries => {
                for (const entry of entries) {
                    const seen = entry.target._aiSign;
                    if (!seen) continue;
                    seen.shown = entry.isIntersecting;
                    if (!seen.shown) seen.motion.pause();
                }
                run();
            });
            observer.observe(el);
        }
    }
    run();
}

/**
 * What the sign in [el] does: 'thinking' (faster, livelier, with a soft glow), 'calm' or 'resting' (it slows down and
 * stops: a finished reply). Asked for less motion it stays still and only glows while the AI thinks, as in the app.
 */
export function setAiSignState(el, state) {
    const sign = el?._aiSign;
    if (!sign || sign.state === state) return;
    sign.state = state;
    sign.rested = false;
    sign.motion.set(state, typeof performance === 'object' ? performance.now() : Date.now());
    if (calm()) draw(sign, sign.motion.time, state === 'thinking' ? 1 : 0);
    else run();
}
