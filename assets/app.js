import { initializeApp, getDatabase, ref, set, get, child, update, query, orderByChild, equalTo, runTransaction, getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, apiGet } from "./pocketbase-compat.js";
import { config } from "./config.js";
import { renderSongHtml, transposedKey, keySteps, searchText, normalizeSearch } from "./songbook.js";
import { breadcrumb, parentPath, folderFromRoute, thumbSize, viewerSize, previewUrl, fileUrl, sortEntries, formatSize, opensInViewer, opensAsPdf, opensInPlayer, typeLabel, viewerNeedsOriginal, browserShowsOriginal, ZOOM_PREVIEW_SIZE, neighbourIndex, rightsRows, removableRow, addableTargets, rightsPayload, zoomAt, pinchView, clampView } from "./media.js";
import { parseAmount, applyStatusChangeToHistory, applyApprovedRequest, addApprovedExpense, withoutApprovedRequest, withoutApprovedExpense, findPaymentIndex } from "./finance.js";

const db = getDatabase(initializeApp(config));
const auth = getAuth();
const API = config.apiBaseUrl;
// Name from the server configuration (System-Konfiguration); changes take effect right after saving
let APP_NAME = config.appName || 'Agora';
// Switched-off features (backend/features.js); an old cached config.js has none, so everything stays off
const FEATURES = { polls: config.features?.polls === true };

let people = [];
let requests = [];
let users = [];
let settings = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0, reportStartDate: null };
let currentPersonId = null;
let isAuthenticated = false;
let currentUser = null;
let advancedConfigLoaded = false;
let advancedConfigAppName = null;
let currentEditedPayment = null;
let currentEditedReceipts = [];
let currentActiveTab = 'user-overview';

// --- DOM & formatting helpers ---
const $ = id => document.getElementById(id);
const toElement = target => (typeof target === 'string' ? $(target) : target);
function show(target, visible, display = '') {
    const el = toElement(target);
    if (el) el.style.display = visible ? display : 'none';
}
function setValue(id, value) {
    const el = $(id);
    if (el) el.value = value;
}
function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}
const inputValue = id => $(id)?.value || '';
const isChecked = id => $(id)?.checked === true;
const inList = (list, item) => Array.isArray(list) && list.includes(item);
const safeList = val => (!val ? [] : Array.isArray(val) ? val : Object.values(val));
const fullName = u => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
// A value as a JS string literal inside an inline handler attribute (onclick="fn(${jsArg(x)})"): JSON-quoted,
// then HTML-escaped. escapeHtml alone is not enough there - the browser decodes the attribute before running it.
const jsArg = value => escapeHtml(JSON.stringify(String(value ?? '')));

function escapeHtml(text) {
    return text ? String(text).replace(/[&<>"']/g, m => HTML_ESCAPES[m]) : '';
}

// Formatters follow the UI language (uiLocale(), set once the locale file is loaded)
const intlCache = new Map();
function intlFormatter(Ctor, options) {
    const key = Ctor.name + uiLocale() + JSON.stringify(options);
    if (!intlCache.has(key)) intlCache.set(key, new Ctor(uiLocale(), options));
    return intlCache.get(key);
}
const localeFormatter = (Ctor, options) => ({ format: value => intlFormatter(Ctor, options).format(value) });
const currencyFormatter = localeFormatter(Intl.NumberFormat, { style: 'currency', currency: 'EUR' });
const dateFormatter = localeFormatter(Intl.DateTimeFormat, { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthYearFormatter = localeFormatter(Intl.DateTimeFormat, { month: 'long', year: 'numeric' });
const dateTimeFormatter = localeFormatter(Intl.DateTimeFormat, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Amount with the euro sign where the language puts it ("50,00 €" / "€50.00")
const euro = amount => { const num = parseFloat(amount); return currencyFormatter.format(isNaN(num) ? 0 : num); };

function formatDateFast(dateInput) {
    if (!dateInput) return '';
    const str = String(dateInput);
    // Only real ISO dates take the fast path (dates come from records members write, the result goes into HTML)
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return [str.slice(8, 10), str.slice(5, 7), str.slice(0, 4)].join(uiLang === 'en' ? '/' : '.');
    const d = new Date(dateInput);
    return Number.isNaN(d.getTime()) ? t('no_date', 'No date') : dateFormatter.format(d);
}

const pad2 = n => String(n).padStart(2, '0');
const toDateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const getTodayStr = () => toDateStr(new Date());

function parseReceipts(receiptField) {
    if (Array.isArray(receiptField)) return receiptField.filter(Boolean);
    const trimmed = String(receiptField || '').trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try { return JSON.parse(trimmed).filter(Boolean); } catch { /* fall through to CSV */ }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

function groupBy(list, keyFn) {
    const groups = new Map();
    for (const item of list) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}

function debounce(fn, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}

// One run at a time per action: a double tap on a slow network sent it twice - the second failed ("not found",
// "only the requested user can answer") and its error replaced the first one's success
const runningActions = new Set();
async function once(key, action) {
    if (runningActions.has(key)) return;
    runningActions.add(key);
    try {
        return await action();
    } finally {
        runningActions.delete(key);
    }
}

/**
 * Runs an action and reports a failure as a toast (of type `toast`, an error by default - no blocking browser
 * dialog): the message is a string or a function of the error. `button` shows the loading state on a button
 * meanwhile. Resolves to true on success.
 */
async function attempt(action, failure, { toast = null, button = null, loading = t('setup_btn_saving', 'Saving...') } = {}) {
    if (button) setButtonLoading(button, true, loading);
    try {
        await action();
        return true;
    } catch (err) {
        console.error(err);
        const message = typeof failure === 'function' ? failure(err) : failure;
        showToast(message, toast || 'error');
        return false;
    } finally {
        if (button) setButtonLoading(button, false);
    }
}

function setButtonLoading(btnId, isLoading, loadingText = t('btn_loading', 'Loading...')) {
    const btn = $(btnId);
    if (!btn) return;
    if (isLoading) {
        btn.dataset.originalText = btn.innerText;
        btn.innerText = loadingText;
    } else if (btn.dataset.originalText) {
        btn.innerText = btn.dataset.originalText;
    }
    btn.disabled = isLoading;
}

function validateRequired(ids) {
    const missing = ids.map($).filter(el => !el || !el.value.trim());
    missing.forEach(el => {
        if (!el) return;
        el.classList.add('input-error');
        el.addEventListener('input', () => el.classList.remove('input-error'), { once: true });
    });
    return missing.length === 0;
}

const readAsDataUrl = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
});

// Large third-party libraries are fetched on first use instead of on every start
// (HEIC conversion: 1.3 MB, PDF export: 0.9 MB of script).
const HEIC2ANY_SRC = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const HTML2PDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
const lazyScripts = new Map();
function loadScriptOnce(src) {
    if (!lazyScripts.has(src)) {
        lazyScripts.set(src, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => {
                lazyScripts.delete(src);
                script.remove();
                reject(new Error('Failed to load ' + src));
            };
            document.head.appendChild(script);
        }));
    }
    return lazyScripts.get(src);
}

const isHeic = (name = '', type = '') => /\.hei[cf]$/i.test(name) || type === 'image/heic' || type === 'image/heif';

// Converts HEIC/HEIF files/blobs to JPEG via heic2any; returns the input unchanged when not HEIC or on failure.
async function convertHeic(file, quality, name = file.name) {
    if (!isHeic(name, file.type)) return file;
    try {
        await loadScriptOnce(HEIC2ANY_SRC);
        const out = await heic2any({ blob: file, toType: 'image/jpeg', quality });
        const blob = Array.isArray(out) ? out[0] : out;
        return file instanceof File ? new File([blob], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' }) : blob;
    } catch (e) {
        console.error('HEIC conversion failed:', e);
        return file;
    }
}

// --- Icons & shared inline styles ---
const ICONS = {
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    coin: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 14h-8"/><path d="M16 18h-8"/><path d="M16 10h-8"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    person: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    location: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    arrowUpRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    chevronUp: '<polyline points="18 15 12 9 6 15"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><rect x="14" y="14" width="7" height="7" rx="2"></rect>',
    palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.1 0 5.6-2.5 5.6-5.6C21.8 6 17.4 2 12 2z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    poll: '<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    rotate: '<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
};
const svgIcon = (name, size = 14, strokeWidth = 2, attrs = '') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${attrs ? ' ' + attrs : ''}>${ICONS[name]}</svg>`;

const STYLE = {
    fileRow: 'display:flex; align-items:center; justify-content:space-between; gap:10px; background:var(--surface-alt); border:1px solid var(--border); border-radius:12px; padding:8px 12px; transition: transform 0.2s;',
    fileName: 'font-size:0.85rem; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;',
    thumb: 'width:40px; height:40px; object-fit:cover; border-radius:8px; border:1px solid var(--border);',
    iconBtn: 'padding:6px; display:inline-flex; align-items:center; justify-content:center; border-radius:8px;',
    outlineBtn: 'background:var(--surface); border:1px solid var(--border); color:var(--text); text-decoration:none;',
    muted: 'color:var(--text-secondary);'
};
const iconButton = (onclick, title, icon = 'trash') =>
    `<button type="button" class="btn btn-danger btn-small" style="${STYLE.iconBtn}" onclick="${onclick}" title="${title}">${svgIcon(icon)}</button>`;
const fileRow = (preview, name, actions, nameStyle = 'color:var(--text); font-weight:600;') => `
    <div style="${STYLE.fileRow}">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
            ${preview}
            <span style="${STYLE.fileName} ${nameStyle}">${escapeHtml(name)}</span>
        </div>
        ${actions ? `<div style="display:flex; gap:6px;">${actions}</div>` : ''}
    </div>`;
const emptyNotice = (text, style = 'text-align:center; padding:20px; color:var(--text-secondary);') => `<div style="${style}">${text}</div>`;

// --- Pending receipt uploads (add-expense form & user expense request) ---
const pendingUploads = {
    expense: { files: [], listId: 'expense-receipt-preview-list', remove: 'removePendingExpenseFile' },
    req: { files: [], listId: 'req-receipt-preview-list', remove: 'removePendingReqFile' }
};
function renderPendingFiles(kind) {
    const { files, listId, remove } = pendingUploads[kind];
    const listEl = $(listId);
    if (!listEl) return;
    listEl.innerHTML = files.map((file, index) => {
        const isImage = file.type && file.type.startsWith('image/');
        if (isImage && !file.previewUrl) file.previewUrl = URL.createObjectURL(file);
        const preview = isImage
            ? `<img src="${file.previewUrl}" style="${STYLE.thumb}" alt="${t('receipt', 'Receipt')}">`
            : `<div style="width:40px; height:40px; background:var(--surface); border-radius:8px; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; color:var(--text-secondary);">${svgIcon('file', 20)}</div>`;
        return fileRow(preview, file.name, iconButton(`${remove}(${index})`, t('btn_remove', 'Remove')));
    }).join('');
}
function resetPendingFiles(kind) {
    pendingUploads[kind].files.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    pendingUploads[kind].files = [];
    renderPendingFiles(kind);
}
function addPendingFiles(kind, files) {
    if (!files || files.length === 0) return;
    pendingUploads[kind].files.push(...files);
    renderPendingFiles(kind);
}
function removePendingFile(kind, index) {
    if (index < 0) return;
    const [removed] = pendingUploads[kind].files.splice(index, 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    renderPendingFiles(kind);
}
async function uploadAll(files, name, date) {
    const filenames = [];
    for (const file of files) filenames.push(await uploadReceipt(file, name, date));
    return JSON.stringify(filenames);
}

// --- i18n ---
// English (en.json) is the source language and always complete. Other languages are translations that may lag
// behind: missing texts fall back to English. Users get their system language by default ('system').
const SUPPORTED_LANGUAGES = ['en', 'de'];
const BASE_LANGUAGE = 'en';
let currentLang = localStorage.getItem('app_lang') || 'system';
localStorage.setItem('app_lang', currentLang);
let translations = {};
let uiLang = BASE_LANGUAGE;
const uiLocale = () => (uiLang === 'de' ? 'de-DE' : 'en-GB');
const fetchLocale = async lang => (await fetch(`./assets/locales/${lang}.json`)).json();
// Untranslated texts are left empty (or missing) in a translation: those keep the English text. A broken
// translation file only costs its language, never the English base.
const withTranslation = (base, own) => ({ ...base, ...Object.fromEntries(Object.entries(own || {}).filter(([, text]) => typeof text === 'string' && text.trim())) });

/** The language a setting resolves to: 'system' follows the browser / OS, unsupported languages become English. */
function resolveLanguage(lang) {
    const wanted = lang === 'system' ? (navigator.language || navigator.userLanguage || BASE_LANGUAGE) : lang;
    const short = String(wanted).toLowerCase().split('-')[0];
    return SUPPORTED_LANGUAGES.includes(short) ? short : BASE_LANGUAGE;
}

async function loadLanguage(lang) {
    try {
        const resolved = resolveLanguage(lang);
        const [base, own] = await Promise.all([
            fetchLocale(BASE_LANGUAGE),
            resolved === BASE_LANGUAGE ? null : fetchLocale(resolved).catch(e => { console.warn(`Translation ${resolved} not loaded:`, e); return null; })
        ]);
        translations = withTranslation(base, own);
        uiLang = resolved;
        document.documentElement.lang = resolved;
        currentLang = lang;
        localStorage.setItem('app_lang', lang);
        applyTranslations();
        syncUserLanguage();
    } catch (e) {
        console.error('Failed to load translation:', e);
    }
}

// The server writes push messages and e-mails in the language the user's app resolved to; the time zone helps it
// find the community's zone for duty reminders when the server has no TZ (Docker default UTC)
function syncUserLanguage() {
    const uid = currentUser?.uid || currentUser?.id;
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browsers */ }
    const value = {};
    if (currentUser?.language !== uiLang) value.language = uiLang;
    if (timeZone && currentUser?.timeZone !== timeZone) value.timeZone = timeZone;
    if (!uid || !Object.keys(value).length) return;
    Object.assign(currentUser, value);
    api('/db', 'PATCH', { path: `users/${uid}`, value }).catch(e => console.warn('Could not save the language:', e));
}

function t(key, fallback = '', params = null) {
    let str = translations[key] !== undefined ? translations[key] : fallback;
    for (const [k, v] of Object.entries(params || {})) str = str.replaceAll(`{${k}}`, v);
    return str;
}

// Keys are the status texts the server computes (backend/derivedData.js). They are fixed protocol values that
// released apps compare against, so they stay German on the wire; users see them translated.
const STATUS_TEXT_KEYS = {
    'Dauerauftrag läuft': ['status_standing_order_active', 'Standing order is active'],
    'Dauerauftrag läuft für den Beitrag': ['status_standing_order_active', 'Standing order is active'],
    'Dauerauftrag aktiv': ['status_standing_order_active', 'Standing order is active'],
    'Alles in Ordnung': ['status_all_ok', 'All good'],
    'Zahlung überfällig': ['status_payment_overdue', 'Payment overdue'],
    'Keine Zahlungen': ['status_no_payments', 'No payments'],
    'läuft diesen Monat ab': ['status_expires_this_month', 'expires this month'],
    'läuft nächsten Monat ab': ['status_expires_next_month', 'expires next month']
};
function translateStatusText(text) {
    if (!text) return '';
    const clean = text.trim();
    if (STATUS_TEXT_KEYS[clean]) return t(...STATUS_TEXT_KEYS[clean]);
    const overdue = clean.match(/(\d+)\s+Monat[e]?\s+überfällig/);
    if (overdue) return overdue[1] === '1' ? t('status_one_month_overdue', '1 month overdue') : t('status_months_overdue', '{months} months overdue', { months: overdue[1] });
    const left = clean.match(/noch\s+(\d+)\s+Monat[e]?/);
    if (left) return left[1] === '1' ? t('status_one_month_left', '1 month left') : t('status_months_left', '{months} months left', { months: left[1] });
    return text;
}

function getStatusLabels(withEmoji = false) {
    const labels = {
        vollverdiener: t('member_status_full', '💼 Full earner'),
        geringverdiener: t('member_status_low', '📉 Low earner'),
        keinverdiener: t('member_status_none', '🎓 Non-earner'),
        pausiert: t('member_status_paused', '⏸️ Paused')
    };
    if (!withEmoji) for (const k in labels) labels[k] = labels[k].replace(/^[💼📉🎓⏸️\s]+/u, '').trim();
    return labels;
}

function applyTranslations() {
    const setters = {
        'data-i18n': (el, text) => { if (text.includes('<')) el.innerHTML = text; else el.textContent = text; },
        'data-i18n-placeholder': (el, text) => el.setAttribute('placeholder', text),
        'data-i18n-aria-label': (el, text) => el.setAttribute('aria-label', text),
        'data-i18n-title': (el, text) => el.setAttribute('title', text),
        'data-i18n-alt': (el, text) => el.setAttribute('alt', text)
    };
    for (const [attr, apply] of Object.entries(setters)) {
        document.querySelectorAll(`[${attr}]`).forEach(el => {
            const text = translations[el.getAttribute(attr)];
            if (text) apply(el, text);
        });
    }
    syncPreferenceSelects();
}

function syncPreferenceSelects(theme = localStorage.getItem('agora-theme') || localStorage.getItem('nova-theme') || 'system') {
    ['settings-language', 'user-settings-language'].forEach(id => setValue(id, currentLang));
    ['settings-theme', 'user-settings-theme'].forEach(id => setValue(id, theme));
    renderSettingsPills();
    ['settings', 'user-settings'].forEach(id => {
        const root = $(id);
        const page = SETTINGS_PAGES.find(p => p.key === root?.dataset.page);
        const title = root?.querySelector('.settings-nav-title');
        if (page && title) title.textContent = page.title ? t(...page.title) : t('settings_profile', 'Profile');
    });
}

// Theme and language as pill tabs (like the Android app); the select stays the state and its change handler runs
const PILL_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };
function renderSettingsPills() {
    document.querySelectorAll('.settings-choice select').forEach(select => {
        let pills = select.nextElementSibling;
        if (!pills?.classList.contains('settings-pills')) {
            pills = document.createElement('div');
            pills.className = 'settings-pills';
            pills.setAttribute('role', 'radiogroup');
            pills.setAttribute('aria-labelledby', `${select.id}-label`);
            select.after(pills);
            select.classList.add('settings-choice-select');
            pills.addEventListener('click', e => {
                const pill = e.target.closest('.settings-pill');
                if (!pill || select.value === pill.dataset.value) return;
                select.value = pill.dataset.value;
                select.dispatchEvent(new Event('change'));
                renderSettingsPills();
            });
            // Arrow keys move between the choices like in any radio group
            pills.addEventListener('keydown', e => {
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                if (!step) return;
                e.preventDefault();
                const all = [...pills.querySelectorAll('.settings-pill')];
                const next = all[(all.indexOf(document.activeElement) + step + all.length) % all.length];
                next?.click();
                pills.querySelector(`.settings-pill[data-value="${next?.dataset.value}"]`)?.focus();
            });
        }
        const withIcons = select.id.endsWith('theme');
        pills.innerHTML = [...select.options].map(option => {
            const on = option.value === select.value;
            return `<button type="button" role="radio" class="settings-pill${on ? ' is-active' : ''}" data-value="${escapeHtml(option.value)}" aria-checked="${on}" tabindex="${on ? 0 : -1}">${withIcons && PILL_ICONS[option.value] ? svgIcon(PILL_ICONS[option.value], 16, 2) : ''}<span>${escapeHtml(option.textContent.trim())}</span></button>`;
        }).join('');
    });
}

// Delete account: a danger row that opens its form (a sheet in the Android app)
function toggleDeleteAccount(btn, open = btn.getAttribute('aria-expanded') !== 'true') {
    const body = $(btn.getAttribute('aria-controls'));
    if (!body) return;
    btn.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (open) body.querySelector('input')?.focus();
}

async function changeAppLanguage(lang) {
    await loadLanguage(lang);
    renderPeople();
    renderStats();
    renderUserView();
    renderSuperAdminPaymentEditor();
    renderHomeMentoringCard();
    if (currentUser) loadMentoringData();
}

// Pages rendered before any data (a shared event for visitors) wait for the texts
const languageReady = loadLanguage(currentLang);

// --- Toasts & dialogs (callers pass already translated texts via t()) ---
let toastTimeout;
function showToast(msg, type = 'success') {
    let toast = $('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} show`;
    // Neutral news ("Unregistered") gets no warning sign
    toast.textContent = `${{ success: '✅', info: 'ℹ️' }[type] || '⚠️'} ${msg}`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// Empty messages (e.g. an error without text) are not shown
const nativeAlert = window.alert.bind(window);
window.alert = msg => {
    if (msg) nativeAlert(msg);
};

function confirmAction(options) {
    const text = typeof options === 'string' ? options : (options?.text || options?.message || '');
    const onConfirm = typeof options === 'function' ? options : options?.onConfirm;
    if (!window.confirm(text)) return false;
    if (typeof onConfirm === 'function') onConfirm();
    return true;
}

// --- Permissions ---
const hasPermission = (flag, permission) => !!(currentUser && (currentUser[flag] || inList(currentUser.permissions, permission)));
const isSuperAdminUser = () => !!(currentUser && (currentUser.admin || currentUser.owner || currentUser.superAdmin));
const isOwnerUser = () => !!(currentUser && (currentUser.owner || currentUser.superAdmin));
const canManageFinances = () => hasPermission('canManageFinances', 'manage_finances');
const canViewFinances = () => canManageFinances() || hasPermission('canViewFinances', 'view_finances');
const canAccessAi = () => hasPermission('canAccessAi', 'access_ai');
const canUseMentoring = () => !!currentUser;
const canManageMentoring = () => hasPermission('canManageMentoring', 'manage_mentoring');
// Admins too need the permission (group with "manage events") to create appointments and manage events
const canManageEvents = () => hasPermission('canManageEvents', 'manage_events');
const canManageRegistrationCode = () => hasPermission('canManageRegistrationCode', 'manage_registration_code');
const currentUid = () => currentUser?.uid || currentUser?.id;
const isCurrentUser = id => !!currentUser && (id === currentUser.uid || id === currentUser.id);

function getAvatarRingClass(user) {
    if (user?.canManageMentoring || inList(user?.permissions, 'manage_mentoring')) return 'avatar-ring-manager';
    if (user?.isApprovedMentor || user?.mentorStatus === 'approved') return 'avatar-ring-mentor';
    return 'avatar-ring-standard';
}

// --- API ---
async function fetchWithAuth(url, options = {}) {
    let token;
    try {
        token = await auth.currentUser.getIdToken();
    } catch (tokenError) {
        throw new Error(t('error_auth_failed', 'Authentication failed. Please sign in again.') + ' (' + (tokenError?.code || tokenError?.message || t('error_unknown', 'Unknown error')) + ')');
    }
    const headers = { 'Accept-Language': uiLang, ...(options.headers || {}), Authorization: `Bearer ${token}` };
    if (typeof options.body === 'string' && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    return fetch(url, { ...options, headers });
}

// JSON-aware request against the backend API. Plain objects are sent as JSON, FormData as-is.
function api(path, method = 'GET', body) {
    const isJson = body !== undefined && !(body instanceof FormData);
    return fetchWithAuth(API + path, { method, body: isJson ? JSON.stringify(body) : body });
}

// Like api(), but resolves to the parsed JSON body and throws the backend's error message on failure.
async function apiJson(path, method = 'GET', body, fallbackError) {
    // No connection: the browser's own English "Failed to fetch" reached the screen, also in German
    const res = await api(path, method, body).catch(err => {
        throw Object.assign(new Error(t('error_connection', 'Connection error')), { cause: err, offline: true });
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || fallbackError || `HTTP ${res.status}`), { data, status: res.status });
    return data;
}

const getToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : '');

// --- Modal stack with browser-history integration ---
const modalStack = [];
// The app's own history steps (closing a modal, leaving a chat or a tab) must not be handled as a user's back
// gesture. A step only counts as "ours" for a short time: if its popstate never arrives (a page pushed right after
// it can cancel the pending traversal on mobile browsers), a stale count would otherwise swallow the next real back
let programmaticBacks = 0;
let programmaticBackAt = 0;
const PROGRAMMATIC_BACK_WINDOW_MS = 1000;

function programmaticBack(steps = 1) {
    programmaticBacks++;
    programmaticBackAt = Date.now();
    history.go(-steps);
}

function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    if (id === 'add-expense-modal') {
        resetPendingFiles('expense');
        setValue('expense-receipt', '');
    }
    if (!modalStack.includes(id)) {
        modalStack.push(id);
        history[history.state?.isModal ? 'replaceState' : 'pushState']({ isModal: true, modalId: id }, '');
    }
    modal._returnFocusTo = document.activeElement;
    modal.style.zIndex = 2000 + modalStack.length * 10;
    modal.classList.add('show');
    syncModalInert();
    focusIntoModal(modal);
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    // Escape closes only the dialog on top (each open dialog listens: one press used to close all of them)
    modal._escHandler = e => { if (e.key === 'Escape' && modalStack[modalStack.length - 1] === id) closeModal(id); };
    document.addEventListener('keydown', modal._escHandler);
    syncUrl();
}

/** Keyboard and screen readers start inside the dialog that opened (its panel, so no keyboard pops up on phones). */
function focusIntoModal(modal) {
    if (modal.contains(document.activeElement) && document.activeElement !== modal) return;
    const panel = modal.querySelector('[autofocus]') || modal.firstElementChild;
    if (!panel) return;
    if (!panel.hasAttribute('tabindex') && !panel.matches('a, button, input, select, textarea')) panel.setAttribute('tabindex', '-1');
    try { panel.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

/**
 * Only the dialog on top can be reached by Tab and screen readers: closed dialogs (they are only transparent) and
 * everything under an open dialog - the page, other dialogs - are inert. Without it Tab wandered through 148
 * invisible controls of closed dialogs and out of an open one. Toasts stay announced.
 */
function syncModalInert() {
    const modals = [...document.querySelectorAll('.modal')];
    const layer = el => Number(el.style.zIndex || getComputedStyle(el).zIndex) || 0;
    const top = modals.filter(m => m.classList.contains('show')).reduce((best, m) => (!best || layer(m) >= layer(best) ? m : best), null);
    modals.forEach(m => { m.inert = m !== top; });
    document.querySelectorAll('body > :not(.modal):not(#toast):not(script):not(style)').forEach(el => { el.inert = !!top; });
}
/**
 * Tab rows that are only styled as tabs (finance, system settings, events, report): their buttons become role="tab"
 * with aria-selected following the highlighted one, so screen readers say which view is shown.
 */
function syncTabRoles(list) {
    list.querySelectorAll(':scope > button').forEach(btn => {
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(btn.classList.contains('is-active') || btn.classList.contains('active')));
    });
}
document.querySelectorAll('[role="tablist"]').forEach(list => {
    if (list.querySelector(':scope > [role="tab"]')) return;
    syncTabRoles(list);
    new MutationObserver(() => syncTabRoles(list)).observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
});

// Dialogs are also shown and hidden directly (sign-in): follow their class instead of every caller
const modalInertObserver = new MutationObserver(syncModalInert);
document.querySelectorAll('.modal').forEach(m => modalInertObserver.observe(m, { attributes: true, attributeFilter: ['class'] }));
syncModalInert();

function hideModal(modal) {
    modal.classList.remove('show');
    modal.style.zIndex = '';
    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        delete modal._escHandler;
    }
}

function restoreFocus(el) {
    if (el && document.body.contains(el)) {
        try { el.focus(); } catch { /* element no longer focusable */ }
    }
}

const reshowTopModal = () => modalStack.length && $(modalStack[modalStack.length - 1])?.classList.add('show');

// A modal can refuse to close (unsaved changes): the guard returns false. A back gesture already left the modal's
// history entry, so it is added again when the modal stays.
const modalCloseGuards = {};

function closeModal(id, fromPopstate = false, force = false) {
    const modal = $(id);
    if (!modal) return;
    if (!force && modal.classList.contains('show') && typeof modalCloseGuards[id] === 'function' && !modalCloseGuards[id]()) {
        if (fromPopstate) history.pushState({ isModal: true, modalId: id }, '');
        return;
    }
    const stackIndex = modalStack.indexOf(id);
    if (stackIndex > -1) {
        modalStack.splice(stackIndex, 1);
        if (!fromPopstate && history.state?.isModal) programmaticBack();
    }
    hideModal(modal);
    restoreFocus(modal._returnFocusTo);
    delete modal._returnFocusTo;
    reshowTopModal();
    if (typeof modal._customOnClose === 'function') {
        try { modal._customOnClose(); } catch { /* ignore */ }
        delete modal._customOnClose;
    }
    syncUrl();
}

function closeMultipleModals(ids) {
    let backs = 0;
    let finalFocus = null;
    ids.forEach(id => {
        const modal = $(id);
        if (!modal) return;
        if (modal._returnFocusTo && !ids.some(other => $(other)?.contains(modal._returnFocusTo))) finalFocus = modal._returnFocusTo;
        const stackIndex = modalStack.indexOf(id);
        if (stackIndex > -1) {
            modalStack.splice(stackIndex, 1);
            backs++;
        }
        hideModal(modal);
        delete modal._returnFocusTo;
    });
    restoreFocus(finalFocus);
    // Nested modals share a single history entry (replaceState), so step back at most once
    if (backs > 0 && history.state?.isModal) programmaticBack();
    reshowTopModal();
    syncUrl();
}

// --- Header: slides away while scrolling down, comes back on the first scroll up (like the Android app) ---
const HEADER_SCROLL_THRESHOLD = 8;
let headerLastY = 0;
let headerTicking = false;

function revealHeader() {
    document.querySelector('.header')?.classList.remove('header-hidden');
}

function updateHeaderOnScroll(container) {
    const header = document.querySelector('.header');
    if (!header) return;
    const y = container.scrollTop;
    const delta = y - headerLastY;
    header.classList.toggle('header-scrolled', y > 4);
    // Near the top, or while the profile menu is open, it always stays
    if (y < 72 || $('profileDropdown')?.classList.contains('show')) {
        header.classList.remove('header-hidden');
        headerLastY = y;
        return;
    }
    if (Math.abs(delta) < HEADER_SCROLL_THRESHOLD) return;
    header.classList.toggle('header-hidden', delta > 0);
    headerLastY = y;
}

document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.container');
    if (!container) return;
    container.addEventListener('scroll', () => {
        if (headerTicking) return;
        headerTicking = true;
        requestAnimationFrame(() => {
            headerTicking = false;
            updateHeaderOnScroll(container);
        });
    }, { passive: true });
});

window.addEventListener('popstate', () => {
    // A #link inside the running app (a notification, an old bookmark) also fires popstate: it is a destination
    if (followLegacyHash()) return;
    handleHistoryBack();
    syncUrl();
});

function handleHistoryBack() {
    if (programmaticBacks > 0 && Date.now() - programmaticBackAt < PROGRAMMATIC_BACK_WINDOW_MS) {
        programmaticBacks--;
        return;
    }
    // Anything older was lost: this is the user's own back
    programmaticBacks = 0;
    if ($('mentoring-threads-layout')?.classList.contains('in-chat') && window.matchMedia('(max-width: 768px)').matches) {
        mentoringChatHistoryPushed = false;
        closeMentoringChatMobile(true, true);
        return;
    }
    if (modalStack.length > 0) {
        closeModal(modalStack[modalStack.length - 1], true);
        return;
    }
    // A level the member went down to by tapping (an app from Extras, a folder, a settings page) has its own entry:
    // back only goes up, it adds nothing. (An entry pushed here, without a tap, would make Chrome skip the one
    // below it on the next back gesture - straight out of the app.)
    if (tabHistoryPushed && historyLevels.length) {
        historyLevels.pop();
        if (settingsPageOpen()) closeSettingsPage(true);
        else if (currentActiveTab === 'media' && mediaFolder) openMediaFolder(parentPath(mediaFolder));
        else if (HUB_TABS.includes(currentActiveTab)) switchTab('hub', 'history');
        return;
    }
    // Back from a tab entry without such levels (opened from an address): one level up first (settings page →
    // menu, an app → Extras), then the start page. Going up keeps the single "not home" history entry
    if (tabHistoryPushed && !history.state?.tab) {
        if (settingsPageOpen()) {
            closeSettingsPage(true);
            history.pushState({ tab: currentActiveTab }, '');
            return;
        }
        // In a folder of the library: the folder above
        if (currentActiveTab === 'media' && mediaFolder) {
            openMediaFolder(parentPath(mediaFolder));
            history.pushState({ tab: 'media' }, '');
            return;
        }
        if (HUB_TABS.includes(currentActiveTab)) {
            switchTab('hub', 'history');
            history.pushState({ tab: 'hub' }, '');
            return;
        }
        tabHistoryPushed = false;
        if (currentActiveTab !== HOME_TAB) switchTab(HOME_TAB, 'history');
    }
}

function showDynamicModal({ id = 'dynamic-ui-modal', title, subtitle, icon, contentHtml, bodyHtml, footerHtml, maxWidth, onClose }) {
    let modal = $(id);
    if (!modal) {
        modal = Object.assign(document.createElement('div'), { id, className: 'modal' });
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        document.body.appendChild(modal);
    }
    modal.innerHTML = `
        <div class="modal-content modal-content-enhanced" ${maxWidth ? `style="max-width: ${maxWidth};"` : ''}>
            <div class="modal-header-enhanced">
                <div class="modal-header-title-group">
                    ${icon ? `<div class="modal-icon-badge">${icon}</div>` : ''}
                    <div>
                        <div class="modal-title-main">${title || ''}</div>
                        ${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ''}
                    </div>
                </div>
                <button type="button" class="close-btn" onclick="closeModal(${jsArg(id)})" aria-label="${t('btn_close', 'Close')}">&times;</button>
            </div>
            <div class="modal-body-enhanced">${contentHtml || bodyHtml || ''}</div>
            ${footerHtml ? `<div class="modal-footer-enhanced">${footerHtml}</div>` : ''}
        </div>`;
    if (onClose) modal._customOnClose = onClose;
    openModal(id);
    return modal;
}

function showReceiptImageModal(title, imageUrl, filename) {
    return showDynamicModal({
        id: 'receipt-preview-modal',
        title: title || t('receipt', 'Receipt'),
        subtitle: filename || '',
        icon: '📎',
        maxWidth: '520px',
        contentHtml: `<div style="text-align: center;"><img src="${imageUrl}" style="max-width: 100%; border-radius: 8px; border: 1px solid var(--border);" alt="${t('receipt', 'Receipt')}"></div>`,
        footerHtml: `
            <a href="${imageUrl}" download="${filename || 'beleg'}" class="btn btn-primary" style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">📥 ${t('download_btn', 'Download')}</a>
            <button type="button" class="btn btn-secondary" onclick="closeModal('receipt-preview-modal')">${t('btn_close', 'Close')}</button>`
    });
}

function renderReceiptPreviewCard(imgUrl, filename, label) {
    const title = label || t('receipt', 'Receipt');
    return `
        <div style="position:relative; border:1px solid var(--border); border-radius:12px; padding:10px; background:var(--surface-alt);">
            <img src="${imgUrl}" style="width:100%; border-radius:8px; opacity:0; transition:opacity 0.3s ease-in; cursor:pointer;" onload="this.style.opacity=1" onclick="window.showReceiptImageModal(${jsArg(title)}, ${jsArg(imgUrl)}, ${jsArg(filename)})" alt="${escapeHtml(title)}">
            <div style="margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
                <a href="${imgUrl}" download="${escapeHtml(filename)}" class="btn btn-secondary btn-small" style="${STYLE.outlineBtn} display:inline-flex; align-items:center; gap:6px; padding:6px 12px; font-size:0.85rem; border-radius:8px;">
                    ${svgIcon('download')} ${t('download_btn', 'Download')}
                </a>
            </div>
        </div>`;
}

// Loads receipt images into `container`, revoking object URLs from a previous render.
async function renderReceiptsInto(container, receiptField, { loading, header = '', empty, error, listStyle }) {
    JSON.parse(container.dataset.blobUrls || '[]').forEach(url => URL.revokeObjectURL(url));
    delete container.dataset.blobUrls;
    container.innerHTML = loading;
    try {
        const filenames = parseReceipts(receiptField);
        if (filenames.length === 0) {
            container.innerHTML = empty;
            return;
        }
        const urls = [];
        for (const filename of filenames) urls.push(await fetchReceiptImage(filename));
        container.dataset.blobUrls = JSON.stringify(urls);
        container.innerHTML = `${header}<div style="${listStyle}">${urls.map((url, i) => renderReceiptPreviewCard(url, filenames[i], t('receipt', 'Receipt'))).join('')}</div>`;
    } catch (err) {
        console.error(err);
        container.innerHTML = error;
    }
}

// Every profile picture: the initials on one soft background (the look of the finance history), the picture over them
function renderAvatarWrap(userId, userName, { wrapClass = 'duty-assignee-avatar-wrap', imgClass = 'duty-assignee-avatar-img', initialsClass = 'duty-assignee-initials', style } = {}) {
    const name = userName || 'P';
    return `
        <div class="avatar ${wrapClass}" ${style ? `style="${style}"` : ''}>
            <span class="avatar-initials ${initialsClass}">${escapeHtml(getInitials(name))}</span>
            ${profilePictureSrc(userId) ? `<img src="${profilePictureSrc(userId)}" alt="${escapeHtml(name)}" class="avatar-img ${imgClass}" loading="lazy" onerror="this.remove()">` : ''}
        </div>`;
}

function getInitials(name) {
    const parts = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || '?').slice(0, 2).toUpperCase();
}

function togglePassword(inputId, btn) {
    const input = $(inputId);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.innerHTML = svgIcon(reveal ? 'eyeOff' : 'eye', 20);
    btn.setAttribute('aria-label', reveal ? t('password_hide', 'Hide password') : t('password_show', 'Show password'));
}

Object.assign(window, {
    escapeHtml, openModal, closeModal, showToast, confirmAction, togglePassword, showReceiptImageModal, changeAppLanguage, loadLanguage, translateStatusText,
    removePendingExpenseFile: index => removePendingFile('expense', index),
    removePendingReqFile: index => removePendingFile('req', index),
    handleReqReceiptFiles: files => addPendingFiles('req', Array.from(files || []))
});

// --- Navigation & layout ---
let sseConnection = null;
let aiEnabled = false;

// The server names the area that changed ('mentoring', 'events', otherwise 'all'). Events arriving in a burst are
// collected for a moment and answered with a single reload of just those areas.
const REMOTE_UPDATE_DELAY_MS = 350;
const pendingRemoteScopes = new Set();
let remoteUpdateTimer = null;
let remoteUpdateRunning = false;

function queueRemoteUpdate(scope) {
    pendingRemoteScopes.add(scope);
    if (!remoteUpdateTimer) remoteUpdateTimer = setTimeout(flushRemoteUpdates, REMOTE_UPDATE_DELAY_MS);
}

const REMOTE_LOADERS = { events: () => { loadEventsData(); refreshProgram(); }, prayers: () => (currentActiveTab === 'prayers' ? loadPrayers() : null), mentoring: () => refreshMentoringFromRemote(), polls: () => (currentActiveTab === 'polls' ? loadPolls() : null), songs: () => (currentActiveTab === 'songbook' ? loadSongs() : null), media: () => { loadMediaStatus(); if (currentActiveTab === 'media') loadMediaFolder({ silent: true }); } };

async function flushRemoteUpdates() {
    remoteUpdateTimer = null;
    if (!isAuthenticated) return pendingRemoteScopes.clear();
    // A reload is still running: keep the scopes and try again afterwards
    if (remoteUpdateRunning) return void (remoteUpdateTimer = setTimeout(flushRemoteUpdates, REMOTE_UPDATE_DELAY_MS));
    const scopes = [...pendingRemoteScopes];
    pendingRemoteScopes.clear();
    remoteUpdateRunning = true;
    try {
        if (scopes.includes('all')) await loadData(true);
        else await Promise.all(scopes.map(s => REMOTE_LOADERS[s]?.()));
    } catch (err) {
        console.warn('Remote update failed:', err);
    } finally {
        remoteUpdateRunning = false;
    }
}

let lastRefreshErrorAt = 0;
// After a lost connection the changes made in the meantime never arrive as live updates: reload everything
let sseLost = false;

function connectSSE() {
    if (sseConnection) return;
    sseConnection = new EventSource(API + '/stream', { withCredentials: true });
    sseConnection.onopen = () => {
        if (sseLost) queueRemoteUpdate('all');
        sseLost = false;
    };
    sseConnection.addEventListener('data_update', e => {
        let scope = 'all';
        try {
            scope = JSON.parse(e.data || '{}').scope || 'all';
        } catch { /* older servers send an empty payload: reload everything */ }
        queueRemoteUpdate(scope);
    });
    sseConnection.onerror = () => {
        console.log('SSE error, reconnecting...');
        sseLost = true;
        sseConnection.close();
        sseConnection = null;
        setTimeout(connectSSE, 5000);
    };
}

// Back in the app after a while (phone locked, another app open): catch up, like the Android app does on resume
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return void (hiddenSince = Date.now());
    if (hiddenSince && Date.now() - hiddenSince > 2 * 60 * 1000 && isAuthenticated) queueRemoteUpdate('all');
    hiddenSince = 0;
});

function syncInviteCards() {
    const allowed = canManageRegistrationCode();
    ['card-invite', 'card-invite-user'].forEach(id => {
        const card = $(id);
        if (!card) return;
        if (allowed) card.style.removeProperty('display');
        else card.style.setProperty('display', 'none', 'important');
    });
}

function updateInviteCodeDisplay(code) {
    const safeCode = canManageRegistrationCode() ? (code || '------') : '';
    ['admin', 'user'].forEach(prefix => {
        setValue(`${prefix}-invite-code`, safeCode);
        setText(`${prefix}-invite-code-display`, safeCode || '------');
    });
    syncInviteCards();
}

function updateNavVisibility() {
    const navVisibility = {
        'admin-finances-nav-btn': canViewFinances(),
        'user-finances-nav-btn': !canViewFinances(),
        'events-nav-btn': !!currentUser,
        'mentoring-nav-btn': canUseMentoring()
    };
    for (const [prefix, visible] of Object.entries(navVisibility)) {
        show(`${prefix}-desktop`, visible);
        show(`${prefix}-bottom`, visible);
    }
    updateAiNavVisibility();
    show('profile-sys-settings-btn', isSuperAdminUser());
    syncInviteCards();
    const profileBtn = document.querySelector('.profile-btn');
    if (profileBtn) {
        profileBtn.classList.remove('avatar-ring-manager', 'avatar-ring-mentor', 'avatar-ring-standard');
        profileBtn.classList.add(getAvatarRingClass(currentUser));
    }
    updateFabVisibility();
}

function updateAiNavVisibility() {
    renderHub();
}

// --- Apps hub: one permanent nav entry for further apps; the AI chat is one of them (with the rights) and leads
// across the full width, the others follow as tiles in this order. [colors] runs from the light to the deep tone of the icon. ---
const HUB_APPS = [
    { key: 'ai', icon: 'sparkles', featured: true, colors: ['#c4b8f5', '#7c6fd6'], title: ['hub_ai_title', 'AI Support'], desc: ['hub_ai_desc', 'Questions about the community, appointments and finances'],
        visible: () => aiEnabled && canAccessAi(), open: () => switchTab('ai-chat') },
    { key: 'media', icon: 'folder', colors: ['#f6c7a4', '#e0874f'], title: ['hub_media_title', 'Media'], desc: ['hub_media_desc', 'Pictures and files of the community'],
        visible: () => mediaStatus.hasAccess, open: () => openMediaFolder('') },
    { key: 'songbook', icon: 'music', colors: ['#aed6ec', '#4a98c4'], title: ['hub_songbook_title', 'Songbook'], desc: ['hub_songbook_desc', 'Songs and lyrics for services and small groups'], open: () => switchTab('songbook') },
    { key: 'prayers', icon: 'heart', colors: ['#f2b5c0', '#d6667c'], title: ['hub_prayers_title', 'Prayer requests'], desc: ['hub_prayers_desc', 'Share requests and pray for each other'], open: () => switchTab('prayers') },
    { key: 'polls', icon: 'poll', colors: ['#acdcc7', '#479f82'], title: ['hub_polls_title', 'Anonymous polls'], desc: ['hub_polls_desc', 'Ask for opinions without names'],
        visible: () => FEATURES.polls, open: () => switchTab('polls') }
];

let hubSignature = '';
function renderHub() {
    const target = $('hub-apps');
    if (!target) return;
    const apps = HUB_APPS.filter(app => !app.visible || app.visible());
    // Only when the tiles change (a re-render would take the keyboard focus away from a tile)
    const signature = `${uiLang}:${apps.map(app => app.key).join(',')}`;
    if (signature === hubSignature && target.childElementCount) return;
    hubSignature = signature;
    target.innerHTML = apps.map((app, index) => {
        const style = `--app-light: ${app.colors[0]}; --app-color: ${app.colors[1]}; --i: ${index};`;
        const action = app.soon ? 'disabled aria-disabled="true"' : `onclick="window.openHubApp('${app.key}')"`;
        if (app.featured) return `
        <button type="button" class="hub-app is-featured" style="${style}" ${action}>
            <span class="hub-hero-sparks" aria-hidden="true">${svgIcon('sparkles', 24, 1.8)}${svgIcon('sparkles', 14, 2)}${svgIcon('sparkles', 10, 2)}</span>
            <span class="hub-app-icon">${svgIcon(app.icon, 22, 2)}</span>
            <span class="hub-app-text">
                <span class="hub-app-title">${t(...app.title)}</span>
                <span class="hub-app-desc">${t(...app.desc)}</span>
            </span>
            <span class="hub-hero-cta"><span class="hub-hero-cta-label">${t('hub_ai_cta', 'Start chat')}</span>${svgIcon('chevronRight', 16, 2.6)}</span>
        </button>`;
        return `
        <button type="button" class="hub-app${app.soon ? ' is-soon' : ''}" style="${style}" ${action}>
            <span class="hub-app-mark" aria-hidden="true">${svgIcon(app.icon, 96, 1.4)}</span>
            <span class="hub-app-icon">${svgIcon(app.icon, 22, 2)}</span>
            <span class="hub-app-text">
                <span class="hub-app-title">${t(...app.title)}</span>
                <span class="hub-app-desc">${t(...app.desc)}</span>
            </span>
            ${app.soon ? `<span class="hub-app-soon">${t('hub_soon', 'Coming soon')}</span>` : `<span class="hub-app-go">${svgIcon('chevronRight', 16, 2.6)}</span>`}
        </button>`;
    }).join('');
}

function openHubApp(key) {
    const app = HUB_APPS.find(entry => entry.key === key && !entry.soon);
    if (!app) return;
    const fromHub = currentActiveTab === 'hub';
    app.open();
    if (fromHub && currentActiveTab !== 'hub') pushHistoryLevel('app');
}

// --- Media (Extras): the community's Nextcloud folder as a library. The server checks every request against the
// folder rights; this part shows what it sends: folders, thumbnails (Nextcloud's previews), the picture viewer,
// the PDF viewer, uploads and - for members with extended media rights - the rights of each folder. ---
let mediaStatus = { enabled: false, canManage: false, hasAccess: false };
let mediaFolder = '';
let mediaListing = null;
let mediaLoadedPath = null;
let mediaError = '';
let mediaRequestId = 0;
let mediaSort = (() => { try { return localStorage.getItem('agora-media-sort') || 'name'; } catch { return 'name'; } })();
// The order shown: folders and files as on screen (the viewer steps through the pictures in this order)
let mediaShownFiles = [];
let mediaShownFolders = [];
// Names selected in the open folder (to download or delete several at once)
const mediaSelected = new Set();

const MEDIA_KIND_ICONS = { image: 'image', pdf: 'fileText', video: 'play', audio: 'music', other: 'file' };
const MEDIA_LEVEL_LABELS = () => ({
    read: t('media_level_read', 'Read'),
    write: t('media_level_write', 'Write'),
    hide: t('media_level_hide', 'Hidden')
});
const mediaGroupName = group => (group.id === '*' ? t('media_all_members', 'All members') : group.name);
const mediaFolderLabel = path => (path ? `/${path}` : t('media_base_folder', 'Base folder'));
const mediaTileSize = () => thumbSize(window.innerWidth < 600 ? Math.ceil(window.innerWidth / 2) : 200, window.devicePixelRatio || 1);

async function loadMediaStatus() {
    if (!currentUser) return;
    try {
        mediaStatus = await apiJson('/media/status');
    } catch {
        mediaStatus = { enabled: false, canManage: false, hasAccess: false };
    }
    renderHub();
    // No (more) access to the base folder: the library is closed, back to Extras
    if (!mediaStatus.hasAccess && currentActiveTab === 'media') switchTab('hub');
}

/** Opens [path] in the library (from the hub, a folder, the breadcrumb or an address). */
function openMediaFolder(path = '') {
    if (path !== mediaFolder) clearMediaSelection();
    mediaFolder = path;
    if (currentActiveTab !== 'media') return switchTab('media');
    loadMediaFolder();
    document.querySelector('.container')?.scrollTo({ top: 0 });
}

// Folders seen before show at once from memory; the server is always asked again and the page only drawn anew when
// its answer differs (so deleted or new files show right away, and an unchanged folder does not flicker)
const MEDIA_CACHE_SIZE = 40;
const mediaCache = new Map();
function rememberMediaListing(path, listing) {
    mediaCache.delete(path);
    mediaCache.set(path, listing);
    if (mediaCache.size > MEDIA_CACHE_SIZE) mediaCache.delete(mediaCache.keys().next().value);
}

async function loadMediaFolder({ silent = false } = {}) {
    const path = mediaFolder;
    const requestId = ++mediaRequestId;
    if (mediaLoadedPath !== path || mediaError) {
        const cached = mediaCache.get(path);
        mediaListing = cached || null;
        mediaLoadedPath = cached ? path : null;
        mediaError = '';
        renderMedia({ fresh: !!cached });
    }
    // What is on the page now: the answer is compared with it
    const shown = mediaListing && mediaLoadedPath === path ? JSON.stringify(mediaListing) : null;
    try {
        const listing = await apiJson(`/media/list?path=${encodeURIComponent(path)}`, 'GET', undefined, t('media_load_failed', 'The folder could not be loaded'));
        if (requestId !== mediaRequestId) return;
        rememberMediaListing(path, listing);
        mediaListing = listing;
        mediaLoadedPath = path;
        mediaError = '';
        if (shown !== null && JSON.stringify(listing) === shown) {
            updateFabVisibility();
            syncUrl();
            return;
        }
    } catch (err) {
        if (requestId !== mediaRequestId) return;
        // A folder that is gone (or no longer visible): one level up
        if (err.status === 404 && path) {
            mediaCache.delete(path);
            showToast(t('media_folder_gone', 'This folder is not available.'), 'error');
            mediaFolder = parentPath(path);
            return loadMediaFolder();
        }
        if (!silent || !mediaListing) {
            mediaCache.delete(path);
            mediaListing = null;
            mediaLoadedPath = null;
            mediaError = err.status === 503 || err.status === 404 ? t('media_unavailable', 'There is nothing to see here yet.') : err.message;
        }
    }
    // Faded in only after the loading circle; a folder already on the page changes in place
    renderMedia({ fresh: shown === null });
    updateFabVisibility();
    syncUrl();
}

function mediaBack() {
    if (mediaFolder) {
        leaveHistoryLevels('folder');
        openMediaFolder(parentPath(mediaFolder));
    } else switchTab('hub');
}

/** A folder of the path above the open one: the history steps of the folders in between are left behind. */
function openMediaCrumb(path) {
    const depth = folder => breadcrumb(folder).length;
    leaveHistoryLevels('folder', depth(mediaFolder) - depth(path));
    openMediaFolder(path);
}

function setMediaSort(value) {
    mediaSort = value === 'newest' ? 'newest' : 'name';
    try { localStorage.setItem('agora-media-sort', mediaSort); } catch { /* private mode */ }
    renderMedia();
}

function renderMediaCrumbs() {
    const target = $('media-crumbs');
    if (!target) return;
    const crumbs = breadcrumb(mediaFolder);
    const access = mediaListing?.access;
    const badge = access === 'write' && !mediaStatus.canManage
        ? `<span class="media-access-badge is-write">${svgIcon('upload', 12, 2.2)}${t('media_access_write', 'You can add files here')}</span>`
        : access === 'read' ? `<span class="media-access-badge">${svgIcon('eye', 12, 2.2)}${t('media_access_read', 'Read only')}</span>` : '';
    // In the base folder the title says where you are; the path only appears below it
    target.hidden = !crumbs.length && !badge;
    target.innerHTML = `
        ${crumbs.length ? `<button type="button" class="media-crumb" onclick="openMediaCrumb('')">${svgIcon('folder', 14, 2.2)}<span>${t('media_title', 'Media')}</span></button>` : ''}
        ${crumbs.map((crumb, index) => `<span class="media-crumb-sep" aria-hidden="true">${svgIcon('chevronRight', 12, 2.4)}</span><button type="button" class="media-crumb${index === crumbs.length - 1 ? ' is-current" aria-current="page' : ''}" onclick="openMediaCrumb(${jsArg(crumb.path)})" title="${escapeHtml(crumb.name)}"><span>${escapeHtml(crumb.name)}</span></button>`).join('')}
        ${badge}`;
}

const mediaEntryMeta = entry => [formatSize(entry.size, uiLocale()), entry.modified ? formatDateFast(entry.modified) : ''].filter(Boolean).join(' · ');

// The round mark in the corner of a folder or tile: shown on hover and while selecting, filled when selected
const mediaCheck = name => `<button type="button" class="media-check" data-media-check aria-pressed="false" aria-label="${escapeHtml(t('media_select_item', 'Select {name}', { name }))}">${svgIcon('check', 14, 3)}</button>`;

function mediaFolderCard(folder) {
    const manage = mediaStatus.canManage;
    const hidden = manage && folder.hiddenFor?.length
        ? `<span class="media-folder-mark is-hidden" title="${escapeHtml(t('media_hidden_for_some', 'Hidden for some groups'))}">${svgIcon('eyeOff', 14, 2.2)}</span>` : '';
    const passage = folder.access === 'none' && !manage;
    // The shield turns blue on folders with rights of their own
    const rightsTitle = folder.hasRules ? t('media_has_rights', 'Has rights of its own') : t('media_rights_title', 'Folder rights');
    const meta = mediaEntryMeta(folder);
    return `
        <div class="media-folder${passage ? ' is-passage' : ''}" data-media-name="${escapeHtml(folder.name)}">
            <button type="button" class="media-folder-open" data-media-open title="${escapeHtml(folder.name)}">
                <span class="media-folder-icon">${svgIcon('folder', 22, 2)}</span>
                <span class="media-folder-text">
                    <span class="media-folder-name">${escapeHtml(folder.name)}</span>
                    ${meta ? `<span class="media-folder-meta">${escapeHtml(meta)}</span>` : ''}
                </span>
                ${hidden}
            </button>
            ${mediaCheck(folder.name)}
            ${manage ? `<button type="button" class="media-folder-rights${folder.hasRules ? ' is-set' : ''}" onclick="openMediaRights(${jsArg(folder.path)})" title="${escapeHtml(rightsTitle)}" aria-label="${escapeHtml(t('media_rights_of', 'Rights of {name}', { name: folder.name }))}">${svgIcon('shield', 16, 2)}</button>` : ''}
        </div>`;
}

function mediaFileTile(file) {
    const icon = svgIcon(MEDIA_KIND_ICONS[file.kind] || 'file', 30, 1.6);
    const thumb = file.hasPreview
        ? `<img class="media-thumb-img" src="${escapeHtml(previewUrl(API, file, mediaTileSize()))}" alt="" loading="lazy" decoding="async" draggable="false">`
        : '';
    const meta = mediaEntryMeta(file);
    // Pictures speak for themselves; everything else says what it is (PDF, MP4, DOCX ...)
    const label = file.kind === 'image' ? '' : typeLabel(file.name);
    return `
        <div class="media-tile kind-${escapeHtml(file.kind)}" data-media-name="${escapeHtml(file.name)}">
            <button type="button" class="media-tile-open" data-media-open title="${escapeHtml(file.name)}">
                <span class="media-thumb${file.hasPreview ? '' : ' is-icon'}">
                    <span class="media-thumb-icon">${icon}</span>
                    ${thumb}
                    ${file.kind === 'video' && file.hasPreview ? `<span class="media-thumb-play" aria-hidden="true">${svgIcon('play', 18, 2)}</span>` : ''}
                    ${label ? `<span class="media-thumb-type">${escapeHtml(label)}</span>` : ''}
                </span>
                <span class="media-tile-name">${escapeHtml(file.name)}</span>
                <span class="media-tile-meta">${escapeHtml(meta)}</span>
            </button>
            ${mediaCheck(file.name)}
        </div>`;
}

function renderMedia({ fresh = false } = {}) {
    const list = $('media-list');
    if (!list) return;
    setValue('media-sort', mediaSort);
    setText('media-title', mediaFolder ? breadcrumb(mediaFolder).pop().name : t('media_title', 'Media'));
    show('media-rights-btn', mediaStatus.canManage && !!mediaListing, 'inline-flex');
    show('media-rules-btn', mediaStatus.canManage, 'inline-flex');
    renderMediaCrumbs();
    if (mediaError) {
        list.innerHTML = `
            <div class="polls-empty">
                <span class="polls-empty-icon media-empty-icon">${svgIcon('folder', 26, 1.8)}</span>
                <span class="polls-empty-title">${escapeHtml(mediaError)}</span>
                <button type="button" class="btn btn-secondary btn-small" onclick="loadMediaFolder()">${t('btn_retry', 'Try again')}</button>
            </div>`;
        return;
    }
    if (!mediaListing) {
        // One calm circle (only after a moment, so fast folders do not flash) instead of tiles that may never come
        list.innerHTML = `<div class="media-loading" aria-busy="true" role="status"><span class="spinner"></span><span class="sr-only">${t('loading', 'Loading…')}</span></div>`;
        return;
    }
    const folders = sortEntries(mediaListing.folders, mediaSort === 'newest' ? 'newest' : 'name');
    mediaShownFolders = folders;
    mediaShownFiles = sortEntries(mediaListing.files, mediaSort);
    // Deleted or gone on another device: no longer selected
    const present = new Set([...folders, ...mediaShownFiles].map(entry => entry.name));
    for (const name of [...mediaSelected]) if (!present.has(name)) mediaSelected.delete(name);
    syncMediaSelection();
    if (!folders.length && !mediaShownFiles.length) {
        list.innerHTML = `
            <div class="polls-empty">
                <span class="polls-empty-icon media-empty-icon">${svgIcon('folder', 26, 1.8)}</span>
                <span class="polls-empty-title">${t('media_empty', 'This folder is empty')}</span>
                ${mediaListing.access === 'write' ? `<span class="polls-empty-hint">${t('media_empty_hint', 'Add files with the plus at the bottom right, or drop them here.')}</span>` : ''}
            </div>`;
        return;
    }
    const section = (label, count) => `<h2 class="media-section-label">${label}<span class="media-section-count">${count}</span></h2>`;
    list.innerHTML = `<div class="media-content${fresh ? ' is-fresh' : ''}">
        ${folders.length ? `${section(t('media_section_folders', 'Folders'), folders.length)}<div class="media-folders">${folders.map(mediaFolderCard).join('')}</div>` : ''}
        ${mediaShownFiles.length ? `${section(t('media_section_files', 'Files'), mediaShownFiles.length)}<div class="media-grid">${mediaShownFiles.map(mediaFileTile).join('')}</div>` : ''}
    </div>`;
    // Thumbnails fade in when they arrive; without one (no preview for this file) the type icon stays
    list.querySelectorAll('.media-thumb-img').forEach(img => {
        const done = () => img.parentElement.classList.add('is-loaded');
        const failed = () => {
            img.parentElement.classList.add('is-icon');
            img.remove();
        };
        if (img.complete && img.naturalWidth) done();
        else {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', failed, { once: true });
        }
    });
    syncMediaSelection();
}

function openMediaFile(index) {
    const file = mediaShownFiles[index];
    if (!file) return;
    if (opensInViewer(file)) return openMediaViewer(index);
    if (opensAsPdf(file)) return openMediaPdf(file);
    if (opensInPlayer(file)) return openMediaPlayer(file);
    // Everything else is downloaded (the server only ever sends it as a download)
    const link = Object.assign(document.createElement('a'), { href: fileUrl(API, file, { download: true }), download: file.name });
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// --- Several at once: right click (or the menu key) opens a menu for one entry or the selection; holding a finger on
// an entry, the round mark on hover, Ctrl / Cmd + click and Shift + click select. Selected entries are downloaded
// together (one ZIP archive from the server) or deleted where the member may write. ---
let mediaSelectAnchor = null;
let mediaSuppressClick = false;

/** The folder or file of that name in the open folder: { name, folder, file, index } or null. */
function mediaEntry(name) {
    const folder = mediaShownFolders.find(entry => entry.name === name);
    if (folder) return { name, folder };
    const index = mediaShownFiles.findIndex(entry => entry.name === name);
    return index >= 0 ? { name, file: mediaShownFiles[index], index } : null;
}
const mediaOrder = () => [...mediaShownFolders, ...mediaShownFiles].map(entry => entry.name);
/** Files where the member may write in the folder; folders only when they may write everywhere in them. */
const canDeleteMediaEntry = entry => mediaListing?.access === 'write' && (entry.file ? true : !!entry.folder?.canDelete);

/** Brings the page in line with the selection (classes and the bar only: thumbnails are not drawn again). */
function syncMediaSelection() {
    const count = mediaSelected.size;
    $('media')?.classList.toggle('is-selecting', count > 0);
    document.querySelectorAll('#media-list [data-media-name]').forEach(item => {
        const selected = mediaSelected.has(item.dataset.mediaName);
        item.classList.toggle('is-selected', selected);
        item.querySelector('[data-media-check]')?.setAttribute('aria-pressed', String(selected));
    });
    const bar = $('media-selectbar');
    if (bar) {
        bar.hidden = !count;
        setText('media-selectbar-count', count === 1 ? t('media_selected_one', '1 selected') : t('media_selected', '{count} selected', { count }));
        const entries = [...mediaSelected].map(mediaEntry).filter(Boolean);
        const all = mediaOrder().length;
        setText('media-select-all-label', count >= all ? t('media_select_none', 'Select none') : t('media_select_all', 'Select all'));
        const remove = $('media-select-delete');
        show('media-select-delete', mediaListing?.access === 'write', 'inline-flex');
        if (remove) {
            const allowed = entries.length > 0 && entries.every(canDeleteMediaEntry);
            remove.disabled = !allowed;
            remove.title = allowed ? t('media_delete', 'Delete') : t('media_delete_not_allowed', 'You may not delete everything in a selected folder.');
        }
    }
    updateFabVisibility();
}

function toggleMediaSelected(name, { range = false } = {}) {
    if (!mediaEntry(name)) return;
    if (range && mediaSelectAnchor && mediaSelectAnchor !== name) {
        const order = mediaOrder();
        const [from, to] = [order.indexOf(mediaSelectAnchor), order.indexOf(name)].sort((a, b) => a - b);
        if (from >= 0) order.slice(from, to + 1).forEach(entry => mediaSelected.add(entry));
    } else if (mediaSelected.has(name)) {
        mediaSelected.delete(name);
    } else {
        mediaSelected.add(name);
    }
    mediaSelectAnchor = name;
    syncMediaSelection();
}

function clearMediaSelection() {
    if (!mediaSelected.size) return;
    mediaSelected.clear();
    mediaSelectAnchor = null;
    syncMediaSelection();
}

function toggleSelectAllMedia() {
    const order = mediaOrder();
    if (mediaSelected.size >= order.length) return clearMediaSelection();
    order.forEach(name => mediaSelected.add(name));
    syncMediaSelection();
}

function openMediaEntry(name) {
    const entry = mediaEntry(name);
    if (entry?.folder) {
        pushHistoryLevel('folder');
        openMediaFolder(entry.folder.path);
    }
    else if (entry?.file) openMediaFile(entry.index);
}

function saveMediaLink(href, name = '') {
    const link = Object.assign(document.createElement('a'), { href, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/** One file comes as it is; several (or a folder) as one ZIP archive the server puts together. */
async function downloadMediaEntries(names) {
    const entries = names.map(mediaEntry).filter(Boolean);
    if (!entries.length) return;
    if (entries.length === 1 && entries[0].file) return saveMediaLink(fileUrl(API, entries[0].file, { download: true }), entries[0].name);
    const folder = mediaFolder;
    await once('media-download', () => mediaBusy(() => attempt(async () => {
        showToast(t('media_download_preparing', 'Preparing the download…'));
        const ticket = await apiJson('/media/download', 'POST', { path: folder, names: entries.map(entry => entry.name) });
        saveMediaLink(`${API}/media/download/${encodeURIComponent(ticket.id)}`);
    }, err => err.message || t('media_download_failed', 'The download could not be prepared'))));
}

/** The selection bar waits (its buttons off) while [action] runs. */
async function mediaBusy(action) {
    const bar = $('media-selectbar');
    bar?.classList.add('is-busy');
    try {
        return await action();
    } finally {
        bar?.classList.remove('is-busy');
    }
}

async function deleteMediaEntries(names) {
    const entries = names.map(mediaEntry).filter(Boolean);
    if (!entries.length || !entries.every(canDeleteMediaEntry)) return;
    const [first] = entries;
    const question = entries.length > 1
        ? t('media_delete_confirm_many', 'Delete {count} items? Folders go with everything in them.', { count: entries.length })
        : first.folder
            ? t('media_delete_confirm_folder', 'Delete the folder "{name}" with everything in it?', { name: first.name })
            : t('media_delete_confirm_file', 'Delete "{name}"?', { name: first.name });
    if (!confirmAction(question)) return;
    const folder = mediaFolder;
    await once('media-delete', () => mediaBusy(() => attempt(async () => {
        const result = await apiJson('/media/delete', 'POST', { path: folder, names: entries.map(entry => entry.name) });
        const deleted = result.deleted || [];
        deleted.forEach(name => mediaSelected.delete(name));
        if (result.failed?.length) {
            showToast(t('media_delete_partly', '{count} could not be deleted: {error}', { count: result.failed.length, error: result.failed[0].error }), 'error');
        } else {
            showToast(deleted.length === 1 ? t('media_deleted_one', 'Deleted') : t('media_deleted', '{count} items deleted', { count: deleted.length }));
        }
        if (mediaFolder === folder) await loadMediaFolder({ silent: true });
    }, err => err.message || t('media_delete_failed', 'Could not delete'))));
}

const downloadMediaSelection = () => downloadMediaEntries([...mediaSelected]);
const deleteMediaSelection = () => deleteMediaEntries([...mediaSelected]);

// --- The menu of an entry (right click, the menu key or Shift + F10) ---
function closeMediaMenu() {
    const menu = $('media-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menu.innerHTML = '';
}

function openMediaMenu(name, x, y) {
    const menu = $('media-menu');
    const entry = mediaEntry(name);
    if (!menu || !entry) return;
    // On a selected entry the menu is for the whole selection
    const names = mediaSelected.has(name) && mediaSelected.size > 1 ? [...mediaSelected] : [name];
    const several = names.length > 1;
    const deletable = names.map(mediaEntry).filter(Boolean).every(canDeleteMediaEntry);
    const items = [
        !several && { action: 'open', icon: entry.folder ? 'folder' : 'eye', label: t('media_open', 'Open') },
        { action: 'download', icon: 'download', label: several ? t('media_download_count', 'Download {count}', { count: names.length }) : t('media_download', 'Download') },
        { action: 'select', icon: 'check', label: mediaSelected.has(name) ? t('media_unselect', 'Unselect') : t('media_select', 'Select') },
        mediaListing?.access === 'write' && { action: 'delete', icon: 'trash', danger: true, disabled: !deletable, label: several ? t('media_delete_count', 'Delete {count}', { count: names.length }) : t('media_delete', 'Delete') }
    ].filter(Boolean);
    menu.innerHTML = `
        <div class="media-menu-title">${escapeHtml(several ? t('media_selected', '{count} selected', { count: names.length }) : name)}</div>
        ${items.map(item => `<button type="button" role="menuitem" class="media-menu-item${item.danger ? ' is-danger' : ''}" data-action="${item.action}"${item.disabled ? ` disabled title="${escapeHtml(t('media_delete_not_allowed', 'You may not delete everything in a selected folder.'))}"` : ''}>${svgIcon(item.icon, 16, 2.2)}<span>${escapeHtml(item.label)}</span></button>`).join('')}`;
    menu.onclick = e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        closeMediaMenu();
        if (action === 'open') openMediaEntry(name);
        else if (action === 'download') downloadMediaEntries(names);
        else if (action === 'select') toggleMediaSelected(name);
        else if (action === 'delete') deleteMediaEntries(names);
    };
    menu.hidden = false;
    // Kept on screen
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector('.media-menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

(() => {
    const list = $('media-list');
    if (!list) return;
    const LONG_PRESS_MS = 480;
    let press = null;
    let lastPointer = 'mouse';
    const cancelPress = () => {
        if (press) clearTimeout(press.timer);
        press = null;
    };
    list.addEventListener('pointerdown', e => {
        lastPointer = e.pointerType;
        mediaSuppressClick = false;
        const item = e.target.closest('[data-media-name]');
        if (!item || e.pointerType === 'mouse' || e.target.closest('.media-folder-rights, [data-media-check]')) return;
        const name = item.dataset.mediaName;
        press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
            press = null;
            mediaSuppressClick = true;
            navigator.vibrate?.(12);
            toggleMediaSelected(name);
        }, LONG_PRESS_MS) };
    });
    list.addEventListener('pointermove', e => {
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => list.addEventListener(type, cancelPress));

    list.addEventListener('click', e => {
        const item = e.target.closest('[data-media-name]');
        if (!item || e.target.closest('.media-folder-rights')) return;
        const name = item.dataset.mediaName;
        if (mediaSuppressClick) {
            mediaSuppressClick = false;
            return e.preventDefault();
        }
        if (e.target.closest('[data-media-check]') || mediaSelected.size || e.ctrlKey || e.metaKey || e.shiftKey) {
            e.preventDefault();
            return toggleMediaSelected(name, { range: e.shiftKey });
        }
        if (e.target.closest('[data-media-open]')) openMediaEntry(name);
    });

    list.addEventListener('contextmenu', e => {
        const item = e.target.closest('[data-media-name]');
        if (!item) return;
        e.preventDefault();
        // A finger held down selects (above) instead of opening the menu of the browser
        if (lastPointer === 'touch' || lastPointer === 'pen') return;
        const keyboard = !e.clientX && !e.clientY;
        const rect = item.getBoundingClientRect();
        openMediaMenu(item.dataset.mediaName, keyboard ? rect.left + 16 : e.clientX, keyboard ? rect.top + 16 : e.clientY);
    });

    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('#media-menu')) closeMediaMenu();
    }, true);
    window.addEventListener('resize', closeMediaMenu);
    document.addEventListener('scroll', closeMediaMenu, true);
    document.addEventListener('keydown', e => {
        if (currentActiveTab !== 'media' || document.querySelector('.modal.show')) return;
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
        if (e.key === 'Escape') {
            if (!$('media-menu')?.hidden) closeMediaMenu();
            else clearMediaSelection();
        } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && mediaListing) {
            e.preventDefault();
            mediaOrder().forEach(name => mediaSelected.add(name));
            syncMediaSelection();
        } else if (!typing && e.key === 'Delete' && mediaSelected.size && !$('media-select-delete')?.disabled) {
            deleteMediaSelection();
        }
    });
})();

// --- Picture viewer: the small preview of the tile at once, then a preview as large as the screen; zoomed in (two
// fingers, double tap, mouse wheel, the magnifier) the largest preview takes over so it stays sharp. The original is
// never loaded for this (it may be DNG, HEIC or another format the browser cannot show); only GIFs (they move) and
// pictures without any preview in a format the browser shows ---
let viewerPictures = [];
let viewerIndex = 0;
let viewerToken = 0;
let viewerView = { scale: 1, x: 0, y: 0 };
let viewerSharp = false;
const VIEWER_DOUBLE_TAP_ZOOM = 2.5;

/** The screen-sized picture: a preview; the file itself only for GIFs and as the last way out (see above). */
function viewerLargeUrl(file) {
    if (viewerNeedsOriginal(file)) return fileUrl(API, file);
    if (file.hasPreview) return previewUrl(API, file, viewerSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1));
    return browserShowsOriginal(file) ? fileUrl(API, file) : '';
}

function openMediaViewer(index) {
    viewerPictures = mediaShownFiles.filter(opensInViewer);
    viewerIndex = Math.max(0, viewerPictures.indexOf(mediaShownFiles[index]));
    const modal = $('media-viewer-modal');
    modal._customOnClose = () => {
        viewerToken++;
        const img = $('media-viewer-img');
        if (img) img.removeAttribute('src');
    };
    openModal('media-viewer-modal');
    showViewerPicture();
}

/** Shows [viewerView] (clamped to the picture); [animate] for jumps (double tap, back to fit), not for fingers. */
function setViewerView(view, animate = false) {
    const img = $('media-viewer-img');
    const box = { width: img.clientWidth, height: img.clientHeight };
    viewerView = clampView(view, box, { width: img.naturalWidth, height: img.naturalHeight });
    img.classList.toggle('is-animating', animate);
    img.style.transform = viewerView.scale === 1 ? '' : `translate(${viewerView.x}px, ${viewerView.y}px) scale(${viewerView.scale})`;
    const zoomed = viewerView.scale > 1;
    $('media-viewer-stage').classList.toggle('is-zoomed', zoomed);
    $('media-viewer-zoom')?.setAttribute('aria-pressed', String(zoomed));
    if (viewerView.scale > 1.3) sharpenViewerPicture();
}

/** Zoomed in: the largest preview replaces the screen-sized one, once per picture. */
function sharpenViewerPicture() {
    const file = viewerPictures[viewerIndex];
    if (viewerSharp || !file || viewerNeedsOriginal(file) || !file.hasPreview) return;
    viewerSharp = true;
    const token = viewerToken;
    const loading = $('media-viewer-loading');
    loading.hidden = false;
    const sharp = new Image();
    sharp.decoding = 'async';
    sharp.onload = () => {
        if (token !== viewerToken) return;
        $('media-viewer-img').src = sharp.src;
        loading.hidden = true;
    };
    sharp.onerror = () => { if (token === viewerToken) loading.hidden = true; };
    sharp.src = previewUrl(API, file, ZOOM_PREVIEW_SIZE);
}

function showViewerPicture() {
    const file = viewerPictures[viewerIndex];
    if (!file) return;
    const token = ++viewerToken;
    const img = $('media-viewer-img');
    const stage = $('media-viewer-stage');
    const loading = $('media-viewer-loading');
    viewerSharp = false;
    viewerView = { scale: 1, x: 0, y: 0 };
    img.classList.remove('is-animating');
    img.style.transform = '';
    stage.classList.remove('is-zoomed', 'has-error');
    stage.querySelector('.media-viewer-error')?.remove();
    setText('media-viewer-name', file.name);
    setText('media-viewer-meta', [formatSize(file.size, uiLocale()), file.modified ? formatDateFast(file.modified) : ''].filter(Boolean).join(' · '));
    setText('media-viewer-count', viewerPictures.length > 1 ? `${viewerIndex + 1} / ${viewerPictures.length}` : '');
    show('media-viewer-prev', viewerPictures.length > 1, 'flex');
    show('media-viewer-next', viewerPictures.length > 1, 'flex');
    const download = $('media-viewer-download');
    download.href = fileUrl(API, file, { download: true });
    download.setAttribute('download', file.name);
    img.alt = file.name;
    // The thumbnail is already in the browser's cache: shown right away, slightly soft, until the large one is there
    const small = file.hasPreview ? previewUrl(API, file, mediaTileSize()) : '';
    if (small) img.src = small;
    else img.removeAttribute('src');
    img.classList.toggle('is-soft', !!small);
    loading.hidden = false;
    const large = new Image();
    large.decoding = 'async';
    large.onload = () => {
        if (token !== viewerToken) return;
        // Zoomed in meanwhile: the sharper preview is on its way, this one would be a step back
        if (!viewerSharp) img.src = large.src;
        img.classList.remove('is-soft');
        loading.hidden = true;
    };
    large.onerror = () => {
        if (token !== viewerToken) return;
        loading.hidden = true;
        // No large preview: the original, if the browser can show it; else say so and offer the download
        if (!viewerNeedsOriginal(file) && file.hasPreview && browserShowsOriginal(file)) {
            const original = new Image();
            original.onload = () => { if (token === viewerToken) { img.src = original.src; img.classList.remove('is-soft'); } };
            original.onerror = () => { if (token === viewerToken) showViewerError(file); };
            original.src = fileUrl(API, file);
        } else if (!small) showViewerError(file);
    };
    const largeUrl = viewerLargeUrl(file);
    if (largeUrl) large.src = largeUrl;
    else {
        // Neither a preview nor a format the browser shows (a camera file without preview): only the download
        loading.hidden = true;
        showViewerError(file);
    }
    // The neighbours are fetched meanwhile: swiping on shows them at once
    for (const direction of [1, -1]) {
        const next = viewerPictures[neighbourIndex(viewerPictures, viewerIndex, direction)];
        const nextUrl = next && next !== file ? viewerLargeUrl(next) : '';
        if (nextUrl) new Image().src = nextUrl;
    }
}

function showViewerError(file) {
    const stage = $('media-viewer-stage');
    stage.classList.add('has-error');
    $('media-viewer-img').removeAttribute('src');
    stage.insertAdjacentHTML('beforeend', `
        <div class="media-viewer-error">
            ${svgIcon('image', 34, 1.6)}
            <span>${t('media_no_preview', 'This picture cannot be shown here.')}</span>
            <a class="btn btn-secondary btn-small" href="${escapeHtml(fileUrl(API, file, { download: true }))}" download="${escapeHtml(file.name)}">${t('media_download', 'Download')}</a>
        </div>`);
}

function stepMediaViewer(direction) {
    const next = neighbourIndex(viewerPictures, viewerIndex, direction);
    if (next < 0) return;
    viewerIndex = next;
    showViewerPicture();
}

/** The magnifier: in to 2.5x around the middle, or back to the whole picture. */
function toggleMediaZoom() {
    if ($('media-viewer-stage').classList.contains('has-error')) return;
    setViewerView(viewerView.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(viewerView, { x: 0, y: 0 }, VIEWER_DOUBLE_TAP_ZOOM), true);
}

// Keys: arrows step (zoomed in: they move the picture), + / - zoom, 0 shows the whole picture
document.addEventListener('keydown', e => {
    if (modalStack[modalStack.length - 1] !== 'media-viewer-modal') return;
    const zoomed = viewerView.scale > 1;
    const moves = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
    if (zoomed && moves[e.key]) {
        e.preventDefault();
        setViewerView({ ...viewerView, x: viewerView.x + moves[e.key][0], y: viewerView.y + moves[e.key][1] }, true);
    } else if (e.key === 'ArrowLeft') stepMediaViewer(-1);
    else if (e.key === 'ArrowRight') stepMediaViewer(1);
    else if (e.key === '+' || e.key === '=') setViewerView(zoomAt(viewerView, { x: 0, y: 0 }, viewerView.scale * 1.5), true);
    else if (e.key === '-') setViewerView(zoomAt(viewerView, { x: 0, y: 0 }, viewerView.scale / 1.5), true);
    else if (e.key === '0') setViewerView({ scale: 1, x: 0, y: 0 }, true);
});

// Fingers and mouse (pointer events cover both): two fingers zoom around their middle and move the picture, one
// finger moves a zoomed picture or - not zoomed - swipes to the next one, a double tap zooms in or out, the mouse
// wheel zooms where the mouse is
(() => {
    const stage = $('media-viewer-stage');
    if (!stage) return;
    const img = $('media-viewer-img');
    const pointers = new Map();
    let gesture = null;
    let lastTap = { time: 0, x: 0, y: 0 };
    // Measured from the middle of the picture's box (its place without zoom)
    const at = e => {
        const box = stage.getBoundingClientRect();
        return { x: e.clientX - box.left - (img.offsetLeft + img.offsetWidth / 2), y: e.clientY - box.top - (img.offsetTop + img.offsetHeight / 2) };
    };
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const begin = () => {
        const points = [...pointers.values()];
        if (points.length >= 2) gesture = { kind: 'pinch', view: { ...viewerView }, distance: Math.max(1, distance(points[0], points[1])), middle: middle(points[0], points[1]) };
        else if (points.length === 1) gesture = { kind: viewerView.scale > 1 ? 'pan' : 'swipe', view: { ...viewerView }, start: points[0], moved: false };
        else gesture = null;
    };
    const tap = point => {
        const now = Date.now();
        if (now - lastTap.time < 320 && distance(point, lastTap) < 30) {
            lastTap = { time: 0, x: 0, y: 0 };
            setViewerView(viewerView.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(viewerView, point, VIEWER_DOUBLE_TAP_ZOOM), true);
        } else lastTap = { time: now, ...point };
    };
    stage.addEventListener('pointerdown', e => {
        if ((e.pointerType === 'mouse' && e.button !== 0) || stage.classList.contains('has-error') || !img.getAttribute('src')) return;
        try { stage.setPointerCapture(e.pointerId); } catch { /* already gone */ }
        pointers.set(e.pointerId, at(e));
        begin();
    });
    stage.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId) || !gesture) return;
        pointers.set(e.pointerId, at(e));
        const points = [...pointers.values()];
        if (gesture.kind === 'pinch' && points.length >= 2) {
            setViewerView(pinchView(gesture.view, gesture.middle, middle(points[0], points[1]), gesture.view.scale * distance(points[0], points[1]) / gesture.distance));
            return;
        }
        const dx = points[0].x - gesture.start.x;
        const dy = points[0].y - gesture.start.y;
        if (Math.hypot(dx, dy) > 8) gesture.moved = true;
        if (gesture.kind === 'pan') setViewerView({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy });
        // Not zoomed: the picture follows the finger sideways, so a swipe feels like turning a page
        else if (gesture.moved && viewerPictures.length > 1) {
            img.classList.remove('is-animating');
            img.style.transform = `translateX(${dx}px)`;
        }
    });
    const end = e => {
        if (!pointers.has(e.pointerId)) return;
        const point = pointers.get(e.pointerId);
        pointers.delete(e.pointerId);
        const finished = gesture;
        if (finished?.kind === 'swipe' && pointers.size === 0) {
            const dx = point.x - finished.start.x;
            const dy = point.y - finished.start.y;
            if (viewerPictures.length > 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                gesture = null;
                return stepMediaViewer(dx < 0 ? 1 : -1);
            }
            if (finished.moved) setViewerView({ scale: 1, x: 0, y: 0 }, true);
            else if (e.type === 'pointerup') tap(point);
        } else if (finished?.kind === 'pan' && pointers.size === 0 && !finished.moved && e.type === 'pointerup') {
            tap(point);
        } else if (finished?.kind === 'pinch' && viewerView.scale < 1.08) {
            setViewerView({ scale: 1, x: 0, y: 0 }, true);
        }
        // One finger left after zooming: it goes on moving the picture
        begin();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', e => {
        if (stage.classList.contains('has-error') || !img.getAttribute('src')) return;
        e.preventDefault();
        setViewerView(zoomAt(viewerView, at(e), viewerView.scale * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: false });
    // A new size of the window: the zoomed picture has to stay in its box
    window.addEventListener('resize', () => { if (viewerView.scale > 1) setViewerView(viewerView); });
})();

// --- Video and music: played right in the app (the browser's own controls); a format the browser cannot play
// is offered as a download ---
function openMediaPlayer(file) {
    const stage = $('media-player-stage');
    setText('media-player-name', file.name);
    setText('media-player-meta', [formatSize(file.size, uiLocale()), file.modified ? formatDateFast(file.modified) : ''].filter(Boolean).join(' · '));
    const download = $('media-player-download');
    download.href = fileUrl(API, file, { download: true });
    download.setAttribute('download', file.name);
    const src = escapeHtml(fileUrl(API, file));
    const poster = file.hasPreview ? escapeHtml(previewUrl(API, file, viewerSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1))) : '';
    stage.innerHTML = file.kind === 'video'
        ? `<video class="media-player-video" controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ''} src="${src}"></video>`
        : `<div class="media-player-audio">
                <span class="media-player-audio-icon">${svgIcon('music', 46, 1.6)}</span>
                <span class="media-player-audio-name">${escapeHtml(file.name)}</span>
                <audio class="media-player-audio-el" controls preload="metadata" src="${src}"></audio>
            </div>`;
    const player = stage.querySelector('video, audio');
    player.addEventListener('error', () => {
        stage.innerHTML = `
            <div class="media-viewer-error">
                ${svgIcon(file.kind === 'video' ? 'play' : 'music', 34, 1.6)}
                <span>${file.kind === 'video' ? t('media_video_failed', 'This video cannot be played in this browser.') : t('media_audio_failed', 'This file cannot be played in this browser.')}</span>
                <a class="btn btn-secondary btn-small" href="${escapeHtml(fileUrl(API, file, { download: true }))}" download="${escapeHtml(file.name)}">${t('media_download', 'Download')}</a>
            </div>`;
    }, { once: true });
    $('media-player-modal')._customOnClose = () => {
        // Stops playing and loading at once (only taking it out of the page leaves the download running)
        player.pause();
        player.removeAttribute('src');
        player.load();
        stage.innerHTML = '';
    };
    openModal('media-player-modal');
    // Opened with a tap: browsers let it start right away; one that does not shows its play button
    player.play().catch(() => {});
}

// --- PDF viewer: the browser's own on computers (search, print); pdf.js on phones and tablets, whose browsers
// show a PDF in a page only as its first page or not at all ---
const PDFJS_BASE = '/assets/vendor/pdfjs/';
let pdfjsLoading = null;
let pdfView = null;
const usesNativePdfViewer = () => navigator.pdfViewerEnabled === true && !window.matchMedia('(pointer: coarse)').matches;

function loadPdfJs() {
    pdfjsLoading ||= import(`${PDFJS_BASE}pdf.min.mjs`).then(lib => {
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
        return lib;
    }).catch(err => {
        pdfjsLoading = null;
        throw err;
    });
    return pdfjsLoading;
}

function closePdfView() {
    if (!pdfView) return;
    pdfView.observer?.disconnect();
    pdfView.loadingTask?.destroy();
    pdfView = null;
}

function openMediaPdf(file) {
    const stage = $('media-pdf-stage');
    setText('media-pdf-name', file.name);
    setText('media-pdf-meta', formatSize(file.size, uiLocale()));
    const download = $('media-pdf-download');
    download.href = fileUrl(API, file, { download: true });
    download.setAttribute('download', file.name);
    closePdfView();
    $('media-pdf-modal')._customOnClose = () => {
        closePdfView();
        stage.innerHTML = '';
    };
    const native = usesNativePdfViewer();
    $('media-pdf-zoom').hidden = native;
    stage.classList.toggle('is-native', native);
    stage.innerHTML = native
        ? `<iframe class="media-pdf-frame" src="${escapeHtml(fileUrl(API, file))}" title="${escapeHtml(file.name)}"></iframe>`
        : `<div class="media-pdf-loading"><span class="media-viewer-loading"></span></div>`;
    openModal('media-pdf-modal');
    if (!native) renderPdfWithPdfJs(file);
}

async function renderPdfWithPdfJs(file) {
    const stage = $('media-pdf-stage');
    const view = { file, zoom: 1, pages: [] };
    pdfView = view;
    try {
        const lib = await loadPdfJs();
        if (pdfView !== view) return;
        view.loadingTask = lib.getDocument({ url: fileUrl(API, file), enableXfa: false });
        view.doc = await view.loadingTask.promise;
        if (pdfView !== view) return;
        const first = (await view.doc.getPage(1)).getViewport({ scale: 1 });
        view.ratio = first.height / first.width;
        const pages = view.doc.numPages === 1 ? t('media_pdf_pages_one', '1 page') : t('media_pdf_pages', '{count} pages', { count: view.doc.numPages });
        setText('media-pdf-meta', [pages, formatSize(file.size, uiLocale())].join(' · '));
        stage.innerHTML = Array.from({ length: view.doc.numPages }, (_, i) =>
            `<div class="media-pdf-page" data-page="${i + 1}" style="aspect-ratio: 1 / ${view.ratio};"><canvas></canvas></div>`).join('');
        view.observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) renderPdfPage(view, entry.target);
        }, { root: stage, rootMargin: '800px 0px' });
        layoutPdfPages(view);
    } catch (err) {
        if (pdfView !== view) return;
        console.warn('PDF could not be shown:', err);
        stage.innerHTML = `
            <div class="media-viewer-error">
                ${svgIcon('fileText', 34, 1.6)}
                <span>${t('media_pdf_failed', 'This PDF cannot be shown here.')}</span>
                <a class="btn btn-secondary btn-small" href="${escapeHtml(fileUrl(API, file, { download: true }))}" download="${escapeHtml(file.name)}">${t('media_download', 'Download')}</a>
            </div>`;
    }
}

/** Sizes the page boxes for the zoom and (re)draws the ones in view. */
function layoutPdfPages(view) {
    const stage = $('media-pdf-stage');
    const width = Math.min(stage.clientWidth - 24, 960) * view.zoom;
    stage.querySelectorAll('.media-pdf-page').forEach(page => {
        page.style.width = `${Math.round(width)}px`;
        page.dataset.drawn = '';
        view.observer.unobserve(page);
        view.observer.observe(page);
    });
}

async function renderPdfPage(view, box) {
    const number = Number(box.dataset.page);
    const width = box.getBoundingClientRect().width;
    const drawn = `${Math.round(width)}`;
    if (box.dataset.drawn === drawn || box.dataset.drawing === drawn) return;
    box.dataset.drawing = drawn;
    try {
        const page = await view.doc.getPage(number);
        if (pdfView !== view) return;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 3);
        const viewport = page.getViewport({ scale });
        // A fresh canvas per drawing: a zoom while a page is still drawing must not draw into the same one
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        box.style.aspectRatio = `${base.width} / ${base.height}`;
        await page.render({ canvas, viewport }).promise;
        if (pdfView !== view || box.dataset.drawing !== drawn) return;
        box.replaceChildren(canvas);
        box.dataset.drawn = drawn;
    } catch (err) {
        if (pdfView === view) console.warn(`PDF page ${number} could not be drawn:`, err);
    } finally {
        if (box.dataset.drawing === drawn) box.dataset.drawing = '';
    }
}

function zoomMediaPdf(direction) {
    if (!pdfView?.doc) return;
    const stage = $('media-pdf-stage');
    const anchor = stage.scrollTop / Math.max(1, stage.scrollHeight);
    pdfView.zoom = Math.min(3, Math.max(0.5, pdfView.zoom * (direction > 0 ? 1.25 : 0.8)));
    layoutPdfPages(pdfView);
    stage.scrollTop = anchor * stage.scrollHeight;
}

// --- Adding files and folders (folders where the member may write) ---
function pickMediaFiles() {
    if (mediaListing?.access !== 'write') return;
    const input = $('media-file-input');
    input.value = '';
    input.click();
}

let mediaUploading = false;
async function uploadMediaFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || mediaUploading || mediaListing?.access !== 'write') return;
    if (files.length > 50) return showToast(t('media_too_many', 'At most 50 files at once.'), 'error');
    if (files.some(file => file.size > 1024 * 1024 * 1024)) return showToast(t('media_too_large', 'A file is larger than 1 GB.'), 'error');
    const folder = mediaFolder;
    const form = new FormData();
    files.forEach(file => form.append('files', file, file.name));
    mediaUploading = true;
    const box = $('media-upload');
    const fill = $('media-upload-fill');
    box.hidden = false;
    fill.style.width = '0%';
    setText('media-upload-text', files.length === 1 ? t('media_uploading_one', 'Uploading 1 file…') : t('media_uploading', 'Uploading {count} files…', { count: files.length }));
    try {
        const token = await getToken();
        // XMLHttpRequest: fetch cannot report how far an upload is
        const result = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API}/media/upload?path=${encodeURIComponent(folder)}`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.setRequestHeader('Accept-Language', uiLang);
            xhr.upload.onprogress = e => {
                if (!e.lengthComputable) return;
                const percent = Math.round((e.loaded / e.total) * 100);
                fill.style.width = `${percent}%`;
                setText('media-upload-text', percent < 100
                    ? t('media_uploading_percent', 'Uploading… {percent} %', { percent })
                    : t('media_upload_storing', 'Saving in the cloud…'));
            };
            xhr.onload = () => {
                let body = {};
                try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* not JSON */ }
                if (xhr.status >= 200 && xhr.status < 300) resolve(body);
                else reject(new Error(body.error || `HTTP ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error(t('error_connection', 'Connection error')));
            xhr.send(form);
        });
        const stored = result.files || [];
        const renamed = stored.some((entry, i) => files[i] && entry.name !== files[i].name);
        const added = stored.length === 1 ? t('media_uploaded_one', '1 file added') : t('media_uploaded', '{count} files added', { count: stored.length });
        showToast(renamed ? `${added} · ${t('media_uploaded_renamed', 'Names already taken got a number.')}` : added);
        if (mediaFolder === folder) await loadMediaFolder({ silent: true });
    } catch (err) {
        showToast(err.message || t('media_upload_failed', 'The files could not be uploaded'), 'error');
    } finally {
        mediaUploading = false;
        box.hidden = true;
    }
}

// Dropping files on the page uploads them into the open folder
(() => {
    const page = $('media');
    if (!page) return;
    const canDrop = e => mediaListing?.access === 'write' && [...(e.dataTransfer?.types || [])].includes('Files');
    page.addEventListener('dragover', e => {
        if (!canDrop(e)) return;
        e.preventDefault();
        page.classList.add('is-dropping');
    });
    page.addEventListener('dragleave', e => {
        if (!page.contains(e.relatedTarget)) page.classList.remove('is-dropping');
    });
    page.addEventListener('drop', e => {
        page.classList.remove('is-dropping');
        if (!canDrop(e)) return;
        e.preventDefault();
        uploadMediaFiles(e.dataTransfer.files);
    });
})();

function openMediaFolderDialog() {
    if (mediaListing?.access !== 'write') return;
    setValue('media-folder-name', '');
    openModal('media-folder-modal');
    setTimeout(() => $('media-folder-name')?.focus(), 50);
}

async function createMediaFolder() {
    const name = inputValue('media-folder-name').trim();
    if (!name) return void $('media-folder-name')?.focus();
    await once('media-folder', () => attempt(async () => {
        await apiJson('/media/folder', 'POST', { path: mediaFolder, name });
        closeModal('media-folder-modal', false, true);
        showToast(t('media_folder_created', 'Folder created'));
        await loadMediaFolder({ silent: true });
    }, err => err.message, { button: 'media-folder-create' }));
}

// --- Folder rights (extended media rights): all members always, other groups and single people only when added ---
let mediaRights = null;
const MEDIA_TARGET_ICONS = { all: 'users', group: 'users', person: 'person' };

async function openMediaRights(path = mediaFolder) {
    if (!mediaStatus.canManage) return;
    await attempt(async () => {
        const data = await apiJson(`/media/rules?path=${encodeURIComponent(path)}`);
        mediaRights = { path, choices: data.choices, rows: rightsRows(data.choices, data.folder) };
        setText('media-rights-path', mediaFolderLabel(path));
        closeMediaRightsAdd();
        renderMediaRights();
        openModal('media-rights-modal');
    }, err => err.message || t('media_rights_load_failed', 'The folder rights could not be loaded'));
}

function renderMediaRights() {
    const target = $('media-rights-list');
    if (!target || !mediaRights) return;
    const labels = MEDIA_LEVEL_LABELS();
    target.innerHTML = mediaRights.rows.map((row, index) => {
        // Without a rule of its own a row follows: the folder above, else for a person their groups, for a group all
        // members, for all members nothing ("no access" is then already the first choice, not offered twice)
        const from = row.inherited
            ? t('media_from_above', 'From {folder}: {level}', { folder: mediaFolderLabel(row.inherited.from), level: labels[row.inherited.level] })
            : '';
        const follow = from ? t('media_level_inherit', 'As above')
            : row.kind === 'person' ? t('media_level_groups', 'As their groups')
                : row.kind === 'group' ? t('media_level_all', 'As all members') : t('media_level_none', 'No access');
        const options = [['', follow], ['read', labels.read], ['write', labels.write]];
        if (from || row.kind !== 'all' || row.level === 'hide') options.push(['hide', labels.hide]);
        const name = mediaGroupName(row);
        return `
            <div class="media-right-row${row.kind === 'person' ? ' is-person' : ''}">
                <div class="media-right-name">
                    <span class="media-right-who">${svgIcon(MEDIA_TARGET_ICONS[row.kind] || 'users', 15, 2.2)}<span>${escapeHtml(name)}</span></span>
                    ${from ? `<span class="media-right-from">${escapeHtml(from)}</span>` : ''}
                    ${removableRow(row) ? `<button type="button" class="media-right-remove" onclick="removeMediaRightRow(${index})" title="${escapeHtml(t('btn_remove', 'Remove'))}" aria-label="${escapeHtml(t('media_rights_remove', 'Remove {name}', { name }))}">${svgIcon('x', 15, 2.4)}</button>` : ''}
                </div>
                <div class="settings-pills media-right-pills" role="radiogroup" aria-label="${escapeHtml(name)}">
                    ${options.map(([level, label]) => `<button type="button" role="radio" aria-checked="${row.level === level}" class="settings-pill${row.level === level ? ' is-active' : ''}${level ? ` is-${level}` : ''}" onclick="setMediaRightLevel(${index}, ${jsArg(level)})"><span>${escapeHtml(label)}</span></button>`).join('')}
                </div>
            </div>`;
    }).join('');
}

function setMediaRightLevel(index, level) {
    if (!mediaRights?.rows[index]) return;
    mediaRights.rows[index].level = level;
    renderMediaRights();
}

function removeMediaRightRow(index) {
    if (!mediaRights?.rows[index] || !removableRow(mediaRights.rows[index])) return;
    mediaRights.rows.splice(index, 1);
    renderMediaRights();
    if (!$('media-rights-add-panel').hidden) renderMediaRightsAdd();
}

// Adding: a search over the groups and people that are not in the dialog yet
function openMediaRightsAdd() {
    $('media-rights-add-btn').hidden = true;
    $('media-rights-add-panel').hidden = false;
    setValue('media-rights-search', '');
    renderMediaRightsAdd();
    $('media-rights-search')?.focus();
}

function closeMediaRightsAdd() {
    const button = $('media-rights-add-btn');
    const panel = $('media-rights-add-panel');
    if (button) button.hidden = false;
    if (panel) panel.hidden = true;
}

function renderMediaRightsAdd() {
    const target = $('media-rights-results');
    if (!target || !mediaRights) return;
    const query = inputValue('media-rights-search');
    const found = addableTargets(mediaRights.choices, mediaRights.rows, query);
    target.innerHTML = found.length ? found.map(choice => `
        <button type="button" class="media-rights-result" onclick="addMediaRightRow(${jsArg(choice.id)})">
            <span class="media-rights-result-icon is-${escapeHtml(choice.kind)}">${svgIcon(MEDIA_TARGET_ICONS[choice.kind] || 'users', 15, 2.2)}</span>
            <span class="media-rights-result-name">${escapeHtml(choice.name)}</span>
            <span class="media-rights-result-kind">${choice.kind === 'person' ? t('media_kind_person', 'Person') : t('media_kind_group', 'Group')}</span>
        </button>`).join('')
        : `<p class="media-rights-empty">${query.trim() ? t('media_rights_no_match', 'Nobody found') : t('media_rights_all_added', 'All groups and people are listed already')}</p>`;
}

function addMediaRightRow(id) {
    const choice = mediaRights?.choices.find(entry => entry.id === id);
    if (!choice || mediaRights.rows.some(row => row.id === id)) return;
    // New in the dialog: read, the most common wish; one tap changes it
    mediaRights.rows.push({ id: choice.id, name: choice.name, kind: choice.kind, level: 'read', inherited: null });
    closeMediaRightsAdd();
    renderMediaRights();
    $('media-rights-list')?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function saveMediaRights() {
    if (!mediaRights) return;
    const { path, rows } = mediaRights;
    await once('media-rights', () => attempt(async () => {
        await apiJson('/media/rules', 'PUT', { path, groups: rightsPayload(rows) });
        closeModal('media-rights-modal', false, true);
        showToast(t('media_rights_saved', 'Folder rights saved'));
        await Promise.all([loadMediaStatus(), currentActiveTab === 'media' ? loadMediaFolder({ silent: true }) : null]);
    }, err => err.message || t('media_rights_save_failed', 'The folder rights could not be saved'), { button: 'media-rights-save' }));
}

async function openMediaRulesOverview() {
    if (!mediaStatus.canManage) return;
    await attempt(async () => {
        const data = await apiJson('/media/rules');
        const names = Object.fromEntries(data.choices.map(choice => [choice.id, mediaGroupName(choice)]));
        const labels = MEDIA_LEVEL_LABELS();
        // The rights can be changed from here too: a folder renamed or removed in Nextcloud keeps its rule until then
        $('media-rules-list').innerHTML = data.rules.length ? data.rules.map(rule => `
            <div class="media-rule">
                <div class="media-rule-head">
                    <button type="button" class="media-rule-path" onclick="openMediaRuleFolder(${jsArg(rule.path)})">${svgIcon('folder', 15, 2.2)}<span>${escapeHtml(mediaFolderLabel(rule.path))}</span></button>
                    <button type="button" class="media-rule-edit" onclick="editMediaRule(${jsArg(rule.path)})" title="${escapeHtml(t('media_rights_title', 'Folder rights'))}" aria-label="${escapeHtml(t('media_rights_of', 'Rights of {name}', { name: mediaFolderLabel(rule.path) }))}">${svgIcon('shield', 15, 2.2)}</button>
                </div>
                <span class="media-rule-groups">${Object.entries(rule.groups).map(([id, level]) =>
                    `<span class="media-rule-chip is-${escapeHtml(level)}">${escapeHtml(names[id] || id)}: ${escapeHtml(labels[level] || level)}</span>`).join('')}</span>
            </div>`).join('')
            : `<p class="media-rights-hint">${t('media_rules_none', 'No folder has rights yet: only members with extended media rights see the library. Open a folder and set its rights with the shield.')}</p>`;
        openModal('media-rules-modal');
    }, err => err.message || t('media_rights_load_failed', 'The folder rights could not be loaded'));
}

function openMediaRuleFolder(path) {
    closeModal('media-rules-modal', false, true);
    openMediaFolder(path);
}

function editMediaRule(path) {
    closeModal('media-rules-modal', false, true);
    openMediaRights(path);
}

// --- System settings: the connection to Nextcloud ---
const MEDIA_CFG_FIELDS = { url: 'super-admin-media-url', user: 'super-admin-media-user', password: 'super-admin-media-password', root: 'super-admin-media-root' };

function mediaConfigPayload() {
    return {
        enabled: isChecked('super-admin-media-enabled'),
        url: inputValue(MEDIA_CFG_FIELDS.url).trim(),
        user: inputValue(MEDIA_CFG_FIELDS.user).trim(),
        password: inputValue(MEDIA_CFG_FIELDS.password),
        root: inputValue(MEDIA_CFG_FIELDS.root).trim()
    };
}

function showMediaConfigResult(ok, html) {
    const box = $('media-cfg-result');
    if (!box) return;
    box.hidden = false;
    box.className = `media-cfg-result ${ok ? 'is-ok' : 'is-error'}`;
    box.innerHTML = html;
}

async function loadMediaConfig() {
    if (!isSuperAdminUser()) return;
    $('media-cfg-result').hidden = true;
    try {
        const data = await apiJson('/admin/media-config');
        const enabled = $('super-admin-media-enabled');
        if (enabled) enabled.checked = data.enabled === true;
        for (const [key, id] of Object.entries(MEDIA_CFG_FIELDS)) setValue(id, key === 'root' && data.root ? `/${data.root}` : data[key] || '');
    } catch (err) {
        console.warn('Media settings could not be loaded:', err);
    }
}

async function testMediaConfig() {
    await attempt(async () => {
        try {
            const data = await apiJson('/admin/media-config/test', 'POST', mediaConfigPayload());
            const shown = data.folders.map(name => `<code>${escapeHtml(name)}</code>`).join(' ');
            showMediaConfigResult(true, `<strong>${t('media_cfg_test_ok', 'Connected.')}</strong> ${data.folderCount
                ? (data.folderCount === 1 ? t('media_cfg_test_folders_one', '1 folder in the base folder:') : t('media_cfg_test_folders', '{count} folders in the base folder:', { count: data.folderCount })) + ` ${shown}${data.folderCount > data.folders.length ? ' …' : ''}`
                : t('media_cfg_test_empty', 'The base folder has no folders yet.')}`);
        } catch (err) {
            showMediaConfigResult(false, `<strong>${t('media_cfg_test_failed', 'No connection.')}</strong> ${escapeHtml(err.message)}`);
        }
    }, '', { button: 'media-cfg-test-btn', loading: t('media_cfg_testing', 'Testing…') });
}

async function saveMediaConfig() {
    await attempt(async () => {
        await apiJson('/admin/media-config', 'PUT', mediaConfigPayload());
        showToast(t('media_cfg_saved', 'Media settings saved'));
        await Promise.all([loadMediaConfig(), loadMediaStatus()]);
    }, err => err.message || t('media_cfg_save_failed', 'The media settings could not be saved'), { button: 'media-cfg-save-btn' });
}

// --- Anonymous polls: browse running and finished polls, vote anonymously, create your own ---
let polls = [];
let pollsLoaded = false;
let pollsError = '';
let pollFilter = 'open';
let openPollId = null;
let pollEndTimer = null;
const POLL_CHOICES_KEY = 'agora-poll-choices';

// What you chose is remembered on this device only (the server keeps no link between you and your answer)
function myPollChoice(id) {
    try { return JSON.parse(localStorage.getItem(POLL_CHOICES_KEY) || '{}')[id] || null; } catch { return null; }
}
function rememberPollChoice(id, optionIds) {
    try {
        const all = JSON.parse(localStorage.getItem(POLL_CHOICES_KEY) || '{}');
        all[id] = optionIds;
        // Only polls that still exist
        const known = new Set(polls.map(p => p.id));
        for (const key of Object.keys(all)) if (!known.has(key) && key !== id) delete all[key];
        localStorage.setItem(POLL_CHOICES_KEY, JSON.stringify(all));
    } catch { /* private mode */ }
}

async function loadPolls() {
    try {
        polls = await apiJson('/polls', 'GET', undefined, t('polls_load_failed', 'Polls could not be loaded'));
        pollsLoaded = true;
        pollsError = '';
    } catch (err) {
        if (pollsLoaded) showToast(err.message, 'error');
        else pollsError = err.message;
    }
    renderPolls();
    scheduleNextPollEnd();
    if (openPollId && $('poll-detail-modal')?.classList.contains('show')) {
        if (!polls.some(p => p.id === openPollId)) {
            // Deleted by its creator or an admin while it was open here
            closeModal('poll-detail-modal');
            showToast(t('polls_gone', 'This poll was deleted.'));
        } else {
            renderPollDetail();
        }
    }
}

// Reload when the next running poll ends, so it turns into "Finished" with its result without a manual refresh
function scheduleNextPollEnd() {
    clearTimeout(pollEndTimer);
    const next = Math.min(...polls.filter(p => !p.closed).map(p => p.endsAt));
    if (!Number.isFinite(next)) return;
    pollEndTimer = setTimeout(() => {
        if (currentActiveTab === 'polls') loadPolls();
    }, Math.min(Math.max(next - Date.now() + 1500, 1000), 2147483000));
}

function setPollFilter(filter) {
    pollFilter = filter;
    document.querySelectorAll('#polls .polls-filter-btn').forEach(btn => {
        const active = btn.dataset.filter === filter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    renderPolls();
}

const pollEndTime = poll => new Date(poll.endsAt).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
const pollEndDate = poll => formatDateFast(toDateStr(new Date(poll.endsAt)));

function pollTimeLabel(poll) {
    const end = new Date(poll.endsAt);
    if (poll.closed) return t('polls_ended_on', 'Ended on {date}', { date: pollEndDate(poll) });
    const days = Math.ceil((poll.endsAt - Date.now()) / 86400000);
    if (days <= 1) return t('polls_ends_today', 'Ends {when} at {time}', { when: end.toDateString() === new Date().toDateString() ? t('polls_today', 'today') : t('polls_tomorrow', 'tomorrow'), time: pollEndTime(poll) });
    return t('polls_ends_in', '{days} days left', { days });
}

const pollVotes = poll => poll.participants === 1 ? t('polls_votes_one', '1 vote') : t('polls_votes', '{count} votes', { count: poll.participants });

/**
 * Shares in whole percent. Single choice: largest remainder, so they add up to exactly 100. Multiple choice:
 * share of the participants per answer (they add up to more than 100).
 */
function pollShares(poll) {
    const counts = poll.results?.counts || {};
    const total = Math.max(1, poll.results?.participants || 0);
    const exact = poll.options.map(o => ({ id: o.id, value: ((counts[o.id] || 0) / total) * 100 }));
    if (poll.multiple) return Object.fromEntries(exact.map(e => [e.id, Math.round(e.value)]));
    const shares = Object.fromEntries(exact.map(e => [e.id, Math.floor(e.value)]));
    const votes = exact.reduce((sum, e) => sum + (counts[e.id] || 0), 0);
    if (votes > 0) {
        let rest = 100 - Object.values(shares).reduce((a, b) => a + b, 0);
        for (const e of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
            if (rest-- <= 0) break;
            shares[e.id] += 1;
        }
    }
    return shares;
}

// The leading answer(s) of a finished poll; a tie lists all of them
function pollLeader(poll) {
    if (!poll.results) return null;
    const counts = poll.results.counts;
    const top = Math.max(0, ...poll.options.map(o => counts[o.id] || 0));
    if (top === 0) return null;
    const leaders = poll.options.filter(o => (counts[o.id] || 0) === top);
    return { text: leaders.map(o => o.text).join(' · '), share: pollShares(poll)[leaders[0].id], tie: leaders.length > 1 };
}

function renderPolls() {
    const target = $('polls-list');
    if (!target) return;
    if (!pollsLoaded) {
        target.innerHTML = pollsError ? `
            <div class="polls-empty">
                <span class="polls-empty-icon">${svgIcon('poll', 26, 1.8)}</span>
                <span class="polls-empty-title">${escapeHtml(pollsError)}</span>
                <button type="button" class="btn btn-secondary" onclick="window.loadPolls()">${t('btn_retry', 'Try again')}</button>
            </div>` : '<div class="polls-loading"><span class="spinner"></span></div>';
        return;
    }
    const list = polls.filter(p => pollFilter === 'mine' ? p.isMine : pollFilter === 'closed' ? p.closed : !p.closed);
    if (!list.length) {
        target.innerHTML = `
            <div class="polls-empty">
                <span class="polls-empty-icon">${svgIcon('poll', 26, 1.8)}</span>
                <span class="polls-empty-title">${pollFilter === 'mine' ? t('polls_empty_mine', 'You have not created a poll yet') : pollFilter === 'closed' ? t('polls_empty_closed', 'No finished polls yet') : t('polls_empty_open', 'No poll is running right now')}</span>
                <span class="polls-empty-hint">${t('polls_empty_hint', 'Start your own poll with the plus at the bottom right.')}</span>
            </div>`;
        return;
    }
    // Cards: state and time on top, the question, then the leading answer (finished) or what you can do
    target.innerHTML = `<div class="polls-cards">${list.map(poll => {
        const leader = pollLeader(poll);
        const chip = poll.closed
            ? `<span class="poll-chip-state">${t('polls_closed', 'Finished')}</span>`
            : `<span class="poll-chip-state is-live"><span class="poll-live-dot"></span>${t('polls_live', 'Running')}</span>`;
        const action = poll.closed
            ? (poll.results ? t('polls_show_result', 'See result') : t('polls_closed', 'Finished'))
            : poll.hasVoted ? `${svgIcon('check', 14, 3)} ${t('polls_voted', 'Voted')}` : t('polls_vote_now', 'Vote now');
        const actionClass = poll.closed ? 'is-result' : poll.hasVoted ? 'is-done' : 'is-go';
        return `
            <button type="button" class="poll-card" data-id="${escapeHtml(poll.id)}" onclick="window.openPollDetail(this.dataset.id)">
                <span class="poll-card-top">
                    ${chip}
                    <span class="poll-card-time">${escapeHtml(poll.closed ? pollEndDate(poll) : pollTimeLabel(poll))}</span>
                </span>
                <span class="poll-card-title">${escapeHtml(poll.title)}</span>
                ${poll.description ? `<span class="poll-card-desc">${escapeHtml(poll.description)}</span>` : ''}
                ${leader ? `
                <span class="poll-card-leader">
                    <span class="poll-card-leader-row"><span>${leader.tie ? `${t('polls_tie', 'Tie')}: ` : ''}${escapeHtml(leader.text)}</span><strong>${leader.share}%</strong></span>
                    <span class="poll-card-track"><span style="width: ${leader.share}%"></span></span>
                </span>` : ''}
                <span class="poll-card-footer">
                    <span class="poll-card-votes">${svgIcon('users', 14, 2)} ${escapeHtml(pollVotes(poll))}${poll.isMine ? ` · ${t('polls_mine_badge', 'Yours')}` : ''}</span>
                    <span class="poll-card-action ${actionClass}">${action}</span>
                </span>
            </button>`;
    }).join('')}</div>`;
}

function openPollDetail(id) {
    openPollId = id;
    renderPollDetail();
    openModal('poll-detail-modal');
}

/** "You chose …" for polls voted on this device. */
function myChoiceNote(poll) {
    const mine = myPollChoice(poll.id);
    const texts = (mine || []).map(id => poll.options.find(o => o.id === id)?.text).filter(Boolean);
    return texts.length ? `<p class="poll-my-choice">${t('polls_my_choice', 'Your choice (only saved on this device): {choice}', { choice: escapeHtml(texts.join(', ')) })}</p>` : '';
}

function renderPollDetail() {
    const poll = polls.find(p => p.id === openPollId);
    const body = $('poll-detail-body');
    if (!poll || !body) return;
    // A refresh while someone is choosing must not lose their ticks
    const ticked = new Set([...body.querySelectorAll('input[name="poll-choice"]:checked')].map(i => i.value));
    setText('poll-detail-title', poll.title);
    setText('poll-detail-meta', `${pollTimeLabel(poll)} · ${pollVotes(poll)}`);
    const description = poll.description ? `<p class="poll-detail-desc">${escapeHtml(poll.description)}</p>` : '';
    let main;
    if (!poll.closed && !poll.hasVoted) {
        const type = poll.multiple ? 'checkbox' : 'radio';
        main = `
            <fieldset class="poll-choices">
                <legend class="sr-only">${escapeHtml(poll.title)}</legend>
                ${poll.options.map(o => `
                    <label class="poll-choice">
                        <input type="${type}" name="poll-choice" value="${escapeHtml(o.id)}"${ticked.has(o.id) ? ' checked' : ''}>
                        <span class="poll-choice-mark"></span>
                        <span class="poll-choice-text">${escapeHtml(o.text)}</span>
                    </label>`).join('')}
            </fieldset>
            ${poll.multiple ? `<p class="poll-hint">${t('polls_multiple_hint', 'Several answers possible.')}</p>` : ''}
            <p class="poll-anon-note">${svgIcon('shield', 14, 2)} ${t('polls_anon_note', 'Your choice is only counted – nobody in the app can see what you chose.')}</p>
            <button type="button" id="poll-vote-btn" class="btn btn-primary poll-vote-btn" onclick="window.votePoll()">${t('polls_vote_btn', 'Vote anonymously')}</button>`;
    } else if (!poll.closed) {
        main = `
            <div class="poll-state-box is-voted">
                ${svgIcon('check', 20, 2.6)}
                <span>${t('polls_voted_wait', 'You have voted. The result appears on {date} at {time}.', { date: pollEndDate(poll), time: pollEndTime(poll) })}</span>
            </div>
            ${myChoiceNote(poll)}
            <ul class="poll-option-list">${poll.options.map(o => `<li>${escapeHtml(o.text)}</li>`).join('')}</ul>`;
    } else if (poll.results) {
        const shares = pollShares(poll);
        const counts = poll.results.counts;
        const max = Math.max(...poll.options.map(o => counts[o.id] || 0));
        const mine = new Set(myPollChoice(poll.id) || []);
        main = `
            <div class="poll-results">
                ${[...poll.options].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0)).map(o => {
                    const count = counts[o.id] || 0;
                    return `
                        <div class="poll-result${count === max && count > 0 ? ' is-top' : ''}${mine.has(o.id) ? ' is-mine' : ''}">
                            <span class="poll-result-bar" style="width: ${shares[o.id]}%"></span>
                            <span class="poll-result-text">${escapeHtml(o.text)}</span>
                            <span class="poll-result-value">${shares[o.id]}% · ${count}</span>
                        </div>`;
                }).join('')}
            </div>
            ${myChoiceNote(poll)}
            ${poll.multiple ? `<p class="poll-hint">${t('polls_multiple_result_hint', 'Multiple choice: share of participants who chose the answer.')}</p>` : ''}`;
    } else {
        main = `
            <div class="poll-state-box">
                ${svgIcon('shield', 20, 2)}
                <span>${t('polls_too_few', 'Too few votes: with fewer than three votes the result stays secret so nobody can draw conclusions.')}</span>
            </div>`;
    }
    const manage = poll.isMine || isSuperAdminUser();
    const actions = manage ? `
        <div class="poll-manage">
            ${!poll.closed ? `<button type="button" class="btn btn-secondary btn-small" onclick="window.closePoll()">${t('polls_end_now', 'End now')}</button>` : ''}
            <button type="button" class="btn btn-small poll-delete-btn" onclick="window.deletePoll()">${t('polls_delete', 'Delete')}</button>
        </div>` : '';
    body.innerHTML = description + main + actions;
}

async function votePoll() {
    const optionIds = [...document.querySelectorAll('#poll-detail-body input[name="poll-choice"]:checked')].map(i => i.value);
    if (!optionIds.length) return showToast(t('polls_choose', 'Please choose an answer.'), 'error');
    const btn = $('poll-vote-btn');
    if (btn) btn.disabled = true;
    try {
        const updated = await apiJson(`/polls/${encodeURIComponent(openPollId)}/vote`, 'POST', { optionIds });
        rememberPollChoice(updated.id, optionIds);
        polls = polls.map(p => p.id === updated.id ? updated : p);
        renderPolls();
        renderPollDetail();
        showToast(t('polls_vote_saved', 'Your vote was counted anonymously.'));
    } catch (err) {
        showToast(err.message, 'error');
        if (btn) btn.disabled = false;
        // Voted on another device, or the poll just ended: show what is true now
        loadPolls();
    }
}

async function closePoll() {
    const poll = polls.find(p => p.id === openPollId);
    const tooFew = poll && poll.participants < 3;
    const text = tooFew
        ? t('polls_end_confirm_few', 'End the poll now? With fewer than three votes the result stays secret for good.')
        : t('polls_end_confirm', 'End the poll now? Nobody can vote afterwards.');
    if (!confirmAction(text)) return;
    try {
        const updated = await apiJson(`/polls/${encodeURIComponent(openPollId)}/close`, 'POST');
        polls = polls.map(p => p.id === updated.id ? updated : p);
        renderPolls();
        renderPollDetail();
        scheduleNextPollEnd();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deletePoll() {
    if (!confirmAction(t('polls_delete_confirm', 'Delete the poll for good?'))) return;
    try {
        await apiJson(`/polls/${encodeURIComponent(openPollId)}`, 'DELETE');
        polls = polls.filter(p => p.id !== openPollId);
        closeModal('poll-detail-modal');
        renderPolls();
        showToast(t('polls_deleted', 'Poll deleted'));
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// --- Prayer requests (Extras): a calm list; a request is shared (also anonymously) and removed when it is done ---
// The server never tells who shared an anonymous request (see backend/prayers.js).
let prayers = [];
let prayersLoaded = false;
let prayersError = '';
let prayerFilter = 'all';
let prayerDuration = 'month';

async function loadPrayers() {
    try {
        const data = await apiJson('/prayers', 'GET', undefined, t('prayers_load_failed', 'Prayer requests could not be loaded'));
        prayers = Array.isArray(data.prayers) ? data.prayers : [];
        prayersLoaded = true;
        prayersError = '';
    } catch (err) {
        if (!prayersLoaded) prayersError = err.message;
        else showToast(err.message, 'error');
    }
    renderPrayers();
}

function setPrayerFilter(filter) {
    prayerFilter = filter;
    document.querySelectorAll('#prayers .polls-filter-btn').forEach(btn => {
        const active = btn.dataset.filter === filter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    renderPrayers();
}

const prayerDate = ms => new Date(ms).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
/** "2 hours ago", "yesterday"; older than a week as a date. */
function timeAgo(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    if (abs > 7 * 86400000) return prayerDate(ms);
    const format = new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto' });
    if (abs >= 86400000) return format.format(Math.round(diff / 86400000), 'day');
    if (abs >= 3600000) return format.format(Math.round(diff / 3600000), 'hour');
    return format.format(Math.min(0, Math.round(diff / 60000)), 'minute');
}

const prayerName = p => (p.author ? (p.author.name || t('events_member_fallback', 'Member')) : t('prayers_anonymous_name', 'Anonymous'));

/** One quiet row: picture and name, when; the request below. Own requests (and moderators) open their options. */
function prayerRow(p) {
    const name = prayerName(p);
    const avatar = p.author
        ? renderAvatarWrap(p.author.uid, name, { wrapClass: 'prayer-avatar', imgClass: 'prayer-avatar-img', initialsClass: 'prayer-avatar-initials' })
        : `<span class="prayer-avatar is-anonymous">${svgIcon('eyeOff', 14)}</span>`;
    const editable = p.isMine || p.canDelete;
    const meta = [timeAgo(p.createdAt), p.isMine ? (p.expired ? t('prayers_expired', 'Expired') : t('prayers_until_short', 'until {date}', { date: prayerDate(p.expiresAt) })) : ''].filter(Boolean).join(' · ');
    return `
        <div class="prayer-row${editable ? ' is-editable' : ''}${p.expired ? ' is-expired' : ''}"${editable ? ` role="button" tabindex="0" onclick="window.openPrayerOptions(${jsArg(p.id)})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}"` : ''}>
            ${avatar}
            <span class="prayer-row-main">
                <span class="prayer-row-head"><span class="prayer-row-name">${escapeHtml(name)}</span><span class="prayer-row-meta">${escapeHtml(meta)}</span></span>
                <span class="prayer-row-text">${escapeHtml(p.text)}</span>
            </span>
            ${editable ? `<span class="prayer-row-more" aria-hidden="true">${svgIcon('more', 18, 2.6)}</span>` : ''}
        </div>`;
}

function renderPrayers() {
    const target = $('prayers-list');
    if (!target) return;
    if (!prayersLoaded) {
        target.innerHTML = prayersError ? `
            <div class="polls-empty">
                <span class="polls-empty-icon">${svgIcon('heart', 26, 1.8)}</span>
                <span class="polls-empty-title">${escapeHtml(prayersError)}</span>
                <button type="button" class="btn btn-secondary" onclick="window.loadPrayers()">${t('btn_retry', 'Try again')}</button>
            </div>` : '<div class="polls-loading"><span class="spinner"></span></div>';
        return;
    }
    const list = prayers.filter(p => (prayerFilter === 'mine' ? p.isMine : !p.expired));
    if (!list.length) {
        target.innerHTML = `
            <div class="polls-empty">
                <span class="polls-empty-icon">${svgIcon('heart', 26, 1.8)}</span>
                <span class="polls-empty-title">${prayerFilter === 'mine' ? t('prayers_empty_mine', 'You have not shared a request yet') : t('prayers_empty_open', 'No prayer requests right now')}</span>
                <span class="polls-empty-hint">${t('prayers_empty_hint', 'Share a request with the plus at the bottom right.')}</span>
            </div>`;
        return;
    }
    target.innerHTML = `<div class="prayer-list">${list.map(prayerRow).join('')}</div>`;
    // Long requests show four lines; "Read more" opens the rest in place
    target.querySelectorAll('.prayer-row-text').forEach(text => {
        if (text.scrollHeight <= text.clientHeight + 2) return;
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'prayer-more';
        more.textContent = t('prayers_read_more', 'Read more');
        more.onclick = event => {
            event.stopPropagation();
            const open = text.classList.toggle('is-open');
            more.textContent = open ? t('prayers_read_less', 'Show less') : t('prayers_read_more', 'Read more');
        };
        text.after(more);
    });
}

const replacePrayer = updated => { prayers = prayers.map(p => (p.id === updated.id ? updated : p)); };

/** The options of a request: extend and "done" for its owner, remove for moderators. */
function openPrayerOptions(id) {
    const p = prayers.find(item => item.id === id);
    if (!p || !(p.isMine || p.canDelete)) return;
    const actions = [];
    if (p.isMine) actions.push(`<button type="button" class="btn btn-secondary" onclick="window.extendPrayer(${jsArg(p.id)})">${svgIcon('clock', 15)}<span>${t('prayers_extend_month', 'One more month')}</span></button>`);
    actions.push(p.isMine
        ? `<button type="button" class="btn btn-primary" onclick="window.deletePrayer(${jsArg(p.id)})">${svgIcon('check', 15, 2.6)}<span>${t('prayers_done', 'Done - remove')}</span></button>`
        : `<button type="button" class="btn btn-danger" onclick="window.deletePrayer(${jsArg(p.id)})">${svgIcon('trash', 15)}<span>${t('prayers_remove', 'Remove')}</span></button>`);
    showDynamicModal({
        id: 'prayer-options-modal',
        title: p.isMine ? t('prayers_yours', 'Your prayer request') : escapeHtml(prayerName(p)),
        subtitle: escapeHtml(p.isMine
            ? (p.expired ? t('prayers_expired_hint', 'No longer shown - extend it to show it again') : t('prayers_until', 'Shown until {date}', { date: prayerDate(p.expiresAt) }))
            : timeAgo(p.createdAt)),
        maxWidth: '440px',
        bodyHtml: `<p class="prayer-options-text">${escapeHtml(p.text)}</p>`,
        footerHtml: `<div class="prayer-options-actions">${actions.join('')}</div>`
    });
}

function setPrayerDuration(duration) {
    prayerDuration = duration;
    document.querySelectorAll('#prayer-edit-modal [data-duration]').forEach(pill => {
        const on = pill.dataset.duration === duration;
        pill.classList.toggle('is-active', on);
        pill.setAttribute('aria-checked', String(on));
    });
}

function updatePrayerCounter() {
    setText('prayer-counter', `${inputValue('prayer-text').length} / 1000`);
}

function openPrayerEditor() {
    setValue('prayer-text', '');
    const anonymous = $('prayer-anonymous');
    if (anonymous) anonymous.checked = false;
    setPrayerDuration('month');
    updatePrayerCounter();
    openModal('prayer-edit-modal');
    modalCloseGuards['prayer-edit-modal'] = () => !inputValue('prayer-text').trim() || confirmAction(t('prayers_discard', 'Discard your request?'));
    setTimeout(() => $('prayer-text')?.focus(), 150);
}

async function submitPrayer() {
    const text = inputValue('prayer-text').trim();
    if (text.length < 3) {
        showToast(t('prayers_too_short', 'Please write your request (at least 3 characters).'), 'error');
        $('prayer-text')?.focus();
        return;
    }
    const btn = $('prayer-submit');
    if (btn) btn.disabled = true;
    try {
        await apiJson('/prayers', 'POST', { text, anonymous: !!$('prayer-anonymous')?.checked, duration: prayerDuration }, t('prayers_share_failed', 'The prayer request could not be shared'));
        closeModal('prayer-edit-modal', false, true);
        showToast(t('prayers_shared', 'Your prayer request has been shared'));
        setPrayerFilter('all');
        await loadPrayers();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function extendPrayer(id) {
    return once(`prayer:${id}`, () => extendPrayerNow(id));
}
async function extendPrayerNow(id) {
    try {
        replacePrayer(await apiJson(`/prayers/${encodeURIComponent(id)}`, 'PATCH', { extend: 'month' }, t('prayers_save_failed', 'The prayer request could not be saved')));
        closeModal('prayer-options-modal');
        showToast(t('prayers_extended', 'Shown for another month'));
        renderPrayers();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

/** Done (own request) or removed by a moderator; only a moderator's removal asks first. */
function deletePrayer(id) {
    return once(`prayer:${id}`, () => deletePrayerNow(id));
}
async function deletePrayerNow(id) {
    const mine = prayers.find(p => p.id === id)?.isMine;
    if (!mine && !confirmAction(t('prayers_remove_confirm', 'Remove this prayer request for everyone?'))) return;
    try {
        await apiJson(`/prayers/${encodeURIComponent(id)}`, 'DELETE', undefined, t('prayers_delete_failed', 'The prayer request could not be deleted'));
        prayers = prayers.filter(p => p.id !== id);
        closeModal('prayer-options-modal');
        renderPrayers();
        showToast(mine ? t('prayers_done_toast', 'Removed - thank you for sharing') : t('prayers_deleted', 'Prayer request deleted'));
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// --- Songbook: songs with chords ("[G]Amazing [C]grace", "# Chorus"), transposable, with auto-scroll ---
// Text and chord rules live in songbook.js (tested on their own); this part is the list, the song page and the editor.
let songs = [];
let songbookCanManage = false;
let songbookLicense = '';
let songbookLoaded = false;
let openSongId = null;
let editSongId = null;
let songEditSnapshot = '';
const SONG_SPEEDS = [1, 1.5, 2, 3, 0.5];
const SONG_PREFS_KEY = 'agora-song-view';

// Chords on/off, font size and scroll speed stay as the reader left them (instrument, eyesight, playing pace);
// the key starts as written every time a song opens
const storedJson = (key, fallback) => {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
};
const { chords: songChords, size: songSize, speed: songSpeed } = storedJson(SONG_PREFS_KEY, { chords: true, size: 0, speed: 1 });
const songView = { scrolling: false, frame: null, last: 0, pos: null, steps: 0, lastY: 0, chords: songChords !== false, size: songSize, speed: songSpeed };
const saveSongPrefs = () => {
    try { localStorage.setItem(SONG_PREFS_KEY, JSON.stringify({ chords: songView.chords, size: songView.size, speed: songView.speed })); } catch { /* private mode */ }
};
// Transpositions were remembered per song up to the first ORION builds
try { localStorage.removeItem('agora-song-steps'); } catch { /* private mode */ }

const songCollator = () => new Intl.Collator(uiLocale(), { sensitivity: 'base', numeric: true });
const sortSongs = list => list.sort((a, b) => songCollator().compare(a.title || '', b.title || ''));
const songSectionLabels = () => ({
    chorus: t('songbook_label_chorus', 'Chorus'),
    verse: t('songbook_label_verse', 'Verse'),
    bridge: t('songbook_label_bridge', 'Bridge'),
    tab: t('songbook_label_tab', 'Tab')
});

async function loadSongs() {
    try {
        const data = await apiJson('/songs', 'GET', undefined, t('songbook_load_failed', 'Songbook could not be loaded'));
        songs = sortSongs((data.songs || []).map(song => ({ ...song, _search: searchText(song) })));
        songbookCanManage = data.canManage === true;
        songbookLicense = data.ccliLicense || '';
        songbookLoaded = true;
    } catch (err) {
        if (!songbookLoaded) {
            renderSongsError(err.message);
            return;
        }
        showToast(err.message, 'error');
    }
    updateFabVisibility();
    renderSongs();
    if (openSongId && $('song-view-modal')?.classList.contains('show')) {
        // The open song was deleted elsewhere
        if (!songs.some(s => s.id === openSongId)) closeSong();
        else renderSongView();
    }
    // Opened through its address (/songbook/<name>, old links #songbook/<id>): show that song once
    if (pendingSongSlug) {
        const linked = findBySlug(songs, pendingSongSlug);
        pendingSongSlug = null;
        if (linked) openSong(linked.id);
        else showToast(t('songbook_link_missing', 'This song is no longer in the songbook.'), 'error');
    }
}

// A link to the open song for the band: the system share sheet, else the clipboard
async function shareSong() {
    const song = songs.find(s => s.id === openSongId);
    if (!song) return;
    const url = `${window.location.origin}/songbook/${encodeURIComponent(songSlug(song))}`;
    try {
        if (navigator.share) {
            await navigator.share({ title: song.title, url });
            return;
        }
        if (!(await copyText(url))) throw new Error('copy');
        showToast(t('songbook_link_copied', 'Link copied'));
    } catch (err) {
        if (err?.name !== 'AbortError') showToast(t('songbook_link_failed', 'The link could not be shared.'), 'error');
    }
}

function renderSongsError(message) {
    const target = $('songbook-list');
    if (target) target.innerHTML = `
        <div class="polls-empty">
            <span class="polls-empty-icon songbook-empty-icon">${svgIcon('music', 26, 1.8)}</span>
            <span class="polls-empty-title">${escapeHtml(message)}</span>
            <button type="button" class="btn btn-secondary" onclick="window.loadSongs()">${t('btn_retry', 'Try again')}</button>
        </div>`;
}

function songMeta(song) {
    return [
        song.artist,
        song.key ? t('songbook_key_short', 'Key {key}', { key: song.key }) : ''
    ].filter(Boolean).join(' · ');
}

function renderSongs() {
    const target = $('songbook-list');
    if (!target) return;
    if (!songbookLoaded) {
        target.innerHTML = '<div class="polls-loading"><span class="spinner"></span></div>';
        return;
    }
    const query = normalizeSearch(inputValue('songbook-search').trim());
    const list = query ? songs.filter(s => s._search.includes(query)) : songs;
    setText('songbook-license', songbookLicense ? t('songbook_license', 'CCLI licence {number}', { number: songbookLicense }) : '');
    if (!list.length) {
        target.innerHTML = `
            <div class="polls-empty">
                <span class="polls-empty-icon songbook-empty-icon">${svgIcon('music', 26, 1.8)}</span>
                <span class="polls-empty-title">${query ? t('songbook_no_match', 'No song found') : t('songbook_empty', 'No songs in the songbook yet')}</span>
                ${songbookCanManage && !query ? `<span class="polls-empty-hint">${t('songbook_empty_hint', 'Add the first song with the plus at the bottom right.')}</span>` : ''}
            </div>`;
        return;
    }
    // Alphabetical list in one card, a letter above each new initial (only without a search)
    let letter = '';
    const rows = list.map(song => {
        const initial = (song.title || '#').charAt(0).toLocaleUpperCase(uiLocale());
        const head = !query && initial !== letter ? `<div class="song-letter">${escapeHtml(initial)}</div>` : '';
        letter = initial;
        const meta = songMeta(song);
        return `${head}
            <button type="button" class="song-row" data-id="${escapeHtml(song.id)}" onclick="window.openSong(this.dataset.id)">
                <span class="song-row-icon">${svgIcon('music', 18, 2)}</span>
                <span class="song-row-text">
                    <span class="song-row-title">${escapeHtml(song.title)}</span>
                    ${meta ? `<span class="song-row-meta">${escapeHtml(meta)}</span>` : ''}
                </span>
                ${svgIcon('chevronRight', 16, 2.5, 'class="song-row-chevron"')}
            </button>`;
    }).join('');
    target.innerHTML = `<div class="song-list">${rows}</div>`;
}

function openSong(id, { steps = 0 } = {}) {
    if (!songs.some(s => s.id === id)) return;
    openSongId = id;
    stopSongScroll();
    songView.steps = steps;
    songView.lastY = 0;
    toggleSongPanel(false);
    showSongControls(true);
    renderSongView();
    openModal('song-view-modal');
    $('song-view-modal')._customOnClose = leaveSong;
    $('song-view-body')?.scrollTo({ top: 0 });
    keepScreenOn(true);
}

function renderSongView() {
    const song = songs.find(s => s.id === openSongId);
    if (!song) return;
    setText('song-view-title', song.title);
    // The (transposed) key, else the shift in semitones
    const key = transposedKey(song.key, song.content, songView.steps);
    const shift = `${songView.steps > 0 ? '+' : ''}${songView.steps}`;
    // Songwriter, then the facts a musician needs at a glance as chips; a transposed key shows there too,
    // so the change stays visible while the controls are closed
    const keyFact = songView.steps
        ? { text: key ? t('songbook_key_shifted', 'Key {key} ({shift})', { key, shift }) : t('songbook_transposed', 'Transposed by {steps} semitones', { steps: shift }), shifted: true }
        : (song.key ? { text: t('songbook_key_short', 'Key {key}', { key: song.key }) } : null);
    const facts = [keyFact].filter(Boolean);
    const sub = $('song-view-sub');
    if (sub) {
        sub.innerHTML = (song.artist ? `<span class="song-view-artist">${escapeHtml(song.artist)}</span>` : '')
            + (facts.length ? `<span class="song-view-facts">${facts.map(f => `<span class="song-fact${f.shifted ? ' is-shifted' : ''}">${escapeHtml(f.text)}</span>`).join('')}</span>` : '');
        sub.hidden = !song.artist && !facts.length;
    }
    setText('song-key', key || (songView.steps ? shift : '♪'));
    const keyBtn = $('song-key');
    if (keyBtn) {
        keyBtn.classList.toggle('is-shifted', !!songView.steps);
        keyBtn.setAttribute('aria-label', songView.steps ? `${key || shift} – ${t('songbook_key_reset', 'Back to the original key')}` : (key || t('songbook_key_label', 'Key')));
        keyBtn.setAttribute('title', songView.steps ? t('songbook_key_reset', 'Back to the original key') : '');
    }
    show('song-key-reset', !!songView.steps, 'inline-flex');
    const chordsSwitch = $('song-chords-btn');
    if (chordsSwitch) chordsSwitch.checked = songView.chords;
    setText('song-speed-btn', `${songView.speed.toLocaleString(uiLocale())}×`);
    show('song-edit-btn', songbookCanManage, 'inline-flex');
    const body = $('song-view-body');
    if (body) {
        body.style.setProperty('--song-step', String(songView.size));
        // CCLI notes after the last line (they used to cover the lyrics at the bottom right)
        const ccli = [
            songbookLicense ? t('songbook_license', 'CCLI licence {number}', { number: songbookLicense }) : '',
            song.ccli ? t('songbook_ccli_song_short', 'CCLI song {number}', { number: song.ccli }) : '',
            song.copyright ? `© ${song.copyright.replace(/^©\s*/, '')}` : ''
        ].filter(Boolean);
        body.innerHTML = `<div class="song-sheet">${renderSongHtml(song.content, { steps: songView.steps, declaredKey: song.key, chords: songView.chords, labels: songSectionLabels() })}
            ${ccli.length ? `<div class="song-ccli">${ccli.map(line => `<span>${escapeHtml(line)}</span>`).join('')}</div>` : ''}</div><div class="song-end"></div>`;
    }
}

/** Runs whenever the song page closes (button, Escape, back gesture). */
function leaveSong() {
    stopSongScroll();
    toggleSongPanel(false);
    keepScreenOn(false);
}

// The controls stay out of the way: a small "Adjust" button opens them, it hides while reading on
// (scrolling down) and comes back when scrolling up, at the top or with a tap on the song
let songPanelOpen = false;
function toggleSongPanel(open = !songPanelOpen) {
    const panel = $('song-panel');
    if (!panel) return;
    const hadFocus = panel.contains(document.activeElement);
    songPanelOpen = open;
    panel.hidden = !open;
    $('song-controls')?.classList.toggle('is-open', open);
    $('song-panel-btn')?.setAttribute('aria-expanded', String(open));
    if (open) {
        showSongControls(true);
        panel.querySelector('.song-panel-close')?.focus({ preventScroll: true });
    } else if (hadFocus) {
        $('song-panel-btn')?.focus({ preventScroll: true });
    }
}

function showSongControls(visible) {
    $('song-controls')?.classList.toggle('is-hidden', !visible);
}

function songBodyTap() {
    if (songPanelOpen) toggleSongPanel(false);
    else showSongControls(true);
}

function onSongBodyScroll() {
    const body = $('song-view-body');
    if (!body) return;
    const y = body.scrollTop;
    // Auto-scroll moves the page itself: the pause button has to stay reachable then
    if (!songPanelOpen && !songView.scrolling) {
        if (y < 60 || y < songView.lastY - 12) showSongControls(true);
        else if (y > songView.lastY + 12) showSongControls(false);
    }
    if (Math.abs(y - songView.lastY) > 12 || y < 60) songView.lastY = y;
}
$('song-view-body')?.addEventListener('scroll', onSongBodyScroll, { passive: true });

// Escape closes the open controls first, a second Escape the song page
window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && songPanelOpen && $('song-view-modal')?.classList.contains('show')) {
        e.stopPropagation();
        toggleSongPanel(false);
    }
}, true);

function closeSong() {
    leaveSong();
    closeModal('song-view-modal');
}

function toggleSongChords() {
    songView.chords = !songView.chords;
    saveSongPrefs();
    renderSongView();
}

function transposeSong(delta) {
    songView.steps = ((songView.steps + delta + 18) % 12) - 6;
    renderSongView();
}

function resetSongKey() {
    if (!songView.steps) return;
    songView.steps = 0;
    renderSongView();
}

function sizeSong(delta) {
    songView.size = Math.max(-2, Math.min(5, songView.size + delta));
    saveSongPrefs();
    renderSongView();
}

// Prints only the song (see "@media print" in style.css)
function printSong() {
    document.body.classList.add('printing-song');
    const done = () => {
        document.body.classList.remove('printing-song');
        window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
}

// The screen stays on while a song is open (players have no hand free); the lock is lost when the page is hidden
let songWakeLock = null;
async function keepScreenOn(on) {
    try {
        if (on && 'wakeLock' in navigator && !songWakeLock && document.visibilityState === 'visible') {
            songWakeLock = await navigator.wakeLock.request('screen');
            songWakeLock.addEventListener('release', () => { songWakeLock = null; });
        } else if (!on && songWakeLock) {
            await songWakeLock.release();
            songWakeLock = null;
        }
    } catch { /* not supported or refused: the screen just times out as usual */ }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('song-view-modal')?.classList.contains('show')) keepScreenOn(true);
    // rAF pauses in the background: continue from where the page is instead of jumping ahead
    songView.last = 0;
});

// Auto-scroll for playing: a steady glide; scrolling by hand moves the position, the glide continues from there
function songScrollStep(time) {
    const body = $('song-view-body');
    if (!songView.scrolling || !body || !$('song-view-modal')?.classList.contains('show')) return stopSongScroll();
    // scrollTop drops fractions: keep the exact position, take over when the reader scrolled by hand
    if (songView.pos === null || Math.abs(body.scrollTop - songView.pos) > 2) songView.pos = body.scrollTop;
    // At most 100 ms per frame: after a pause (another app, a slow frame) it never jumps
    if (songView.last) songView.pos += (Math.min(time - songView.last, 100) / 1000) * 22 * songView.speed;
    body.scrollTop = songView.pos;
    songView.last = time;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1) return stopSongScroll();
    songView.frame = requestAnimationFrame(songScrollStep);
}

function toggleSongScroll() {
    if (songView.scrolling) return stopSongScroll();
    songView.scrolling = true;
    songView.last = 0;
    songView.pos = null;
    // The song needs the whole screen while it scrolls; the pause button stays next to "Adjust"
    toggleSongPanel(false);
    showSongControls(true);
    show('song-quick-scroll', true, 'inline-flex');
    const btn = $('song-scroll-btn');
    if (btn) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
        btn.innerHTML = svgIcon('pause', 16, 2.4);
    }
    songView.frame = requestAnimationFrame(songScrollStep);
}

function stopSongScroll() {
    songView.scrolling = false;
    if (songView.frame) cancelAnimationFrame(songView.frame);
    songView.frame = null;
    show('song-quick-scroll', false);
    const btn = $('song-scroll-btn');
    if (btn) {
        btn.classList.remove('is-active');
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = svgIcon('play', 16, 2.4);
    }
}

function cycleSongSpeed() {
    songView.speed = SONG_SPEEDS[(SONG_SPEEDS.indexOf(songView.speed) + 1) % SONG_SPEEDS.length];
    saveSongPrefs();
    setText('song-speed-btn', `${songView.speed.toLocaleString(uiLocale())}×`);
}

// --- Song editor (page like "New poll") ---
const SONG_FIELDS = ['song-edit-name', 'song-edit-artist', 'song-edit-key', 'song-edit-ccli', 'song-edit-copyright', 'song-edit-content'];
const songEditState = () => JSON.stringify(SONG_FIELDS.map(id => $(id)?.value || ''));

function openSongEditor(song = null) {
    editSongId = song?.id || null;
    setText('song-edit-title', song ? t('songbook_edit', 'Edit song') : t('songbook_new', 'New song'));
    setValue('song-edit-name', song?.title || '');
    setValue('song-edit-artist', song?.artist || '');
    setValue('song-edit-key', song?.key || '');
    setValue('song-edit-ccli', song?.ccli || '');
    setValue('song-edit-copyright', song?.copyright || '');
    setValue('song-edit-content', song?.content || '');
    show('song-delete-btn', !!song, 'inline-flex');
    // A CCLI song number only counts together with the church's licence number
    show('song-edit-license-hint', !songbookLicense);
    previewSongEdit();
    songEditSnapshot = songEditState();
    openModal('song-edit-modal');
}

// Leaving the editor with changes asks first (back button, Cancel, Escape, back gesture)
modalCloseGuards['song-edit-modal'] = () => songEditState() === songEditSnapshot || confirmAction(t('songbook_discard', 'Discard your changes?'));

function editOpenSong() {
    const song = songs.find(s => s.id === openSongId);
    if (song) openSongEditor(song);
}

const previewSongEdit = debounce(() => {
    const target = $('song-edit-preview');
    if (!target) return;
    const html = renderSongHtml(inputValue('song-edit-content'), { declaredKey: inputValue('song-edit-key'), labels: songSectionLabels() });
    target.innerHTML = html || `<span class="song-edit-empty">${t('songbook_preview_empty', 'The song appears here as it will be shown.')}</span>`;
}, 150);

async function saveSong() {
    const editedSong = songs.find(s => s.id === editSongId);
    const payload = {
        title: inputValue('song-edit-name'),
        artist: inputValue('song-edit-artist'),
        key: inputValue('song-edit-key').trim(),
        // Capo and tempo are no longer shown or edited; a song keeps the values it already has
        capo: editedSong?.capo ?? '',
        tempo: editedSong?.tempo ?? '',
        ccli: inputValue('song-edit-ccli'),
        copyright: inputValue('song-edit-copyright'),
        content: $('song-edit-content')?.value || ''
    };
    const btn = $('song-save-btn');
    if (btn) btn.disabled = true;
    try {
        const saved = editSongId
            ? await apiJson(`/songs/${encodeURIComponent(editSongId)}`, 'PUT', payload)
            : await apiJson('/songs', 'POST', payload);
        songs = sortSongs([...songs.filter(s => s.id !== saved.id), { ...saved, _search: searchText(saved) }]);
        closeModal('song-edit-modal', false, true);
        renderSongs();
        if (openSongId === saved.id) renderSongView();
        showToast(t('songbook_saved', 'Song saved'));
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteSong() {
    if (!editSongId || !confirmAction(t('songbook_delete_confirm', 'Delete the song for good?'))) return;
    try {
        await apiJson(`/songs/${encodeURIComponent(editSongId)}`, 'DELETE');
        songs = songs.filter(s => s.id !== editSongId);
        closeModal('song-edit-modal', false, true);
        if (openSongId === editSongId) closeSong();
        renderSongs();
        showToast(t('songbook_deleted', 'Song deleted'));
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// --- Create a poll ---
function renderPollOptionInputs(values) {
    const target = $('poll-options');
    if (!target) return;
    target.innerHTML = values.map((value, i) => `
        <div class="poll-option-input">
            <input type="text" class="poll-editor-input" maxlength="100" value="${escapeHtml(value)}" placeholder="${escapeHtml(t('polls_option_ph', 'Answer {n}', { n: i + 1 }))}">
            ${values.length > 2 ? `<button type="button" class="poll-option-remove" onclick="window.removePollOption(${i})" aria-label="${escapeHtml(t('btn_remove', 'Remove'))}">${svgIcon('x', 16, 2.5)}</button>` : ''}
        </div>`).join('');
    show('poll-add-option', values.length < 10, 'inline-flex');
}

const currentPollOptions = () => [...document.querySelectorAll('#poll-options input')].map(i => i.value);
const addPollOption = () => renderPollOptionInputs([...currentPollOptions(), '']);
const removePollOption = index => renderPollOptionInputs(currentPollOptions().filter((_, i) => i !== index));

function setPollDuration(days) {
    const end = new Date(Date.now() + days * 86400000);
    setValue('poll-end-date', toDateStr(end));
    setValue('poll-end-time', `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`);
    document.querySelectorAll('.poll-chip').forEach(chip => chip.classList.toggle('is-active', chip.dataset.days === String(days)));
}

// A date or time typed by hand no longer matches a duration chip
const clearPollDurationChips = () => document.querySelectorAll('.poll-chip').forEach(chip => chip.classList.remove('is-active'));

function openCreatePoll() {
    setValue('poll-question', '');
    setValue('poll-description', '');
    const multiple = $('poll-multiple');
    if (multiple) multiple.checked = false;
    renderPollOptionInputs(['', '']);
    setPollDuration(7);
    // The end lies between today and one year ahead (the server checks the exact limits)
    const dateInput = $('poll-end-date');
    if (dateInput) {
        dateInput.min = toDateStr(new Date());
        dateInput.max = toDateStr(new Date(Date.now() + 365 * 86400000));
    }
    openModal('poll-create-modal');
}

async function submitPoll() {
    const date = inputValue('poll-end-date');
    const time = inputValue('poll-end-time') || '23:59';
    const endsAt = date ? new Date(`${date}T${time}`).getTime() : NaN;
    const payload = {
        title: inputValue('poll-question'),
        description: inputValue('poll-description'),
        options: currentPollOptions().map(v => v.trim()).filter(Boolean),
        multiple: isChecked('poll-multiple'),
        endsAt
    };
    const btn = $('poll-submit');
    if (btn) btn.disabled = true;
    try {
        const created = await apiJson('/polls', 'POST', payload);
        polls = [created, ...polls];
        closeModal('poll-create-modal');
        setPollFilter('open');
        showToast(t('polls_created', 'Poll started'));
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// --- Settings as a menu with sub-pages (like the Android app); the registration code stays on top ---
const SETTINGS_PAGES = [
    { key: 'profile' },
    { key: 'notifications', icon: 'bell', color: '#f59e0b', title: ['notif_channels_title', 'Notifications'] },
    { key: 'appearance', icon: 'palette', color: '#8b5cf6', title: ['settings_appearance', 'Appearance & language'], desc: ['settings_appearance_desc', 'Theme and language'] },
    { key: 'password', icon: 'lock', color: '#64748b', title: ['change_password_title', 'Change Password'], desc: ['settings_password_desc', 'Set a new password'] },
    { key: 'calendar', icon: 'calendar', color: '#0891b2', title: ['calendar_sub_title', 'Calendar Subscription'], desc: ['settings_calendar_desc', 'Your appointments in your own calendar'] },
    { key: 'fees', icon: 'coin', color: '#10b981', title: ['rates_title', 'Monthly Fees'], desc: ['settings_fees_desc', 'Monthly fees per status'] },
    { key: 'account', icon: 'shield', color: '#0ea5e9', title: ['settings_account_title', 'Account & privacy'], desc: ['settings_account_desc', 'Privacy, delete account'] }
];

function setupSettingsNav(root) {
    if (!root || root.querySelector('.settings-nav')) return;
    root.classList.add('settings-paged');
    const nav = document.createElement('div');
    nav.className = 'settings-nav';
    nav.innerHTML = `
        <div class="settings-nav-head">
            <button type="button" class="settings-back-btn" onclick="window.closeSettingsPage()" data-i18n-aria-label="btn_back" aria-label="${escapeHtml(t('btn_back', 'Back'))}">${svgIcon('chevronLeft', 20, 2.5)}</button>
            <h2 class="settings-nav-title" tabindex="-1"></h2>
        </div>
        <div class="settings-nav-top"></div>
        <div class="settings-menu"></div>`;
    root.prepend(nav);
    // The registration code stays visible on top of the menu
    const invite = root.querySelector('.premium-invite-card');
    if (invite) nav.querySelector('.settings-nav-top').appendChild(invite);
}

// A page is offered when one of its parts is not hidden by the rights (inline display: none); the fees only with
// the finance permission (members never see the admin settings tab, but a #settings link must not show them)
const settingsPageAvailable = (root, key) => (key !== 'fees' || canViewFinances() || isSuperAdminUser())
    && [...root.querySelectorAll(`[data-settings-page~="${key}"]`)].some(el => el.style.display !== 'none');

function notificationSummary() {
    const { push, email } = readNotificationSettings().channels;
    return push && email ? t('notif_summary_both', 'Push and e-mail') : push ? t('notif_summary_push', 'Push only')
        : email ? t('notif_summary_email', 'E-mail only') : t('notif_summary_off', 'Off');
}

function renderSettingsMenu(root) {
    const menu = root?.querySelector('.settings-menu');
    if (!menu || !currentUser) return;
    const name = fullName(currentUser) || currentUser.email || '';
    const rows = SETTINGS_PAGES.filter(page => settingsPageAvailable(root, page.key)).map(page => {
        if (page.key === 'profile') return `
            <button type="button" class="settings-row" data-key="profile" onclick="window.openSettingsPage('profile')">
                <span class="settings-row-ring ${getAvatarRingClass(currentUser)}">${renderAvatarWrap(currentUid(), name, { wrapClass: 'settings-row-avatar', imgClass: 'settings-row-avatar-img', initialsClass: 'settings-row-initials' })}</span>
                <span class="settings-row-text"><span class="settings-row-title">${escapeHtml(name)}</span><span class="settings-row-desc">${escapeHtml(currentUser.email || '')}</span></span>
                ${svgIcon('chevronRight', 18, 2.5, 'class="settings-row-chevron"')}
            </button>`;
        const desc = page.key === 'notifications' ? notificationSummary() : t(...page.desc);
        return `
            <button type="button" class="settings-row" data-key="${page.key}" style="--row-color: ${page.color};" onclick="window.openSettingsPage('${page.key}')">
                <span class="settings-row-icon">${svgIcon(page.icon, 20, 2)}</span>
                <span class="settings-row-text"><span class="settings-row-title">${t(...page.title)}</span><span class="settings-row-desc">${escapeHtml(desc)}</span></span>
                ${svgIcon('chevronRight', 18, 2.5, 'class="settings-row-chevron"')}
            </button>`;
    }).join('');
    renderSettingsProfile(root, name);
    root.querySelectorAll('.settings-delete-card .settings-row[aria-expanded="true"]').forEach(btn => toggleDeleteAccount(btn, false));
    menu.innerHTML = `
        <div class="settings-menu-card">${rows}</div>
        <div class="settings-menu-card">
            <button type="button" class="settings-row is-danger" onclick="window.logout()">
                <span class="settings-row-icon">${svgIcon('logout', 20, 2)}</span>
                <span class="settings-row-text"><span class="settings-row-title">${t('logout', 'Log Out')}</span></span>
            </button>
        </div>`;
}

function renderSettingsProfile(root, name) {
    const ring = root.querySelector('[data-profile-ring]');
    if (!ring) return;
    ring.classList.remove('avatar-ring-manager', 'avatar-ring-mentor', 'avatar-ring-standard');
    ring.classList.add(getAvatarRingClass(currentUser));
    root.querySelectorAll('[data-profile-name]').forEach(el => { el.textContent = name; });
    root.querySelectorAll('[data-profile-email]').forEach(el => { el.textContent = name === currentUser.email ? '' : currentUser.email || ''; });
    root.querySelectorAll('[data-profile-initials]').forEach(el => { el.textContent = getInitials(name); });
}

const settingsRoot = () => $(currentActiveTab === 'settings' ? 'settings' : 'user-settings');

function openSettingsPage(key, { fromRoute = false } = {}) {
    const root = settingsRoot();
    const page = SETTINGS_PAGES.find(p => p.key === key);
    if (!root || !page) return;
    // From the menu to a page: a level of its own (moving between pages beside the menu is not one)
    if (!fromRoute && !root.dataset.page) pushHistoryLevel('page');
    root.dataset.page = key;
    syncUrl();
    const title = root.querySelector('.settings-nav-title');
    title.textContent = page.title ? t(...page.title) : t('settings_profile', 'Profile');
    if (key === 'appearance') renderSettingsPills();
    document.querySelector('.container')?.scrollTo({ top: 0 });
    // The row that had the focus is hidden now: keyboard and screen reader users continue at the page title
    title.focus({ preventScroll: true });
}

function closeSettingsPage(fromHistory = false) {
    const root = settingsRoot();
    if (!root) return;
    if (fromHistory !== true) leaveHistoryLevels('page');
    const left = root.dataset.page;
    delete root.dataset.page;
    renderSettingsMenu(root);
    syncUrl();
    document.querySelector('.container')?.scrollTo({ top: 0 });
    root.querySelector(`.settings-row[data-key="${left}"]`)?.focus({ preventScroll: true });
}

const settingsPageOpen = () => ['settings', 'user-settings'].includes(currentActiveTab) && !!$(currentActiveTab)?.dataset.page;
const HUB_TABS = ['ai-chat', 'polls', 'songbook', 'prayers', 'media'];

function updateFabVisibility() {
    const financesFab = currentActiveTab === 'finances' && canManageFinances();
    const eventsFab = currentActiveTab === 'events' && !!currentUser;
    // Polls: the same "+" opens the create page directly (one action, no menu)
    const pollsFab = currentActiveTab === 'polls' && !!currentUser;
    const songbookFab = currentActiveTab === 'songbook' && songbookCanManage;
    const prayersFab = currentActiveTab === 'prayers' && !!currentUser;
    // Media: upload and new folder where the member may write
    const mediaFab = currentActiveTab === 'media' && mediaListing?.access === 'write' && mediaLoadedPath === mediaFolder && !mediaSelected.size;
    const visible = financesFab || eventsFab || pollsFab || songbookFab || prayersFab || mediaFab;
    show('fab-finances-items', financesFab, 'block');
    show('fab-events-items', eventsFab, 'block');
    show('fab-media-items', mediaFab, 'block');
    const desktopFab = $('desktop-fab');
    if (desktopFab) {
        desktopFab.style.display = visible ? 'flex' : 'none';
        if (!visible) {
            desktopFab.classList.remove('active');
            desktopFab.setAttribute('aria-expanded', 'false');
        }
    }
    const fabMenu = $('fabMenu');
    if (fabMenu) {
        if (!visible) fabMenu.classList.remove('show');
        fabMenu.style.display = visible ? '' : 'none';
    }
}

function switchFinanceSubpage(subpage) {
    const members = subpage === 'members';
    $('finances-subpage-members')?.classList.toggle('active', members);
    $('finances-subpage-history')?.classList.toggle('active', !members);
    $('finances-sub-btn-members')?.classList.toggle('active', members);
    $('finances-sub-btn-history')?.classList.toggle('active', !members);
    if (members) {
        renderPeople();
    } else {
        renderHistoryTab(true);
        renderStats();
    }
    syncUrl();
}

const TAB_ALIASES = { overview: 'finances', 'payment-history': 'finances', 'people-view': 'finances', 'user-history': 'user-finances', 'user-requests': 'user-finances', calendar: 'events' };
const TAB_GUARDS = {
    finances: () => canViewFinances(),
    'super-admin-settings': () => isSuperAdminUser(),
    // The admin settings (registration code, fees) only for those who manage something there
    settings: () => isSuperAdminUser() || canViewFinances() || canManageRegistrationCode(),
    'ai-chat': () => canAccessAi() && aiEnabled,
    mentoring: () => canUseMentoring()
};
const TAB_LOADERS = {
    finances: () => {
        if ($('finances-subpage-members')?.classList.contains('active')) {
            renderPeople();
        } else {
            renderHistoryTab(true);
            renderStats();
        }
    },
    'user-overview': () => renderUserView(),
    'super-admin-settings': () => {
        switchSysSettingsTab(currentSysSettingsTab);
        loadSystemGroups();
    },
    mentoring: () => {
        if (!openingDirectChat) currentMentoringSubTab = 'chats';
        loadMentoringData();
    },
    events: () => loadEventsData(),
    settings: () => {
        updateNotificationPreferencesUI();
        loadPersonalCalendarFeedSettings();
    }
};
TAB_LOADERS['user-settings'] = TAB_LOADERS.settings;

// --- Tab history: like the Android app, back from any tab (or the settings) returns to the start page ---
const HOME_TAB = 'user-overview';
let tabHistoryPushed = false;
// One entry above the "not home" entry per level the member went down to by tapping: 'app' (from Extras),
// 'folder' (in the media library), 'page' (a settings page)
const historyLevels = [];

/** Called on a tap that goes one level down: the entry is made while the tap counts as the member's own. */
function pushHistoryLevel(kind) {
    if (!tabHistoryPushed) return;
    history.pushState({ tab: currentActiveTab, level: kind }, '');
    historyLevels.push(kind);
}

/** Going up in the app itself (its back button, the folder path): up to [max] entries of [kind] are left behind. */
function leaveHistoryLevels(kind, max = 1) {
    let steps = 0;
    while (steps < max && historyLevels[historyLevels.length - 1] === kind) {
        historyLevels.pop();
        steps++;
    }
    if (steps) programmaticBack(steps);
}

function syncTabHistory(tabName, previousTab) {
    // Another tab: the levels of this one are left behind
    const levels = tabName !== previousTab ? historyLevels.splice(0).length : 0;
    if (tabName === HOME_TAB) {
        if (tabHistoryPushed && history.state?.tab) {
            tabHistoryPushed = false;
            programmaticBack(levels + 1);
        } else if (levels) {
            programmaticBack(levels);
        }
        return;
    }
    if (levels) programmaticBack(levels);
    // One history entry for "somewhere other than home"; moving between tabs only replaces it
    if (tabHistoryPushed && history.state?.tab) history.replaceState({ tab: tabName }, '');
    else {
        history.pushState({ tab: tabName }, '');
        tabHistoryPushed = true;
    }
}

// source: the clicked nav element (ignored) or 'history' when called from a back navigation
function switchTab(tabName, source) {
    // A switched-off app (old link, remembered tab) opens the hub instead
    if (tabName === 'polls' && !FEATURES.polls) tabName = 'hub';
    // The owner runs the instance and cannot delete their account (the server refuses it too)
    if (tabName === 'settings' || tabName === 'user-settings') {
        for (const id of ['card-delete-account-admin', 'card-delete-account-user']) show(id, !isOwnerUser(), 'block');
        const root = $(tabName);
        setupSettingsNav(root);
        delete root.dataset.page;
        renderSettingsMenu(root);
    }
    if (tabName === 'hub') renderHub();
    if (tabName === 'polls') loadPolls();
    if (tabName === 'songbook') loadSongs();
    if (tabName === 'prayers') loadPrayers();
    if (tabName === 'media') {
        loadMediaStatus();
        loadMediaFolder();
    }
    if (tabName === 'ai-chat' && !aiMessages.length) clearAiChat();
    updateFabVisibility();
    if (tabName !== 'mentoring') {
        mentoringChatReturnHome = false;
        closeMentoringChatMobile(true);
    }
    if (tabName === 'overview' || tabName === 'payment-history') switchFinanceSubpage('history');
    else if (tabName === 'people-view') switchFinanceSubpage('members');
    tabName = TAB_ALIASES[tabName] || tabName;
    // Without the right: the AI chat falls back to Extras (the AI status may still be loading), the admin settings
    // to the member settings, everything else to the start page
    if (TAB_GUARDS[tabName] && !TAB_GUARDS[tabName]()) {
        tabName = tabName === 'ai-chat' ? 'hub' : tabName === 'settings' ? 'user-settings' : 'user-overview';
        if (tabName === 'hub') renderHub();
        if (tabName === 'user-settings') {
            const root = $(tabName);
            setupSettingsNav(root);
            delete root.dataset.page;
            renderSettingsMenu(root);
        }
    }

    const previousTab = currentActiveTab;
    currentActiveTab = tabName;
    updateNavVisibility();

    const desktopNav = [...document.querySelectorAll('#desktop-nav [data-tab], .desktop-nav [data-tab]')];
    const currentIndex = desktopNav.findLastIndex(el => el.classList.contains('active'));
    const targetIndex = desktopNav.findLastIndex(el => el.dataset.tab === tabName);
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active', 'slide-in-right', 'slide-in-left'));
    $(tabName)?.classList.add('active', currentIndex > -1 && targetIndex > -1 && targetIndex < currentIndex ? 'slide-in-left' : 'slide-in-right');

    const container = document.querySelector('.container');
    revealHeader();
    if (container) {
        container.classList.toggle('ai-chat-active', tabName === 'ai-chat');
        if (tabName === 'ai-chat') {
            requestAnimationFrame(() => {
                adjustAiInputHeight($('ai-chat-input'));
                const messagesEl = $('ai-chat-messages');
                if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
            });
        }
    }

    document.querySelectorAll('#desktop-nav [data-tab], #bottom-nav [data-tab], .desktop-nav [data-tab], .bottom-nav [data-tab]').forEach(el => {
        // Apps inside "Extras" keep its nav entry highlighted
        const active = el.dataset.tab === tabName || (HUB_TABS.includes(tabName) && el.dataset.tab === 'hub');
        el.classList.toggle('active', active);
        // Navigation, not tabs: the current page is "aria-current" (aria-selected only belongs to role="tab")
        el.removeAttribute('aria-selected');
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
    if (source !== 'history' && isAuthenticated) syncTabHistory(tabName, previousTab);
    TAB_LOADERS[tabName]?.();
    syncUrl();
}

// --- Addresses: every page has its own path (/events, /events/Jugendfreizeit_2026, /settings/profile, ...) ---
// The history keeps its shape (start page, one entry for "somewhere else", open pop-ups); the address of the
// current entry follows what is on screen. Old #links (notifications, the apps, bookmarks) still lead there.
const slugify = text => String(text || '').normalize('NFC').trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);
const titleSlug = item => slugify(item.title) || item.id;

// A readable name for an item of a list: its title; when titles repeat, the date (events) or the id tells them apart
function itemSlug(item, list, date) {
    const base = titleSlug(item);
    const twins = list.filter(other => titleSlug(other) === base);
    if (twins.length <= 1) return base;
    const day = date?.(item);
    if (day && twins.filter(other => date(other) === day).length === 1) return `${base}_${day}`;
    return `${base}~${item.id}`;
}

function findBySlug(list, slug, date) {
    if (!slug) return null;
    const exact = list.find(item => itemSlug(item, list, date) === slug);
    if (exact) return exact;
    const id = slug.includes('~') ? slug.split('~').pop() : slug;
    const byId = list.find(item => item.id === id);
    if (byId) return byId;
    // An older link whose title got a twin since: the one of that day, else the next upcoming (or the latest)
    const dated = date ? /^(.*)_(\d{4}-\d{2}-\d{2})$/.exec(slug) : null;
    const twins = list.filter(item => titleSlug(item) === (dated ? dated[1] : slug));
    if (dated) return twins.find(item => date(item) === dated[2]) || null;
    if (!date || twins.length < 2) return twins[0] || null;
    const sorted = [...twins].sort((a, b) => String(date(a)).localeCompare(String(date(b))));
    return sorted.find(item => String(date(item)) >= getTodayStr()) || sorted[sorted.length - 1];
}

const eventDay = ev => ev.date;
const eventSlug = ev => itemSlug(ev, appEvents, eventDay);
const songSlug = song => itemSlug(song, songs);

const TAB_PATHS = { 'user-overview': '', finances: 'finances', 'user-finances': 'finances', events: 'events', mentoring: 'mentoring', hub: 'extras', songbook: 'songbook', prayers: 'prayers', media: 'media', 'ai-chat': 'ai', polls: 'polls', settings: 'settings', 'user-settings': 'settings', 'super-admin-settings': 'system' };
// First part of a path → tab (old tab ids keep working)
const ROUTE_TABS = {
    '': () => HOME_TAB, 'index.html': () => HOME_TAB, home: () => HOME_TAB, 'user-overview': () => HOME_TAB,
    finances: () => (canViewFinances() ? 'finances' : 'user-finances'),
    events: () => 'events', mentoring: () => 'mentoring', extras: () => 'hub', songbook: () => 'songbook',
    ai: () => 'ai-chat', polls: () => 'polls', prayers: () => 'prayers', media: () => 'media', system: () => 'super-admin-settings',
    settings: () => (TAB_GUARDS.settings() ? 'settings' : 'user-settings')
};
// Old #links → paths
const LEGACY_HASHES = { 'super-admin-settings': 'system', 'user-finances': 'finances', requests: 'finances', overview: 'finances', 'payment-history': 'finances', 'user-history': 'finances', 'user-requests': 'finances', 'people-view': 'finances/members', calendar: 'events', 'ai-chat': 'ai', 'user-settings': 'settings', hub: 'extras' };

function legacyHashPath(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].trim();
    if (!raw) return null;
    const [head, ...rest] = raw.split('/');
    return '/' + [head in LEGACY_HASHES ? LEGACY_HASHES[head] : head, ...rest].filter(Boolean).join('/');
}

const shownModal = id => !!$(id)?.classList.contains('show');

/** The path of what is on screen. */
function routePath() {
    if (shownModal('event-detail-modal') && currentDetailEvent && appEvents.some(ev => ev.id === currentDetailEvent.id)) {
        return `/events/${encodeURIComponent(eventSlug(currentDetailEvent))}`;
    }
    const song = shownModal('song-view-modal') && songs.find(s => s.id === openSongId);
    if (song) return `/songbook/${encodeURIComponent(songSlug(song))}`;
    const tab = currentActiveTab;
    let sub = '';
    if (tab === 'finances' && $('finances-subpage-members')?.classList.contains('active')) sub = 'members';
    else if (tab === 'mentoring') sub = activeMentoringThreadId ? `chat/${encodeURIComponent(activeMentoringThreadId)}` : (currentMentoringSubTab !== 'chats' ? currentMentoringSubTab : '');
    else if (tab === 'settings' || tab === 'user-settings') sub = $(tab)?.dataset.page || '';
    else if (tab === 'super-admin-settings' && currentSysSettingsTab !== 'accounts') sub = currentSysSettingsTab;
    else if (tab === 'media') sub = mediaFolder.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return '/' + [TAB_PATHS[tab] ?? '', sub].filter(Boolean).join('/');
}

// Until the first route after signing in is applied, the address still holds where the person wanted to go
let routeReady = false;
function syncUrl() {
    if (!isAuthenticated || !routeReady) return;
    const path = routePath();
    if (window.location.pathname !== path || window.location.hash) history.replaceState(history.state, '', path + window.location.search);
}

let pendingSongSlug = null;

/** Shows the page of a path: tab, sub-page, event, song, chat. */
async function applyRoute(path) {
    const [head = '', ...rest] = String(path || '/').split('/').filter(Boolean).map(part => {
        try { return decodeURIComponent(part); } catch { return part; }
    });
    const known = ROUTE_TABS[head]?.();
    const tab = known || ($(head)?.classList.contains('tab-content') ? head : HOME_TAB);
    const [sub, extra] = known || head === tab ? rest : [];
    if (tab === 'songbook' && sub) pendingSongSlug = sub;
    // /media/Photos/2026: the folder (every part after /media)
    if (tab === 'media') mediaFolder = folderFromRoute(known || head === tab ? rest : []);
    switchTab(tab);
    if (currentActiveTab === 'finances' && sub === 'members') switchFinanceSubpage('members');
    else if ((currentActiveTab === 'settings' || currentActiveTab === 'user-settings') && sub && SETTINGS_PAGES.some(p => p.key === sub) && settingsPageAvailable($(currentActiveTab), sub)) openSettingsPage(sub, { fromRoute: true });
    else if (currentActiveTab === 'super-admin-settings' && sub && SYS_TAB_LOADERS[sub]) switchSysSettingsTab(sub);
    else if (currentActiveTab === 'mentoring' && sub === 'chat' && extra) openMentoringChatDirect(extra);
    else if (currentActiveTab === 'mentoring' && sub && MENTORING_SUBTABS[sub] && $(`mentoring-tab-${sub}`)?.style.display !== 'none') switchMentoringSubTab(sub);
    else if (currentActiveTab === 'events' && sub) await openEventFromRoute(sub);
    syncUrl();
}

async function openEventFromRoute(slug) {
    // A shared link also names the event by its share key: the title, and with it the address, may have changed
    const shareToken = linkParam('share');
    const find = () => (shareToken && appEvents.find(ev => ev.publicToken === shareToken)) || findBySlug(appEvents, slug, eventDay);
    let ev = find();
    if (!ev) {
        await loadEventsData();
        ev = find();
    }
    if (ev) {
        // A member gets their own page; the link's keys leave the address
        if (hasGuestLink()) history.replaceState(history.state, '', window.location.pathname);
        await openEventDetailModal(ev.id);
    }
    // Not one of the member's events (another group's, a guest's link from an e-mail): the page guests see
    else if (hasGuestLink()) await openGuestEvent(false);
    else showToast(t('events_link_missing', 'This event no longer exists.'), 'error');
}

/** Once after signing in: the page the address names (or an old #link), on top of the start page. */
function applyInitialRoute() {
    const target = legacyHashPath(window.location.hash) ?? window.location.pathname;
    // A reload keeps the history entry of a deeper page: it stays that entry instead of getting a second one
    if (history.state?.tab || history.state?.isModal || history.state?.view) {
        history.replaceState({ tab: 'restored' }, '');
        tabHistoryPushed = true;
    } else {
        history.replaceState(null, '', '/' + window.location.search);
    }
    routeReady = true;
    return applyRoute(target);
}

/** An old #link opened inside the running app: its entry gets the page's own address, then the app goes there. */
function followLegacyHash() {
    const path = legacyHashPath(window.location.hash);
    if (!path || !isAuthenticated || !routeReady) return false;
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
    applyRoute(path);
    return true;
}
window.addEventListener('hashchange', followLegacyHash);

function closeProfileMenu() {
    $('profileDropdown')?.classList.remove('show');
    $('profile-scrim')?.classList.remove('show');
    document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
}

/** The profile menu like the Android app's (a simple fade instead of its animation): the panel hangs 4px over the button's top right
 * corner and stays 12px inside the window; the button's picture is shown at its top left, next to name and e-mail. */
function toggleProfileMenu() {
    const menu = $('profileDropdown');
    const btn = document.querySelector('.profile-btn');
    if (!menu || !btn) return;
    if (menu.classList.contains('show')) return closeProfileMenu();
    const picture = btn.cloneNode(true);
    picture.removeAttribute('onclick');
    picture.tabIndex = -1;
    for (const el of [picture, ...picture.querySelectorAll('[id]')]) el.removeAttribute('id');
    $('profile-menu-pic')?.replaceChildren(picture);
    const box = btn.getBoundingClientRect();
    const right = document.documentElement.clientWidth - box.right - 4;
    menu.style.top = `${Math.max(4, box.top - 4)}px`;
    menu.style.right = `${Math.max(12, right)}px`;
    menu.classList.add('show');
    $('profile-scrim')?.classList.add('show');
    btn.setAttribute('aria-expanded', 'true');
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !$('profileDropdown')?.classList.contains('show')) return;
    closeProfileMenu();
    document.querySelector('.profile-btn')?.focus();
});
// Placed for the window it was opened in
window.addEventListener('resize', closeProfileMenu);

document.addEventListener('click', e => {
    const dropdown = $('mentoring-chat-menu-dropdown');
    if (dropdown?.style.display === 'block' && !$('mentoring-chat-menu-btn')?.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
});

function toggleFab() {
    if (currentActiveTab === 'polls') {
        openCreatePoll();
        return;
    }
    if (currentActiveTab === 'songbook') {
        openSongEditor();
        return;
    }
    if (currentActiveTab === 'prayers') {
        openPrayerEditor();
        return;
    }
    if (currentActiveTab === 'events' && !canManageEvents()) {
        openNewEventDetailModal('event');
        return;
    }
    const menu = $('fabMenu');
    if (!menu) return;
    const expanded = menu.classList.toggle('show');
    document.querySelectorAll('.nav-fab, .desktop-fab, .mobile-fab').forEach(fab => {
        fab.classList.toggle('active', expanded);
        fab.setAttribute('aria-expanded', expanded);
    });
}

// --- Theme ---
function applyActualTheme(theme) {
    const actual = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
    document.documentElement.setAttribute('data-theme', actual);
    // The status / title bar takes the page's own background (it used to be a blue of an old palette)
    const pageBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || (actual === 'dark' ? '#181817' : '#f5f4f1');
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = pageBg; });
}

const storedTheme = () => localStorage.getItem('agora-theme') || localStorage.getItem('nova-theme') || 'system';

function setTheme(theme) {
    localStorage.setItem('agora-theme', theme);
    applyActualTheme(theme);
    syncPreferenceSelects(theme);
}

document.addEventListener('DOMContentLoaded', () => {
    setText('app-name-header', APP_NAME);
    setText('login-app-name', APP_NAME);
    document.title = APP_NAME;
    setTheme(storedTheme());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (storedTheme() === 'system') applyActualTheme('system');
    });
    $('expense-receipt')?.addEventListener('change', e => {
        addPendingFiles('expense', Array.from(e.target.files || []));
        e.target.value = '';
    });
    ['payment-date', 'donation-date', 'expense-date', 'change-status-date'].forEach(id => setValue(id, getTodayStr()));
    adjustAiInputHeight($('ai-chat-input'));
});

// --- Data loading ---
async function refreshCurrentUser() {
    try {
        const data = await apiJson('/auth/me');
        if (data?.user) {
            currentUser = { ...currentUser, ...data.user };
            updateNavVisibility();
        }
    } catch (err) {
        console.warn('Could not refresh current user info:', err);
    }
}

const findLinkedPerson = uid => people.find(p => p.uid === uid || (p.data && p.data.uid === uid));
const findPerson = id => people.find(p => String(p.id) === String(id));

// Members only see their own person entry and requests; the person is auto-linked by name on first login.
async function loadMemberData() {
    const uid = currentUser.uid;
    const peopleRef = ref(db, 'people');
    const byField = (field, value) => get(query(peopleRef, orderByChild(field), equalTo(value))).then(snap => snap.exists() ? snap.val() : {});
    // Independent requests run side by side (each round trip costs on mobile data)
    const [sData, ownPeople, rSnap] = await Promise.all([
        apiGet('settings').catch(err => (console.warn('Could not fetch settings:', err), null)),
        byField('uid', uid).catch(err => (console.warn('Could not load people:', err), {})),
        // The server only returns the own requests; no userId filter here (decided requests used to carry the treasurer's id)
        get(ref(db, 'requests')).catch(err => (console.warn('Could not get requests:', err), null))
    ]);
    settings = sData || settings;
    let peopleList = [];
    try {
        peopleList = safeList(ownPeople);
        // Members created before their account existed: link the person record with the same name once
        const name = fullName(currentUser) || currentUser.name || '';
        if (peopleList.length === 0 && name) {
            const val = await byField('name', name);
            const key = Object.keys(val)[0];
            if (key) {
                await update(child(peopleRef, key), { uid }).catch(err => console.warn('Auto-link update failed:', err));
                peopleList = [{ ...val[key], uid }];
            }
        }
    } catch (err) {
        console.warn('Could not load people:', err);
    }
    people = peopleList.filter(p => !p.isDeleted);
    requests = (rSnap?.exists() ? safeList(rSnap.val()) : []).filter(isOwnRequest);
}

async function loadAdminData() {
    const withFinances = canViewFinances();
    const [pData, sData, rData, uData] = await Promise.all(['people', 'settings', withFinances && 'requests', 'users'].map(path => path ? apiGet(path).catch(() => null) : null));
    people = safeList(pData).filter(p => !p.isDeleted);
    requests = safeList(rData);
    if (sData) {
        settings = sData;
    }
    users = Object.entries(uData || {}).map(([uid, data]) => {
        if (!withFinances) return { ...data, uid };
        const linked = findLinkedPerson(uid);
        return {
            ...data,
            uid,
            memberSince: data.memberSince || linked?.memberSince || linked?.data?.memberSince || '',
            status: data.status || linked?.status || linked?.data?.status || ''
        };
    });
}

// freshUser: the sign-in just delivered the current account, so /auth/me is not asked again
async function loadData(silent = false, { freshUser = false } = {}) {
    const loader = $('loading-overlay');
    if (loader && !silent) loader.style.display = 'flex';
    try {
        if (isAuthenticated && !freshUser) await refreshCurrentUser();
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        // Events and conversations do not depend on the finance data: start them right away
        const pictures = isAuthenticated ? (picturesReady = loadPictureVersions()) : null;
        if (isAuthenticated) {
            loadMentoringThreads(false);
            loadEventsData();
        }
        const inviteCode = canManageRegistrationCode() ? apiGet('system/inviteCode').catch(() => null) : null;
        if (canViewFinances() || isSuperAdminUser()) await loadAdminData();
        else await loadMemberData();

        if (inviteCode) {
            const code = await inviteCode;
            if (code) updateInviteCodeDisplay(code);
        } else {
            updateInviteCodeDisplay('');
        }

        renderHomeGreeting();
        setText('profile-menu-name', fullName(currentUser) || currentUser.name || '');
        setText('profile-menu-email', currentUser.email || '');
        if (canAccessAi()) {
            apiJson('/admin/ai-status').then(data => {
                aiEnabled = !!data.enabled;
                updateAiNavVisibility();
            }).catch(() => {});
        }
        loadMediaStatus();
        updateNavVisibility();

        if (!routeReady) applyInitialRoute();
        else if (!document.querySelector('.tab-content.active')) switchTab('user-overview');

        await pictures;
        people.forEach(preprocessPerson);
        if (canManageFinances()) {
            // Booked on the latest copy of the record (a transaction): writing this screen's copy of the payments
            // could drop a payment that someone else booked in the meantime
            await Promise.all(people.filter(person => checkAndExecuteStandingOrders(person))
                .map(person => mutatePerson(person.id, latest => checkAndExecuteStandingOrders(latest) || latest)));
        }
        await renderViews(!silent);
    } catch (err) {
        console.error('Ladefehler:', err);
        // A background refresh (live update) keeps what is shown and says so quietly - at most once a minute
        if (!silent) showToast(t('alert_error_loading_data', 'Failed to load data. Please reload the page.'), 'error');
        else if (Date.now() - lastRefreshErrorAt > 60000) {
            lastRefreshErrorAt = Date.now();
            showToast(t('toast_refresh_failed', 'Could not refresh - check your connection.'), 'error');
        }
    } finally {
        if (loader && !silent) loader.style.display = 'none';
    }
}

// Re-renders all data-driven views; `full` additionally syncs settings inputs, push state and system tools.
async function renderViews(full = true) {
    renderUserView();
    if (canViewFinances()) {
        renderPeople();
        await renderStats();
        renderAdminRequests();
        renderUnlinkedUsers();
    }
    if (full) {
        ['vollverdiener', 'geringverdiener', 'keinverdiener'].forEach(key => setValue('rate-' + key, settings[key] || 0));
        updateNotificationPreferencesUI();
        ensurePushNotificationSubscription();
    }
    if (isSuperAdminUser()) {
        await loadSystemGroups(10000);
        renderAccountsTab();
        if (full) {
            renderSuperAdminPaymentEditor();
            if (!advancedConfigLoaded) loadAdvancedSystemConfig();
        }
    }
    updateNavVisibility();
}

// --- Authentication ---
function setLoadingMessage(msg) {
    setText('loading-message', msg);
}

function showAuthLoader(message) {
    $('login-modal').classList.remove('show');
    show('loading-overlay', true, 'flex');
    setLoadingMessage(message);
}

async function fetchUserProfile(uid, retries = 2) {
    const snap = await get(ref(db, 'users/' + uid));
    if (snap.exists()) return { ...snap.val(), uid };
    if (retries <= 0) return null;
    await new Promise(res => setTimeout(res, 400));
    return fetchUserProfile(uid, retries - 1);
}

// Runs beside the start: only a fresh installation (no owner yet) or an owner without flags changes anything,
// then the profile and the data are loaded again
async function bootstrapSuperAdmin(user) {
    try {
        const res = await api('/admin/bootstrap-super-admin', 'POST');
        if (!res.ok) return;
        const result = await res.json();
        if (!(result.isSuperAdmin || result.isOwner)) return;
        if (currentUser?.owner && currentUser?.superAdmin && currentUser?.admin) return;
        currentUser = { ...(currentUser || {}), admin: true, owner: true, superAdmin: true };
        currentUser = { ...currentUser, ...((await fetchUserProfile(user.uid, 2)) || {}) };
        updateNavVisibility();
        loadData(true);
    } catch (error) {
        console.warn('Super admin bootstrap skipped:', error);
    }
}

onAuthStateChanged(auth, async user => {
    if (user) {
        // Signed in from a shared event's page: the app takes over (the route opens the event as a member)
        closeGuestSignIn();
        leaveGuestView();
        showAuthLoader(t('auth_loading_profile', 'Loading profile...'));
        localStorage.setItem('agora-is-logged-in', 'true');
        // /auth/me carries the whole profile plus the computed fields (permissions, mentor status). Opening the app
        // already restored the session with it: no second round trip before the data; after a fresh login it is
        // asked once (it used to be the stored profile first and /auth/me afterwards, one after the other)
        const { getIdToken, ...account } = user;
        const complete = 'isApprovedMentor' in account;
        const profile = complete ? null
            : await apiJson('/auth/me').then(data => data?.user || null).catch(() => null) || await fetchUserProfile(user.uid, 2);
        if (!complete && !profile) setLoadingMessage(t('auth_profile_not_found', 'Profile not found, please contact an admin.'));
        currentUser = { ...(profile || { role: 'user', email: user.email, uid: user.uid }), ...account };
        $('login-modal').classList.remove('show');
        isAuthenticated = true;
        connectSSE();
        loadData(false, { freshUser: complete || 'isApprovedMentor' in (profile || {}) });
        bootstrapSuperAdmin(user);
        loadCurrentProfilePicture();
        ensurePushNotificationSubscription();
        syncUserLanguage();
    } else {
        localStorage.removeItem('agora-is-logged-in');
        localStorage.removeItem('nova-is-logged-in');
        isAuthenticated = false;
        routeReady = false;
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        currentUser = null;
        show('loading-overlay', false);
        // A shared event's link: visitors without an account see the event (members can sign in from there)
        if (hasGuestLink()) {
            openGuestEvent(true);
            return;
        }
        $('login-modal')?.classList.add('show');
        showAuthForm(true);
    }
});

function showAuthForm(isLogin) {
    show('login-form', isLogin, 'block');
    show('register-form', !isLogin, 'block');
    $('btn-show-login').classList.toggle('active', isLogin);
    $('btn-show-register').classList.toggle('active', !isLogin);
    const subtitle = $('auth-subtitle');
    if (subtitle) {
        const key = isLogin ? 'login_subtitle' : 'register_subtitle';
        subtitle.setAttribute('data-i18n', key);
        subtitle.innerText = t(key, isLogin ? 'Melden Sie sich an, um fortzufahren' : 'Erstellen Sie ein neues Konto');
    }
    show('auth-error', false);
    if (!isLogin) setButtonLoading('btn-login', false, null);
}

function showAuthError(msg) {
    const errDiv = $('auth-error');
    errDiv.innerText = msg;
    errDiv.style.display = 'block';
}

async function attemptLogin() {
    const email = inputValue('login-email');
    const pass = inputValue('login-password');
    setButtonLoading('btn-login', true, t('auth_logging_in', 'Signing in...'));
    if (!email || !pass) {
        showAuthError(t('auth_enter_credentials', 'Please enter your email and password.'));
    } else {
        try {
            show('auth-error', false);
            await signInWithEmailAndPassword(auth, email, pass);
            showAuthLoader(t('auth_loading_profile', 'Loading profile...'));
        } catch (error) {
            console.error(error);
            showAuthError(t('auth_login_failed', 'Login failed: ') + error.message);
        }
    }
    setButtonLoading('btn-login', false);
}

async function attemptRegister() {
    const [code, email, first, last, p1, p2] = ['reg-code', 'reg-email', 'reg-firstname', 'reg-lastname', 'reg-pass1', 'reg-pass2'].map(inputValue);
    const validationError = (!code || !email || !first || !last || !p1 || !p2) ? t('alert_fill_fields', 'Please fill out all fields.')
        : p1.length < 6 ? t('setup_admin_password_invalid', 'Password must be at least 6 characters long.')
        : p1 !== p2 ? t('setup_err_password_match', 'Passwords do not match.') : null;
    if (validationError) return showAuthError(validationError);
    try {
        show('auth-error', false);
        showAuthLoader(t('auth_initializing_profile', 'Setting up profile...'));
        await createUserWithEmailAndPassword(auth, email, p1, { inviteCode: code, firstName: first, lastName: last, name: `${first} ${last}`.trim() });
    } catch (error) {
        console.error(error);
        showAuthError(error.status === 403 ? t('auth_invalid_code', 'Invalid registration code.') : t('auth_register_failed', 'Registration failed: ') + error.message);
        show('loading-overlay', false);
        $('login-modal').classList.add('show');
    }
}

// The server sends pushes per device: a device someone signs out on must not keep getting their pushes (with the
// text of their mentoring messages) on a shared tablet or office PC
async function unsubscribeDevicePush() {
    if (!pushSupported()) return;
    const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (subscription) await api('/push/unsubscribe', 'POST', { endpoint: subscription.endpoint });
}

async function logout() {
    history.replaceState(null, '', '/');
    try {
        sseConnection?.close();
        sseConnection = null;
        applyProfilePicture(null);
        // While still signed in; a slow network must not keep anyone from signing out
        await Promise.race([unsubscribeDevicePush(), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {});
        await signOut(auth);
    } catch (error) {
        console.error('Logout Error:', error);
    }
    // A fresh page for the next person: the AI chat, the last open conversation and the loaded lists of this
    // session used to stay in the page and showed up for whoever signed in next on the same device
    location.reload();
}

async function changePassword(isUser = false) {
    const [newId, oldId] = isUser ? ['user-new-password', 'user-old-password'] : ['new-password', 'old-password'];
    const pw = $(newId).value;
    const oldPw = $(oldId).value;
    // Messages as toasts like everywhere else (no blocking browser dialog); the server signs out after a change
    if (!oldPw) return showToast(t('alert_enter_old_password', 'Please enter your old password.'), 'error');
    if (!pw || pw.length < 6) return showToast(t('alert_new_password_length', 'New password must be at least 6 characters long.'), 'error');
    try {
        if (!auth.currentUser) return showToast(t('alert_no_user_logged_in', 'No user logged in.'), 'error');
        await updatePassword(auth.currentUser, oldPw, pw);
        showToast(t('toast_password_changed', 'Password changed – please sign in again.'));
        setValue(newId, '');
        setValue(oldId, '');
    } catch (error) {
        console.error(error);
        showToast(t('alert_password_change_failed', 'Error changing password: ') + error.message, 'error');
    }
}

// Deletes the own account after password confirmation (Google Play account deletion policy)
async function deleteOwnAccount(suffix = '') {
    const input = $(`delete-account-password${suffix}`);
    const password = input?.value || '';
    if (!password) return showToast(t('delete_account_need_password', 'Please enter your password to confirm.'), 'error');
    if (!confirmAction(t('delete_account_confirm', 'Your account and your personal data will be deleted permanently. This cannot be undone. Continue?'))) return;
    try {
        await apiJson('/auth/delete-account', 'POST', { password }, t('delete_account_failed', 'The account could not be deleted.'));
        if (input) input.value = '';
        alert(t('delete_account_done', 'Your account has been deleted.'));
        await logout();
    } catch (err) {
        showToast(err.message || t('delete_account_failed', 'The account could not be deleted.'), 'error');
    }
}

// --- Registration code ---
async function generateNewCode() {
    if (!canManageRegistrationCode()) return showToast(t('alert_no_permission', 'You don\'t have permission to manage the registration code.'), 'error');
    const newCode = String(100000 + (window.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await attempt(async () => {
        await set(ref(db, 'system/inviteCode'), newCode);
        updateInviteCodeDisplay(newCode);
    }, t('alert_save_code_failed', 'New code could not be saved.'));
}

async function copyInviteCode() {
    if (!canManageRegistrationCode()) return showToast(t('alert_no_permission', 'You don\'t have permission to manage the registration code.'), 'error');
    const code = inputValue('admin-invite-code') || inputValue('user-invite-code');
    if (!code || code === '------') return;
    const field = [$('admin-invite-code'), $('user-invite-code')].find(el => el?.offsetParent && el.value === code);
    if (await copyText(code, field)) showToast(t('toast_code_copied', 'Code copied!'));
    else showToast(t('toast_copy_failed', 'Copy failed'), 'error');
}

// --- Notification preferences & web push ---
// Channels (push, e-mail) are master switches; per channel the user picks which kinds of messages arrive.
// Default: push with everything, e-mail off. Same model as backend/notificationPrefs.js.
const NOTIFICATION_TYPES = ['duties', 'events', 'messages', 'requests', 'finances', 'reports'];
const NOTIFICATION_KINDS = {
    duties: { icon: 'clipboard', color: '#6366f1' },
    events: { icon: 'calendar', color: '#0891b2' },
    messages: { icon: 'chat', color: '#7c3aed' },
    requests: { icon: 'fileText', color: '#10b981' },
    finances: { icon: 'dollar', color: '#d97706' },
    reports: { icon: 'flag', color: '#ef4444' }
};
let notificationTab = 'push';

function readNotificationSettings(user = currentUser) {
    const stored = user?.notificationSettings && typeof user.notificationSettings === 'object' ? user.notificationSettings : null;
    const legacyAllOff = !stored && user?.emailNotifications === false;
    const pick = (source, fallback = {}) => Object.fromEntries(NOTIFICATION_TYPES.map(type => [type,
        typeof source?.[type] === 'boolean' ? source[type] : (typeof fallback[type] === 'boolean' ? fallback[type] : true)]));
    return {
        channels: {
            push: typeof stored?.channels?.push === 'boolean' ? stored.channels.push : !legacyAllOff,
            email: typeof stored?.channels?.email === 'boolean' ? stored.channels.email : false
        },
        push: pick(stored?.push, stored || {}),
        email: pick(stored?.email)
    };
}

// Kinds this user can get at all: finance requests only for those who decide on them, reports only for admins
function availableNotificationTypes() {
    const isAdmin = currentUser?.admin === true || currentUser?.owner === true || currentUser?.superAdmin === true;
    return NOTIFICATION_TYPES.filter(type => (type !== 'finances' || isAdmin || canManageFinances()) && (type !== 'reports' || isAdmin));
}

function notificationSwitch(attrs, checked) {
    return `<label class="switch"><input type="checkbox" ${attrs}${checked ? ' checked' : ''}><span class="slider"></span></label>`;
}

function renderNotificationSettings() {
    const targets = document.querySelectorAll('.notif-settings');
    if (!targets.length || !currentUser) return;
    const settings = readNotificationSettings();
    const { push, email } = settings.channels;
    // Without e-mail there is no e-mail tab: only the push choices
    if (!email) notificationTab = 'push';
    else if (!push) notificationTab = 'email';
    const channel = notificationTab;
    const channelRow = (key, icon, title, desc) => `
        <div class="notif-channel${settings.channels[key] ? ' is-on' : ''}">
            <span class="notif-channel-icon">${svgIcon(icon, 18)}</span>
            <span class="notif-channel-text">
                <span class="notif-channel-title">${title}</span>
                <span class="notif-channel-desc">${desc}</span>
            </span>
            ${notificationSwitch(`onchange="window.setNotificationChannel(${jsArg(key)}, this.checked)" aria-label="${escapeHtml(title)}"`, settings.channels[key])}
        </div>`;
    const kinds = availableNotificationTypes().map(type => {
        const kind = NOTIFICATION_KINDS[type];
        return `
        <div class="notif-kind" style="--kind-color: ${kind.color};">
            <span class="notif-kind-icon">${svgIcon(kind.icon, 16)}</span>
            <span class="notif-channel-text">
                <span class="notif-kind-title">${t(`notif_${type}_title`)}</span>
                <span class="notif-channel-desc">${t(`notif_${type}_desc`)}</span>
            </span>
            ${notificationSwitch(`onchange="window.setNotificationKind(${jsArg(channel)}, ${jsArg(type)}, this.checked)" aria-label="${escapeHtml(t(`notif_${type}_title`))}"`, settings[channel][type])}
        </div>`;
    }).join('');
    const html = `
        <div class="notif-head">
            <div class="notif-head-title">${t('notif_channels_title', 'Notifications')}</div>
            <div class="notif-head-desc">${t('notif_channels_desc', 'Choose how you are notified and which messages you get.')}</div>
        </div>
        <div class="notif-channels">
            ${channelRow('push', 'bell', t('notif_channel_push_title', 'Push'), t('notif_channel_push_desc', 'To the installed app (Android app or home screen app)'))}
            ${push ? pushDeviceRow() : ''}
            ${channelRow('email', 'mail', t('notif_channel_email_title', 'E-mail'), currentUser.email ? t('notif_channel_email_desc', 'To {email}', { email: escapeHtml(currentUser.email) }) : t('notif_channel_email_desc_none', 'To your e-mail address'))}
        </div>
        ${!push && !email ? `<div class="notif-off">${svgIcon('bellOff', 18)}<span>${t('notif_all_off', 'You get no notifications. Turn on push or e-mail above.')}</span></div>` : `
        <div class="notif-kinds-head">
            <span class="notif-kinds-title">${t('notif_kinds_title', 'What would you like to get?')}</span>
            ${push && email ? `
            <div class="notif-tabs" role="tablist">
                ${['push', 'email'].map(key => `<button type="button" role="tab" class="notif-tab${channel === key ? ' is-active' : ''}" aria-selected="${channel === key}" onclick="window.setNotificationTab('${key}')">${svgIcon(key === 'push' ? 'bell' : 'mail', 14)}${t(`notif_tab_${key}`)}</button>`).join('')}
            </div>` : `<span class="notif-kinds-channel">${svgIcon(channel === 'push' ? 'bell' : 'mail', 14)}${t(`notif_tab_${channel}`)}</span>`}
        </div>
        <div class="notif-kinds">${kinds}</div>`}`;
    targets.forEach(el => { el.innerHTML = html; });
}

/** Push on this device (installed app only, like the Android app's "This device"): working, blocked or not yet
 * allowed - with "Allow notifications" or "Send test". In a browser tab push never arrives, so nothing is shown. */
function pushDeviceRow() {
    if (!isInstalledApp()) return '';
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const permission = supported ? Notification.permission : 'unsupported';
    const status = {
        granted: t('push_active', 'Active – notifications arrive instantly.'),
        denied: t('push_blocked', 'Blocked – allow notifications for this app in the device settings.'),
        default: t('push_not_set_up', 'Push is not active on this device yet.'),
        unsupported: t('push_unsupported', 'This device does not support push.')
    }[permission];
    const action = permission === 'granted' ? `<button type="button" class="btn btn-secondary btn-small" onclick="window.sendTestPush(this)">${t('push_test', 'Send test')}</button>`
        : permission === 'default' ? `<button type="button" class="btn btn-primary btn-small" onclick="window.allowPushOnDevice()">${t('allow_notifications', 'Allow notifications')}</button>` : '';
    return `
        <div class="notif-device${permission === 'granted' ? ' is-active' : ''}">
            <span class="notif-device-dot" aria-hidden="true"></span>
            <span class="notif-channel-text">
                <span class="notif-channel-title">${t('notif_device_title', 'This device')}</span>
                <span class="notif-channel-desc">${status}</span>
            </span>
            ${action}
        </div>`;
}

async function allowPushOnDevice() {
    await ensurePushNotificationSubscription(true);
    renderNotificationSettings();
}

async function sendTestPush(button) {
    if (button) button.disabled = true;
    // Subscribed again first: a subscription the browser dropped would otherwise make the test silently go nowhere
    await ensurePushNotificationSubscription(false);
    const sent = await attempt(() => apiJson('/push/test', 'POST', {}, t('push_test_failed', 'The test could not be sent.')),
        t('push_test_failed', 'The test could not be sent.'), { toast: 'error' });
    if (sent) showToast(t('push_test_sent', 'Test notification sent'));
    if (button) button.disabled = false;
}

async function saveNotificationSettings(settings) {
    if (!currentUser?.uid) return;
    const notificationSettings = { channels: settings.channels, push: settings.push, email: settings.email, ...settings.push };
    const emailNotifications = settings.channels.push || settings.channels.email;
    const previous = { notificationSettings: currentUser.notificationSettings, emailNotifications: currentUser.emailNotifications };
    Object.assign(currentUser, { notificationSettings, emailNotifications });
    renderNotificationSettings();
    renderSettingsMenu(settingsRoot());
    const saved = await attempt(async () => {
        await update(ref(db, 'users/' + currentUser.uid), { notificationSettings, emailNotifications });
        showToast(t('notification_settings_saved', 'Notification settings saved'));
    }, t('alert_settings_save_failed', 'Settings could not be saved.'), { toast: 'error' });
    if (!saved) {
        Object.assign(currentUser, previous);
        renderNotificationSettings();
    }
}

function setNotificationChannel(channel, on) {
    const settings = readNotificationSettings();
    settings.channels[channel] = on;
    if (on) notificationTab = channel;
    saveNotificationSettings(settings);
}

function setNotificationKind(channel, type, on) {
    const settings = readNotificationSettings();
    settings[channel][type] = on;
    saveNotificationSettings(settings);
}

function setNotificationTab(channel) {
    notificationTab = channel;
    renderNotificationSettings();
}

function updateNotificationPreferencesUI() {
    renderNotificationSettings();
}

// Push only for the installed app (PWA), never in a browser tab: no permission prompt there and no subscription.
// iOS / iPadOS offer web push to home screen apps only anyway (16.4+).
const isInstalledApp = () => window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isInstalledApp();

function urlBase64ToUint8Array(base64String) {
    const base64 = (base64String + '='.repeat((4 - (base64String.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(window.atob(base64), c => c.charCodeAt(0));
}

// Mobile browsers require a user gesture for the permission prompt, so ask on the first tap/click.
let pushAutoPromptRegistered = false;
function setupPwaPushAutoPrompt() {
    if (!pushSupported() || Notification.permission !== 'default' || pushAutoPromptRegistered) return;
    pushAutoPromptRegistered = true;
    const onUserInteraction = async () => {
        window.removeEventListener('click', onUserInteraction, true);
        window.removeEventListener('touchend', onUserInteraction, true);
        try {
            if (Notification.permission === 'default' && await Notification.requestPermission() === 'granted') {
                await ensurePushNotificationSubscription(true);
            }
        } catch (err) {
            console.warn('Auto-request push permission error:', err);
        }
    };
    window.addEventListener('click', onUserInteraction, { capture: true, once: true });
    window.addEventListener('touchend', onUserInteraction, { capture: true, once: true });
}

async function ensurePushNotificationSubscription(interactive = false) {
    if (!pushSupported()) return;
    try {
        const token = await getToken();
        if (!token) return;
        let permission = Notification.permission;
        if (permission === 'default') {
            if (!interactive) return setupPwaPushAutoPrompt();
            permission = await Notification.requestPermission();
        }
        if (permission !== 'granted') return;
        const authHeader = { Authorization: `Bearer ${token}` };
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            const keyRes = await fetch(`${API}/push/vapid-public-key`, { headers: authHeader });
            if (keyRes.ok) {
                const { publicKey } = await keyRes.json();
                subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
            }
        }
        if (subscription) {
            await fetch(`${API}/push/subscribe`, {
                method: 'POST',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: navigator.userAgent, installed: true })
            }).catch(e => console.warn('Push sync error:', e));
        }
    } catch (err) {
        console.warn('Auto-subscribe push notification error:', err);
    }
}

// --- PWA install ---
// No install button (there is a native Android app; iOS never offered the prompt). Chrome's own install
// banner stays suppressed, installing via the browser menu still works.
window.addEventListener('beforeinstallprompt', e => e.preventDefault());
window.addEventListener('appinstalled', () => setupPwaPushAutoPrompt());

// --- Profile pictures ---
// Who has a picture and its version (from the server, once per load): only those are requested, under an address
// with the version that the browser keeps until the picture changes. null = not known (yet): ask like before.
let pictureVersions = null;
// Lists that render on their own (events, chats) wait for it, so they never fall back to asking for every picture
let picturesReady = Promise.resolve();
async function loadPictureVersions() {
    try {
        pictureVersions = await apiJson('/profile/pictures');
    } catch {
        pictureVersions = null;
    }
}
function profilePictureSrc(uid) {
    if (!uid) return '';
    if (pictureVersions && !pictureVersions[uid]) return '';
    const version = pictureVersions?.[uid];
    return `${API}/profile/picture/${encodeURIComponent(uid)}${version ? `?v=${version}` : ''}`;
}

async function fetchProfilePicUrl(uid) {
    const src = profilePictureSrc(uid);
    if (!src) return null;
    const res = await api(src.slice(API.length));
    if (res.ok && res.status === 200) {
        const blob = await res.blob();
        if (blob && blob.size > 0) return URL.createObjectURL(blob);
    }
    return null;
}

// Cached per uid (including in-flight requests) so list renders fetch each picture only once.
const profilePicCache = new Map();
function getProfilePicUrl(uid) {
    if (!uid) return Promise.resolve(null);
    if (!profilePicCache.has(uid)) profilePicCache.set(uid, fetchProfilePicUrl(uid).catch(() => null));
    return profilePicCache.get(uid);
}

async function loadCurrentProfilePicture() {
    const uid = currentUid();
    if (uid) applyProfilePicture(await fetchProfilePicUrl(uid).catch(() => null));
}

let profilePictureObjectUrl = null;
function applyProfilePicture(url) {
    if (profilePictureObjectUrl) URL.revokeObjectURL(profilePictureObjectUrl);
    profilePictureObjectUrl = url;
    [['admin-profile-pic-preview', 'admin-profile-pic-placeholder'], ['user-profile-pic-preview', 'user-profile-pic-placeholder'], ['header-profile-pic', 'header-profile-icon']].forEach(([imgId, placeholderId]) => {
        const img = $(imgId);
        if (img) {
            if (url) img.src = url;
            img.style.display = url ? '' : 'none';
        }
        show(placeholderId, !url);
    });
}

const toFormData = fields => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    return form;
};

// --- Image cropping (profile pictures 1:1, event covers 16:9) ---
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function rebindListener(target, type, owner, key, handler, options) {
    target.removeEventListener(type, owner[key]);
    owner[key] = handler;
    target.addEventListener(type, handler, options);
}

// Shows `src` inside the crop viewport with a draggable crop overlay and zoom (slider + wheel).
// `layout(viewportWidth, naturalW, naturalH)` returns { vw, vh, cropW, cropH, scale }.
async function initCropper({ viewport, img, overlay, zoomSlider, src, layout, fallbackSize }) {
    img.src = src;
    const loaded = await new Promise(resolve => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
    });
    if (!loaded && !fallbackSize) return null;
    const nw = img.naturalWidth || fallbackSize[0];
    const nh = img.naturalHeight || fallbackSize[1];
    const { vw, vh, cropW, cropH, scale } = layout(viewport.clientWidth, nw, nh);
    viewport.style.height = vh + 'px';
    overlay.style.width = cropW + 'px';
    overlay.style.height = cropH + 'px';

    let zoom = 1;
    let offsetX = Math.round((vw - cropW) / 2);
    let offsetY = Math.round((vh - cropH) / 2);
    const displaySize = () => [Math.round(nw * scale * zoom), Math.round(nh * scale * zoom)];
    const imagePos = () => [parseInt(img.style.left), parseInt(img.style.top)];
    const moveOverlay = (x, y) => {
        const [w, h] = displaySize();
        const [left, top] = imagePos();
        offsetX = clamp(x, left, left + w - cropW);
        offsetY = clamp(y, top, top + h - cropH);
        overlay.style.left = offsetX + 'px';
        overlay.style.top = offsetY + 'px';
    };
    const applyZoom = () => {
        const [w, h] = displaySize();
        Object.assign(img.style, { width: w + 'px', height: h + 'px', position: 'absolute', left: Math.round((vw - w) / 2) + 'px', top: Math.round((vh - h) / 2) + 'px' });
        moveOverlay(offsetX, offsetY);
    };
    const setZoom = z => {
        zoom = z;
        if (zoomSlider) zoomSlider.value = z;
        applyZoom();
    };
    applyZoom();

    let drag = null;
    const pointer = e => (e.touches ? e.touches[0] : e);
    const onDown = e => {
        e.preventDefault();
        const p = pointer(e);
        drag = { x: p.clientX, y: p.clientY, ox: offsetX, oy: offsetY };
    };
    const onMove = e => {
        if (!drag) return;
        const p = pointer(e);
        moveOverlay(drag.ox + p.clientX - drag.x, drag.oy + p.clientY - drag.y);
    };
    const onUp = () => { drag = null; };
    rebindListener(overlay, 'mousedown', overlay, '_md', onDown);
    rebindListener(overlay, 'touchstart', overlay, '_td', onDown, { passive: false });
    rebindListener(document, 'mousemove', overlay, '_mm', onMove);
    rebindListener(document, 'mouseup', overlay, '_mu', onUp);
    rebindListener(document, 'touchmove', overlay, '_tm', onMove, { passive: false });
    rebindListener(document, 'touchend', overlay, '_tu', onUp);
    if (zoomSlider) {
        zoomSlider.value = 1;
        rebindListener(zoomSlider, 'input', zoomSlider, '_zl', e => {
            zoom = parseFloat(e.target.value);
            applyZoom();
        });
    }
    rebindListener(viewport, 'wheel', viewport, '_wl', e => {
        e.preventDefault();
        setZoom(clamp(zoom + (e.deltaY > 0 ? -0.1 : 0.1), 1, 3));
    }, { passive: false });

    return {
        img, cropW, cropH, setZoom,
        // Crop origin in natural image pixels plus the display→natural scale factors
        region() {
            const [w, h] = displaySize();
            const [left, top] = imagePos();
            return { x: Math.round((offsetX - left) * nw / w), y: Math.round((offsetY - top) * nh / h), scaleX: nw / w, scaleY: nh / h };
        }
    };
}

function cropToJpeg(img, [sx, sy, sw, sh], width, height, quality) {
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

let profileCropper = null;
async function openProfileCrop(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    profileCropper = await initCropper({
        viewport: $('profileCropViewport'),
        img: $('profileCropImage'),
        overlay: $('profileCropOverlay'),
        zoomSlider: $('profileCropZoom'),
        src: await readAsDataUrl(await convertHeic(file, 0.9)),
        layout: (width, nw, nh) => {
            const vw = width || 360;
            const vh = Math.round(vw * 0.75);
            const scale = Math.min(vw / nw, vh / nh);
            const size = Math.min(Math.round(nw * scale), Math.round(nh * scale), Math.min(vw, vh) - 20);
            return { vw, vh, cropW: size, cropH: size, scale };
        }
    });
    if (profileCropper) openModal('profile-crop-modal');
}

function cancelProfileCrop() {
    profileCropper = null;
    closeModal('profile-crop-modal');
}

async function confirmProfileCrop() {
    if (!profileCropper) return;
    const { x, y, scaleX, scaleY } = profileCropper.region();
    const size = Math.round(profileCropper.cropW * Math.min(scaleX, scaleY));
    const blob = await cropToJpeg(profileCropper.img, [x, y, size, size], 256, 256, 0.85);
    if (!blob) return showToast(t('toast_image_processing_failed', 'Error processing image.'), 'error');
    setButtonLoading('btn-confirm-crop', true, t('btn_saving', 'Saving...'));
    try {
        const saved = await apiJson('/profile/picture', 'POST', toFormData({ picture: new File([blob], 'profile.jpg', { type: 'image/jpeg' }) }), t('toast_upload_failed_short', 'Upload failed'));
        closeModal('profile-crop-modal');
        showToast(t('toast_profile_pic_saved', 'Profile picture saved!'), 'success');
        // A new version: a new address, so no list shows the old picture from the browser's cache
        const uid = currentUid();
        if (pictureVersions) pictureVersions[uid] = saved?.version || Date.now();
        profilePicCache.delete(uid);
        await loadCurrentProfilePicture();
    } catch (e) {
        console.error('Profile upload error:', e);
        showToast(t('toast_upload_failed', 'Upload failed: ') + e.message, 'error');
    } finally {
        setButtonLoading('btn-confirm-crop', false, null);
    }
}

Object.assign(window, {
    switchTab, switchFinanceSubpage, toggleProfileMenu, closeProfileMenu, toggleFab, allowPushOnDevice, sendTestPush, setTheme, attemptLogin, attemptRegister, logout, changePassword, deleteOwnAccount,
    generateNewCode, copyInviteCode, setNotificationChannel, setNotificationKind, setNotificationTab, openSettingsPage, closeSettingsPage, toggleDeleteAccount, openHubApp, openMediaFolder, openMediaCrumb, loadMediaFolder, mediaBack, setMediaSort, openMediaFile, clearMediaSelection, toggleSelectAllMedia, downloadMediaSelection, deleteMediaSelection, stepMediaViewer, toggleMediaZoom, zoomMediaPdf, pickMediaFiles, uploadMediaFiles, openMediaFolderDialog, createMediaFolder, openMediaRights, setMediaRightLevel, removeMediaRightRow, openMediaRightsAdd, closeMediaRightsAdd, renderMediaRightsAdd, addMediaRightRow, saveMediaRights, openMediaRulesOverview, openMediaRuleFolder, editMediaRule, testMediaConfig, saveMediaConfig, setPollFilter, openPollDetail, votePoll, loadPolls, clearPollDurationChips, closePoll, deletePoll, openCreatePoll, addPollOption, removePollOption, setPollDuration, submitPoll, renderSongs, loadSongs, openSong, closeSong, printSong, loadPrayers, setPrayerFilter, openPrayerEditor, setPrayerDuration, updatePrayerCounter, submitPrayer, openPrayerOptions, extendPrayer, deletePrayer, openProgramSong, openPlanEntry, openPlanEntryForItem, openPlanEntryForRole, renderPlanSuggestions, choosePlanSong, clearPlanSong, keepPlanTask, setPlanWhen, setPlanPlace, setPlanMinutes, updatePlanOrder, pickPlanPerson, renderPlanWhoList, togglePlanWho, clearPlanPerson, removePlanPerson, savePlanEntry, deletePlanEntry, shareSong, toggleSongChords, transposeSong, resetSongKey, toggleSongPanel, songBodyTap, sizeSong, toggleSongScroll, cycleSongSpeed, openSongEditor, editOpenSong, previewSongEdit, saveSong, deleteSong, openProfileCrop, cancelProfileCrop, confirmProfileCrop,
    showLogin: () => showAuthForm(true),
    showRegister: () => showAuthForm(false),
    openSettingsTab: () => {
        closeProfileMenu();
        switchTab(canViewFinances() || isSuperAdminUser() ? 'settings' : 'user-settings');
    },
    openSystemSettingsTab: () => {
        closeProfileMenu();
        if (isSuperAdminUser()) switchTab('super-admin-settings');
    }
});

// --- Groups & permissions (system settings) ---
let systemGroups = [];
let systemPermissions = [];
let activeGroupFilter = null;
let currentSysSettingsTab = 'accounts';
let accountsSearchQuery = '';

const DEFAULT_PERMISSIONS = [
    { id: 'view_finances', name: 'Finance management (read only)', description: 'Allows viewing balances, history, transactions and reports without editing rights' },
    { id: 'manage_finances', name: 'Finance management (full access)', description: 'Allows recording, editing, booking and deleting payments, donations, expenses and standing orders' },
    { id: 'manage_registration_code', name: 'Manage registration code', description: 'Allows viewing, copying and regenerating the registration code for new members' },
    { id: 'access_ai', name: 'Use AI support', description: 'Allows access to and use of the built-in AI assistant' },
    { id: 'manage_mentoring', name: 'Mentoring management', description: 'Allows leaders to review, approve or reject mentor applications (no access to private chats)' },
    { id: 'manage_events', name: 'Event & duty roster management', description: 'Allows creating recurring appointments and full management of all events and duties' },
    { id: 'manage_songbook', name: 'Manage songbook', description: 'Allows adding, editing and deleting songs in the songbook' },
    { id: 'manage_prayers', name: 'Moderate prayer requests', description: 'Allows removing unsuitable prayer requests (anonymous ones stay anonymous)' },
    { id: 'manage_media', name: 'Extended media rights', description: 'Allows seeing every media folder, uploading everywhere and deciding which groups may read, write or not see a folder' }
];

// Several views ask for the groups during one refresh: they share the request that is already running
let systemGroupsRequest = null;
// maxAgeMs: reuse a list loaded that recently (the start loads it with the events and again for the views)
let systemGroupsLoadedAt = 0;
function loadSystemGroups(maxAgeMs = 0) {
    if (maxAgeMs && Date.now() - systemGroupsLoadedAt < maxAgeMs) return Promise.resolve();
    if (!systemGroupsRequest) systemGroupsRequest = fetchSystemGroups().then(() => { systemGroupsLoadedAt = Date.now(); }).finally(() => { systemGroupsRequest = null; });
    return systemGroupsRequest;
}

async function fetchSystemGroups() {
    if (!currentUser) return;
    try {
        if (isSuperAdminUser()) {
            try {
                const res = await api('/admin/permissions');
                if (res.ok) systemPermissions = await res.json();
            } catch (err) {
                console.warn('Failed to load permissions list:', err);
            }
            if (!Array.isArray(systemPermissions) || systemPermissions.length === 0) systemPermissions = DEFAULT_PERMISSIONS;
            const res = await api('/admin/groups');
            if (res.ok) {
                systemGroups = await res.json();
                renderAccountsTab();
                return;
            }
        }
        const res = await api('/groups');
        if (res.ok) systemGroups = await res.json();
    } catch (err) {
        console.error('Failed to load groups:', err);
    }
}

const groupList = () => (Array.isArray(systemGroups) ? systemGroups : []);
const findGroup = idOrName => systemGroups.find(g => g.id === idOrName || g.name === idOrName);
const checkedValues = selector => [...document.querySelectorAll(selector)].filter(cb => cb.checked).map(cb => cb.value);

function renderSystemGroups() {
    const listEl = $('nc-groups-list');
    if (!listEl) return;
    const item = (active, onclick, icon, label, count, actions = '') => `
        <div class="nc-group-item ${active ? 'active' : ''}" onclick="${onclick}">
            <div class="nc-group-item-name">
                <span>${icon}</span>
                ${label}
            </div>
            <div class="nc-group-item-actions">
                <span class="nc-group-count">${count}</span>
                ${actions}
            </div>
        </div>`;
    listEl.innerHTML = item(activeGroupFilter === null, 'window.filterByGroup(null)', '👥', `<span data-i18n="group_all_users">${t('group_all_users', 'All Users')}</span>`, Array.isArray(users) ? users.length : 0)
        + groupList().map(g => item(
            activeGroupFilter === g.id || activeGroupFilter === g.name,
            `window.filterByGroup(${jsArg(g.id)})`, '🏷️', `<span>${escapeHtml(g.name)}</span>`, g.memberCount !== undefined ? g.memberCount : 0,
            `<button type="button" class="nc-group-action-btn" title="${t('modal_manage_group_title', 'Manage Group')}" onclick="event.stopPropagation(); window.openManageGroupModal(${jsArg(g.id)});">${svgIcon('gear')}</button>`
        )).join('');
}

function filterByGroup(groupId) {
    activeGroupFilter = groupId;
    renderAccountsTab();
}

async function refreshGroupsAndUsers(refreshSelf = true) {
    await loadSystemGroups();
    await reloadUsersData();
    if (refreshSelf) await refreshCurrentUser();
}

async function submitQuickAddGroup() {
    const input = $('nc-new-group-name');
    const name = input?.value.trim();
    if (!name) return;
    try {
        await apiJson('/admin/groups', 'POST', { name, permissions: [] }, t('admin_group_create_failed', 'Failed to create the group'));
        input.value = '';
        showToast(t('toast_group_created', 'Group created successfully'), 'success');
        await refreshGroupsAndUsers(false);
    } catch (err) {
        showToast(err.message || t('admin_group_create_failed', 'Failed to create the group'), 'error');
    }
}

const checkItem = (prefix, cbClass, value, checked, name, desc) => `
    <label class="${prefix}-item">
        <input type="checkbox" class="${cbClass}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
        <div class="${prefix}-info">
            <span class="${prefix}-name">${escapeHtml(name)}</span>
            <span class="${prefix}-desc">${desc}</span>
        </div>
    </label>`;

function openGroupModal(group) {
    setValue('manage-group-id', group ? group.id : '');
    setValue('manage-group-name', group ? group.name : '');
    setText('manage-group-modal-title', group ? t('modal_manage_group_title', 'Manage Group') : t('modal_create_group_title', 'Create new group'));
    show('btn-delete-group', !!group, 'inline-block');
    const list = $('manage-group-permissions-list');
    if (list) {
        const active = group?.permissions || [];
        list.innerHTML = systemPermissions.length
            ? systemPermissions.map(p => checkItem('nc-permission', 'group-permission-cb', p.id, active.includes(p.id), t(`perm_${p.id}`, p.name), escapeHtml(t(`perm_${p.id}_desc`, p.description || '')))).join('')
            : `<div style="color: var(--text-secondary); font-size: 0.85rem;">${t('admin_no_permissions', 'No permission definitions found.')}</div>`;
    }
    openModal('manage-group-modal');
}

async function submitSaveGroup() {
    const id = inputValue('manage-group-id');
    const name = inputValue('manage-group-name').trim();
    if (!name) return showToast(t('admin_group_name_required', 'Please enter a group name.'), 'error');
    await attempt(async () => {
        const permissions = checkedValues('#manage-group-permissions-list .group-permission-cb');
        await apiJson(id ? `/admin/groups/${id}` : '/admin/groups', id ? 'PUT' : 'POST', { name, permissions }, t('admin_group_save_failed', 'Failed to save the group'));
        closeModal('manage-group-modal');
        showToast(id ? t('toast_group_updated', 'Group updated successfully') : t('toast_group_created', 'Group created successfully'), 'success');
        await refreshGroupsAndUsers();
    }, err => err.message || t('admin_group_save_failed', 'Failed to save the group'));
}

async function deleteCurrentGroup() {
    const id = inputValue('manage-group-id');
    if (!id || !confirmAction(t('confirm_delete_group', 'Are you sure you want to delete this group? It will be removed from all users.'))) return;
    await attempt(async () => {
        await apiJson(`/admin/groups/${id}`, 'DELETE', undefined, t('admin_group_delete_failed', 'Failed to delete the group'));
        if (activeGroupFilter === id) activeGroupFilter = null;
        closeModal('manage-group-modal');
        showToast(t('toast_group_deleted', 'Group deleted successfully'), 'success');
        await refreshGroupsAndUsers();
    }, err => err.message || t('admin_group_delete_failed', 'Failed to delete the group'));
}

function openAssignGroupModal(uid) {
    const user = users.find(u => u.uid === uid);
    if (!user) return;
    setValue('assign-group-uid', uid);
    setText('assign-group-user-display', `${fullName(user) || user.email || t('admin_user_fallback', 'User')} (${user.email || t('admin_no_login', 'No login')})`);
    const list = $('assign-group-checklist');
    if (!list) return;
    const userGroups = Array.isArray(user.groups) ? user.groups : [];
    list.innerHTML = groupList().length
        ? systemGroups.map(g => {
            const perms = Array.isArray(g.permissions) ? g.permissions : [];
            return checkItem('nc-group-check', 'user-group-assign-cb', g.id, userGroups.includes(g.id) || userGroups.includes(g.name), g.name, perms.length > 0 ? t('admin_group_permission_count', '{count} permissions', { count: perms.length }) : t('admin_group_default_access', 'Default access'));
        }).join('')
        : `<div style="color: var(--text-secondary); font-size: 0.85rem; padding: 10px 0;">${t('admin_no_groups', 'No groups yet. Create a group first.')}</div>`;
    openModal('assign-group-modal');
}

async function submitAssignGroups() {
    const uid = inputValue('assign-group-uid');
    if (!uid) return;
    const groups = checkedValues('#assign-group-checklist .user-group-assign-cb');
    await attempt(async () => {
        await apiJson(`/admin/users/${uid}/groups`, 'PUT', { groups }, t('admin_groups_assign_failed', 'Failed to assign the groups'));
        const localUser = users.find(u => u.uid === uid);
        if (localUser) {
            localUser.groups = groups;
            localUser.groupObjects = groups.map(gid => findGroup(gid) || { id: gid, name: gid });
        }
        closeModal('assign-group-modal');
        showToast(t('toast_user_groups_updated', 'User groups updated successfully'), 'success');
        await refreshGroupsAndUsers(currentUser?.uid === uid);
    }, err => err.message || t('admin_groups_assign_failed', 'Failed to assign the groups'));
}

async function reloadUsersData() {
    try {
        const res = await api('/admin/users');
        if (res.ok) {
            users = await res.json();
            renderAccountsTab();
        }
    } catch (err) {
        console.warn('Failed to reload users:', err);
    }
}

// --- System settings tabs & accounts table ---
const SYS_TAB_LOADERS = {
    accounts: () => {
        loadSystemGroups();
        renderAccountsTab();
    },
    config: () => { if (!advancedConfigLoaded) loadAdvancedSystemConfig(); },
    ai: () => loadAiConfig(),
    media: () => loadMediaConfig()
};

function switchSysSettingsTab(tabName) {
    currentSysSettingsTab = tabName;
    Object.keys(SYS_TAB_LOADERS).forEach(key => {
        $(`sys-subtab-btn-${key}`)?.classList.toggle('active', key === tabName);
        show(`sys-panel-${key}`, key === tabName);
    });
    SYS_TAB_LOADERS[tabName]?.();
    syncUrl();
}

function renderAccountRow(u) {
    const name = fullName(u) || t('status_unknown', 'Unknown');
    const uid = escapeHtml(u.uid);
    const isOwner = u.owner === true || u.superAdmin === true;
    const linked = findLinkedPerson(u.uid);
    const memberSince = u.memberSince || linked?.memberSince || linked?.data?.memberSince || '';
    const groups = Array.isArray(u.groupObjects) && u.groupObjects.length > 0
        ? u.groupObjects
        : (Array.isArray(u.groups) ? u.groups.map(gid => findGroup(gid) || { id: gid, name: gid, permissions: [] }) : []);
    const groupBadges = groups.length > 0
        ? groups.map(g => `<span class="nc-badge-group" style="margin: 2px;">${escapeHtml(g.name)}</span>`).join(' ')
        : `<span class="nc-badge-group" style="opacity:0.6; border-style:dashed; margin: 2px;">+ ${t('admin_assign_short', 'Assign')}</span>`;
    const pays = u.pays !== false;
    return `
        <tr data-uid="${uid}">
            <td>
                <div class="nc-user-cell">
                    <div class="nc-avatar ${getAvatarRingClass(u)}">
                        ${renderAvatarWrap(u.uid, name, { wrapClass: 'nc-avatar-inner', imgClass: 'nc-avatar-img', initialsClass: 'nc-avatar-initials' })}
                    </div>
                    <div class="nc-user-info">
                        <div class="nc-user-name">
                            <span>${escapeHtml(name)}</span>
                            ${isOwner ? `<span class="nc-badge-owner">👑 ${t('badge_owner', 'Owner')}</span>` : ''}
                            ${u.isClaimed === false ? `<span class="nc-badge-group" style="background: rgba(245, 158, 11, 0.12); color: #d97706; border-color: rgba(245, 158, 11, 0.3); font-size: 0.72rem; padding: 2px 6px;">⏳ ${t('badge_unclaimed', 'Not Registered')}</span>` : ''}
                        </div>
                    </div>
                </div>
            </td>
            <td style="color: var(--text-secondary); font-size: 0.88rem;">${u.email ? escapeHtml(u.email) : `<span style="opacity: 0.5; font-style: italic;">${t('accounts_no_login', 'No login credentials')}</span>`}</td>
            <td style="cursor: pointer;" onclick="window.openAssignGroupModal(${jsArg(uid)})" title="${t('modal_assign_group_title', 'Assign Groups')}">
                ${groupBadges}
            </td>
            <td>
                <input type="date" class="form-input" style="padding: 3px 6px; font-size: 0.82rem; height: 30px; border-radius: 8px; width: 130px; margin: 0;" value="${escapeHtml(memberSince)}" onchange="window.updateUserMemberSince(${jsArg(uid)}, this.value)">
            </td>
            <td>
                <select class="nc-select-pays" onchange="window.toggleUserPays(${jsArg(uid)}, this.value === 'yes')">
                    <option value="yes" ${pays ? 'selected' : ''}>${t('option_yes', 'Yes')}</option>
                    <option value="no" ${!pays ? 'selected' : ''}>${t('option_no', 'No')}</option>
                </select>
            </td>
            <td>
                <label class="switch" style="margin: 0;">
                    <input type="checkbox" ${u.admin ? 'checked' : ''} ${isOwner ? 'disabled' : ''} onchange="window.toggleUserSystemAdmin(${jsArg(uid)}, this.checked)">
                    <span class="slider"></span>
                </label>
            </td>
            <td>
                <div class="nc-actions-cell">
                    <button class="nc-icon-btn" title="${t('btn_reset_password', 'Reset Password')}" onclick="window.openResetPasswordModal(${jsArg(uid)}, ${jsArg(name)})">${svgIcon('lock', 15)}</button>
                    ${!isOwner && u.uid !== currentUser?.uid ? `<button class="nc-icon-btn danger" title="${t('btn_delete', 'Delete')}" onclick="window.deleteUserAccount(${jsArg(uid)})">${svgIcon('trash', 15)}</button>` : ''}
                </div>
            </td>
        </tr>`;
}

function renderAccountsTab() {
    renderSystemGroups();
    const tbody = $('accounts-table-body');
    if (!tbody || !isSuperAdminUser()) return;
    const emptyRow = text => `<tr><td colspan="7" style="text-align: center; color: var(--text-secondary); padding: 30px;">${text}</td></tr>`;
    if (!users || users.length === 0) {
        tbody.innerHTML = emptyRow(t('admin_no_users', 'No users found.'));
        return;
    }
    const activeGroup = activeGroupFilter ? findGroup(activeGroupFilter) : null;
    const rawName = u => `${u.firstName || ''} ${u.lastName || ''}`;
    const filtered = users.filter(u => {
        const groups = Array.isArray(u.groups) ? u.groups : [];
        if (activeGroupFilter && !(groups.includes(activeGroupFilter) || (activeGroup && (groups.includes(activeGroup.name) || groups.includes(activeGroup.id))))) return false;
        return !accountsSearchQuery || rawName(u).toLowerCase().includes(accountsSearchQuery) || (u.email || '').toLowerCase().includes(accountsSearchQuery);
    }).sort((a, b) => rawName(a).localeCompare(rawName(b)));

    const banner = $('nc-active-group-banner');
    if (banner && $('nc-active-group-name') && $('nc-active-group-count')) {
        banner.style.display = activeGroup ? 'flex' : 'none';
        if (activeGroup) {
            setText('nc-active-group-name', activeGroup.name);
            setText('nc-active-group-count', t('admin_group_user_count', '({count} users)', { count: filtered.length }));
        }
    }
    tbody.innerHTML = filtered.length ? filtered.map(renderAccountRow).join('') : emptyRow(t('admin_no_matching_users', 'No matching users found.'));
}

async function saveUserSetting(uid, field, payload, applyLocal, successMsg, errorMsg, logMsg) {
    if (!isSuperAdminUser()) return;
    try {
        const res = await api(`/admin/users/${uid}/${field}`, 'PUT', payload);
        if (!res.ok) throw new Error((await res.text()) || t('toast_save_failed', 'Saving failed'));
        applyLocal(users.find(u => u.uid === uid));
        renderAccountsTab();
        if (field !== 'admin') renderPeople();
        showToast(successMsg);
    } catch (err) {
        console.error(logMsg, err);
        showToast(errorMsg, 'error');
        loadData();
    }
}

const updateUserMemberSince = (uid, memberSince) => saveUserSetting(uid, 'member-since', { memberSince }, localUser => {
    if (localUser) localUser.memberSince = memberSince;
    const linked = findLinkedPerson(uid);
    if (linked) {
        linked.memberSince = linked.originalMemberSince = memberSince;
        if (linked.data) linked.data.memberSince = linked.data.originalMemberSince = memberSince;
    }
}, t('toast_member_since_updated', 'Membership date updated'), t('toast_member_since_failed', 'Membership date could not be saved'), 'Saving the membership date failed:');

const toggleUserSystemAdmin = (uid, isAdmin) => saveUserSetting(uid, 'admin', { admin: !!isAdmin }, localUser => {
    if (localUser) localUser.admin = !!isAdmin;
}, t('toast_admin_updated', 'System Admin privileges updated'), t('toast_user_rights_failed', 'Failed to save user rights'), 'Saving the admin role failed:');

const toggleUserPays = (uid, pays) => saveUserSetting(uid, 'pays', { pays: !!pays }, localUser => {
    if (localUser) localUser.pays = !!pays;
    const linked = people.find(p => p.uid === uid);
    if (linked) {
        linked.pays = !!pays;
        if (linked.data) linked.data.pays = !!pays;
    }
}, t('toast_pays_updated', 'Payment status updated'), t('toast_pays_failed', 'Fee status could not be saved'), 'Saving the fee status failed:');

function openCreateUserModal() {
    ['new-user-first-name', 'new-user-last-name', 'new-user-email', 'new-user-password'].forEach(id => setValue(id, ''));
    $('new-user-pays').checked = true;
    $('new-user-admin').checked = false;
    setValue('new-user-start', getTodayStr());
    show('new-user-member-fields', true);
    openModal('create-user-modal');
}

async function submitCreateUser() {
    const [firstName, lastName, email] = ['new-user-first-name', 'new-user-last-name', 'new-user-email'].map(id => inputValue(id).trim());
    const password = inputValue('new-user-password');
    if (!firstName || !lastName) return showToast(t('admin_user_name_required', 'Please enter first and last name.'), 'error');
    if (password && password.length < 6) return showToast(t('setup_admin_password_invalid', 'Password must be at least 6 characters long.'), 'error');
    await attempt(async () => {
        await apiJson('/admin/users', 'POST', {
            firstName, lastName, email, password,
            pays: isChecked('new-user-pays'),
            admin: isChecked('new-user-admin'),
            status: inputValue('new-user-status') || 'vollverdiener',
            memberSince: inputValue('new-user-start') || getTodayStr(),
            groups: ['Standard']
        }, t('admin_user_create_failed_short', 'Creation failed'));
        await loadData();
        closeModal('create-user-modal');
        showToast(t('toast_user_created', 'User created successfully'));
    }, err => err.message || t('admin_user_create_failed', 'Failed to create the user'));
}

function openResetPasswordModal(uid, name) {
    setValue('reset-password-uid', uid);
    setText('reset-password-user-display', name);
    setValue('reset-password-new', '');
    openModal('reset-password-modal');
}

async function submitResetPassword() {
    const password = inputValue('reset-password-new');
    if (password.length < 6) return showToast(t('setup_admin_password_invalid', 'Password must be at least 6 characters long.'), 'error');
    await attempt(async () => {
        await apiJson(`/admin/users/${inputValue('reset-password-uid')}/password`, 'PUT', { password }, t('admin_password_reset_failed_short', 'Password reset failed'));
        closeModal('reset-password-modal');
        showToast(t('toast_password_reset', 'Password changed successfully'));
    }, err => err.message || t('admin_password_reset_failed', 'Failed to reset the password'));
}

async function deleteUserAccount(uid) {
    if (!confirmAction(t('confirm_delete_user', 'Are you sure you want to delete this user account?'))) return;
    await attempt(async () => {
        await apiJson(`/admin/users/${uid}`, 'DELETE', undefined, t('toast_delete_failed_short', 'Deletion failed'));
        users = users.filter(u => u.uid !== uid);
        renderAccountsTab();
        renderUnlinkedUsers();
        showToast(t('toast_user_deleted', 'User deleted successfully'));
    }, err => err.message || t('admin_user_delete_failed', 'Failed to delete the user'));
}

// --- System, AI & branding configuration ---
async function readErrorText(res) {
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        if (data?.error) return data.error;
        if (data && Object.keys(data).length > 0) return JSON.stringify(data);
    } catch { /* not JSON */ }
    return text;
}

const SMTP_FIELDS = ['host', 'port', 'user', 'pass'];

async function loadAdvancedSystemConfig() {
    if (!isSuperAdminUser()) return;
    await attempt(async () => {
        const res = await api('/admin/system-config');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        advancedConfigAppName = data.appName || null;
        setValue('super-admin-app-name', data.appName || '');
        setValue('super-admin-public-url', data.publicUrl || '');
        setValue('super-admin-default-language', data.defaultLanguage || BASE_LANGUAGE);
        setValue('super-admin-ccli', data.ccliLicense || '');
        SMTP_FIELDS.forEach(key => setValue(`super-admin-smtp-${key}`, data.smtp?.[key] || ''));
        $('super-admin-smtp-secure').checked = !!data.smtp?.secure;
        advancedConfigLoaded = true;
        await loadAiConfig();
    }, t('toast_config_load_failed', 'Advanced configuration could not be loaded'), { toast: 'error' });
}

async function saveAdvancedSystemConfig() {
    if (!isSuperAdminUser()) return;
    await attempt(async () => {
        const appName = inputValue('super-admin-app-name').trim() || advancedConfigAppName || config.appName;
        if (!appName) throw new Error(t('admin_app_name_missing', 'The app name could not be determined. Configuration data may be missing. Please reload the page.'));
        const publicUrl = inputValue('super-admin-public-url').trim().replace(/\/+$/, '');
        if (publicUrl && !/^https?:\/\/[^\s/]+/i.test(publicUrl)) throw new Error(t('admin_public_url_invalid', 'The public address has to start with https://.'));
        const ccliLicense = inputValue('super-admin-ccli').replace(/\s+/g, '');
        if (ccliLicense && !/^\d{1,12}$/.test(ccliLicense)) throw new Error(t('admin_ccli_invalid', 'The CCLI licence number consists of digits only.'));
        const payload = { appName, publicUrl, defaultLanguage: inputValue('super-admin-default-language') || BASE_LANGUAGE, ccliLicense, smtp: null };
        const host = inputValue('super-admin-smtp-host').trim();
        if (host) {
            const port = inputValue('super-admin-smtp-port').trim();
            payload.smtp = {
                host,
                port: port ? parseInt(port, 10) : 465,
                secure: isChecked('super-admin-smtp-secure'),
                user: inputValue('super-admin-smtp-user').trim(),
                pass: inputValue('super-admin-smtp-pass')
            };
            if (!payload.smtp.port || Number.isNaN(payload.smtp.port)) throw new Error(t('admin_smtp_port_invalid', 'The SMTP port is invalid.'));
        }
        const res = await api('/admin/system-config', 'PUT', payload);
        if (!res.ok) throw new Error(await readErrorText(res));
        advancedConfigAppName = appName;
        APP_NAME = appName;
        setText('app-name-header', appName);
        setText('login-app-name', appName);
        document.title = appName;
        showToast(t('toast_config_saved', 'System configuration saved'));
    }, err => t('alert_config_save_failed', 'Could not save advanced configuration: ') + (err.message || t('error_unknown', 'Unknown error')));
}

const AI_FIELDS = { baseUrl: 'super-admin-ai-base-url', apiKey: 'super-admin-ai-api-key', model: 'super-admin-ai-model' };

async function loadAiConfig() {
    if (!isSuperAdminUser()) return;
    try {
        const res = await api('/admin/ai-config');
        if (!res.ok) return;
        const data = await res.json();
        aiEnabled = !!data.enabled;
        const enabledEl = $('super-admin-ai-enabled');
        if (enabledEl) enabledEl.checked = data.enabled;
        for (const [key, id] of Object.entries(AI_FIELDS)) setValue(id, data[key] || '');
        updateAiNavVisibility();
    } catch (err) {
        console.error('KI-Konfiguration konnte nicht geladen werden:', err);
    }
}

async function saveAiConfig() {
    if (!isSuperAdminUser()) return;
    await attempt(async () => {
        const payload = {
            enabled: $('super-admin-ai-enabled')?.checked ?? false,
            baseUrl: inputValue(AI_FIELDS.baseUrl).trim(),
            apiKey: inputValue(AI_FIELDS.apiKey),
            model: inputValue(AI_FIELDS.model).trim()
        };
        await apiJson('/admin/ai-config', 'PUT', payload);
        aiEnabled = payload.enabled;
        updateAiNavVisibility();
        showToast(t('toast_ai_saved', 'AI settings saved'));
    }, err => t('alert_ai_save_failed', 'Could not save AI settings: ') + (err.message || t('error_unknown', 'Unknown error')));
}

async function uploadChurchLogo() {
    if (!isSuperAdminUser()) return;
    const fileInput = $('super-admin-logo-file');
    if (!fileInput?.files?.length) return showToast(t('alert_please_select_svg', 'Please select an SVG file.'), 'error');
    try {
        const res = await api('/admin/logo', 'POST', toFormData({ logo: fileInput.files[0] }));
        if (!res.ok) throw new Error((await readErrorText(res)) || `HTTP ${res.status}`);
        const cacheBust = `?v=${Date.now()}`;
        document.querySelectorAll("img[src*='church-logo.svg']").forEach(img => { img.src = `assets/church-logo.svg${cacheBust}`; });
        fileInput.value = '';
        showToast(t('toast_logo_updated', 'Logo updated'));
    } catch (err) {
        const errMsg = err.message || err.code || t('error_unknown', 'Unknown error');
        console.error('Fehler beim Logo-Upload:', errMsg, err);
        showToast(t('alert_logo_update_failed', 'Logo could not be updated: ') + errMsg, 'error');
        showToast(t('toast_logo_update_failed', 'Logo could not be updated'), 'error');
    }
}

async function autoSaveRate(fieldId) {
    const el = $(fieldId);
    if (!el) return;
    const val = parseAmount(el.value);
    if (isNaN(val) || val < 0) return;
    settings[['vollverdiener', 'geringverdiener'].find(key => fieldId === 'rate-' + key) || 'keinverdiener'] = val;
    await attempt(async () => {
        await set(ref(db, 'settings'), settings);
        await renderViews();
        showToast(t('toast_settings_saved', 'Settings saved'));
    }, t('alert_settings_save_failed', 'Settings could not be saved.'), { toast: 'error' });
}

Object.assign(window, {
    filterByGroup, submitQuickAddGroup, submitSaveGroup, deleteCurrentGroup, openAssignGroupModal, submitAssignGroups, switchSysSettingsTab,
    updateUserMemberSince, toggleUserSystemAdmin, toggleUserPays, openCreateUserModal, submitCreateUser, openResetPasswordModal, submitResetPassword,
    deleteUserAccount, saveAdvancedSystemConfig, saveAiConfig, uploadChurchLogo, autoSaveRate,
    clearGroupFilter: () => filterByGroup(null),
    openManageGroupModal: groupId => {
        const group = systemGroups.find(g => g.id === groupId);
        if (group) openGroupModal(group);
    },
    openCreateGroupFromAssignModal: () => {
        closeModal('assign-group-modal');
        setTimeout(() => openGroupModal(null), 60);
    },
    filterAccountsList: () => {
        accountsSearchQuery = inputValue('accounts-search').toLowerCase().trim();
        renderAccountsTab();
    }
});

// --- Person data & standing orders ---
const sumAmounts = list => list.reduce((sum, entry) => sum + parseFloat(entry.amount || 0), 0);
const matchesPaymentId = id => (entry, i) => String(entry.id ?? `idx-${i}`) === String(id);

function preprocessPerson(person) {
    person.memberSince ||= getTodayStr();
    person.originalMemberSince ||= person.memberSince;
    person.payments = safeList(person.payments);
    person.totalPaid = sumAmounts(person.payments);
    person.statusHistory = safeList(person.statusHistory).sort((a, b) => a.startDate.localeCompare(b.startDate));
    return person;
}

const monthIndex = dateStr => {
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return parseInt(dateStr.slice(0, 4), 10) * 12 + parseInt(dateStr.slice(5, 7), 10) - 1;
    const d = new Date(dateStr);
    return d.getFullYear() * 12 + d.getMonth();
};

// Local fallback for "paid until" (the backend normally provides _paidUntil): consumes the paid credit month by
// month at the rate of the status valid in that month and returns the last day of the last fully paid month.
function calculatePaidUntil(person) {
    const start = new Date(person.originalMemberSince || person.memberSince);
    const history = safeList(person.statusHistory).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    const statusAt = month => {
        const entry = history.find(e => !e.endDate || month < monthIndex(e.endDate));
        return (entry && month >= monthIndex(entry.startDate) ? entry.status : null) || person.status;
    };
    let credit = person.totalPaid || 0;
    let month = start.getFullYear() * 12 + start.getMonth();
    for (let i = 0; credit > 0 && i < 1200; i++, month++) {
        const rate = settings[statusAt(month)] || 0;
        if (rate > credit) break;
        credit -= rate;
    }
    return new Date(Math.floor(month / 12), month % 12, 0);
}

function parseUtcDate(str) {
    if (!str) return new Date();
    if (str instanceof Date) return new Date(str.getTime());
    const [y, m, d] = String(str).trim().slice(0, 10).split('-').map(Number);
    return [y, m, d].some(isNaN) || d === undefined ? new Date(str) : new Date(Date.UTC(y, m - 1, d));
}

// Books all standing-order payments that fell due up to today (weekend dates move to Monday) and drops expired orders.
// Returns the updated person or null when nothing changed.
function checkAndExecuteStandingOrders(person) {
    if (!Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;
    const payments = safeList(person.payments);
    const existingIds = new Set(payments.map(p => p.id));
    const now = new Date();
    const limit = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const isoDay = d => d.toISOString().split('T')[0];
    const nextMonth = (date, day) => {
        const next = new Date(date);
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
        next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
        return next;
    };
    let modified = false;
    const remaining = [];
    for (const so of person.standingOrders) {
        const order = { ...so };
        const day = parseUtcDate(order.startDate).getUTCDate();
        let lastAuto = order.lastAutoPayment ? parseUtcDate(order.lastAutoPayment) : null;
        const endDate = order.endDate ? parseUtcDate(order.endDate) : null;
        endDate?.setUTCHours(23, 59, 59, 999);
        let due = lastAuto ? nextMonth(lastAuto, day) : parseUtcDate(order.startDate);
        let booked = false;
        for (let safety = 0; safety < 1200 && !(endDate && due > endDate); safety++) {
            const execution = new Date(due);
            const weekday = execution.getUTCDay();
            if (weekday === 6 || weekday === 0) execution.setUTCDate(execution.getUTCDate() + (weekday === 6 ? 2 : 1));
            if (execution > limit) break;
            const id = `auto_${order.id}_${isoDay(due)}`;
            if (!existingIds.has(id)) {
                payments.push({ id, amount: parseFloat(order.amount), date: isoDay(execution), description: (order.note || 'Dauerauftrag') + ' (Auto)', isAuto: true });
                existingIds.add(id);
                booked = true;
            }
            lastAuto = new Date(due);
            due = nextMonth(due, day);
        }
        if (booked) order.lastAutoPayment = isoDay(lastAuto);
        if (endDate && endDate < limit) {
            modified = true;
        } else {
            remaining.push(order);
            modified ||= booked;
        }
    }
    return modified ? { ...person, payments, standingOrders: remaining } : null;
}

function replacePersonInMemory(person) {
    preprocessPerson(person);
    const idx = people.findIndex(p => String(p.id) === String(person.id));
    if (idx >= 0 && person.isDeleted) people.splice(idx, 1);
    else if (idx >= 0) people[idx] = person;
    else if (!person.isDeleted) people.push(person);
}

async function mutatePerson(personId, mutator) {
    const result = await runTransaction(ref(db, 'people/' + personId), current => current
        ? mutator({ ...current, payments: safeList(current.payments), statusHistory: safeList(current.statusHistory) })
        : current);
    const updated = result.snapshot.val();
    if (updated) replacePersonInMemory(updated);
    return updated;
}

// Donations & expenses are stored as whole lists: read the latest server copy, apply `change`, write it back.
async function mutateCollection(name, change) {
    const next = change(safeList(await apiGet(name)));
    if (next) await set(ref(db, name), next);
}

function replaceById(list, id, fields) {
    const idx = list.findIndex(entry => String(entry.id) === String(id));
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...fields };
    return list;
}

function refreshFinanceViews() {
    renderPeople();
    renderStats();
    renderSuperAdminPaymentEditor();
}

function renderSuperAdminPaymentEditor() {
    if ($('finances')?.classList.contains('active')) renderHistoryTab(true);
}

// --- Admin: pending requests & unlinked accounts ---
const REQUEST_TYPES = {
    payment: { label: 'Payment', icon: 'coin' },
    status: { label: 'Status change', icon: 'history' },
    expense: { label: 'Expense', icon: 'receipt' },
    standing_order: { label: 'Standing order', icon: 'repeat' }
};
// Own request: by author, or by the own person record (decisions used to overwrite userId with the treasurer's id)
function isOwnRequest(req) {
    if (!currentUser || !req) return false;
    if (req.userId === currentUid()) return true;
    return people.some(p => p.uid === currentUid() && String(p.id) === String(req.personId));
}

// --- Open requests: a calm list like "Neue Nachrichten" (start page of treasurers and finances tab); a tap opens
// the request with all details and the decision ---
const REQUEST_COLORS = { payment: '#10b981', expense: '#ef4444', status: '#6366f1', standing_order: '#06b6d4' };
const canApproveRequests = () => canManageFinances() || isOwnerUser();
const pendingRequests = () => requests.filter(r => r.status === 'pending').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
const HOME_REQUEST_COUNT = 3;
let openRequestId = null;

// Plain text: the type comes from the request record, which its author writes
const requestTypeLabel = req => REQUEST_TYPES[req.type] ? t(`request_type_${req.type}`, REQUEST_TYPES[req.type].label) : String(req.type || '');
const requestPersonUid = req => findPerson(req.personId)?.uid || req.userId || null;

// Amount (or the new status) of a request
function requestAmount(req, statusLabels = getStatusLabels(false)) {
    const data = req.data || {};
    if (req.type === 'status') return escapeHtml(statusLabels[data.newStatus] || data.newStatus || '');
    if (req.type === 'standing_order') return `${euro(data.amount)} ${t('request_per_month', '/ month')}`;
    return euro(data.amount);
}

function requestDateLabel(req) {
    const date = req.data?.date;
    if (!date) return '';
    return (req.type === 'status' || req.type === 'standing_order')
        ? t('request_from_date', 'from {date}', { date: formatDateFast(date) })
        : t('request_on_date', 'on {date}', { date: formatDateFast(date) });
}

function requestRow(req, statusLabels) {
    const data = req.data || {};
    const name = req.personName || t('status_unknown', 'Unknown');
    const text = (req.type === 'expense' ? data.description : data.note) || requestDateLabel(req);
    return `
        <button type="button" class="home-msg-row req-row" style="--req-color: ${REQUEST_COLORS[req.type] || 'var(--primary)'};" data-id="${escapeHtml(req.id)}" onclick="window.openRequestDetail(this.dataset.id)">
            ${renderAvatarWrap(requestPersonUid(req), name, { wrapClass: 'home-msg-avatar', imgClass: 'home-msg-avatar-img', initialsClass: 'home-msg-initials' })}
            <span class="home-msg-text">
                <span class="home-msg-name-line">
                    <span class="home-msg-name">${escapeHtml(name)}</span>
                    <span class="req-row-amount">${requestAmount(req, statusLabels)}</span>
                </span>
                <span class="req-row-type"><span class="req-row-dot"></span>${escapeHtml(requestTypeLabel(req))}${data.receipt ? ` · ${svgIcon('paperclip', 11)}` : ''}</span>
                <span class="home-msg-snippet-line"><span class="home-msg-snippet">${escapeHtml(text)}</span></span>
            </span>
            ${svgIcon('chevronRight', 16, 2.5, 'class="req-row-chevron"')}
        </button>`;
}

function requestsCard(ctx, items, total) {
    const statusLabels = getStatusLabels(false);
    const more = total - items.length;
    return `
        <div class="home-msg-card req-card">
            <div class="home-msg-head">
                <span class="home-msg-icon req-card-icon">${svgIcon('fileText', 18)}</span>
                <span class="home-msg-title">${t('requests_open_title', 'Open requests')}</span>
                <span class="home-msg-total req-card-total">${formatBadgeCount(total)}</span>
                ${ctx === 'home' ? `<button type="button" class="home-msg-all" onclick="window.switchTab('finances')">${t('home_messages_all', 'All')}${svgIcon('chevronRight', 14, 2.5)}</button>` : ''}
            </div>
            <div class="home-msg-list">${items.map(req => requestRow(req, statusLabels)).join('')}</div>
            ${more > 0 ? `<button type="button" class="home-msg-more req-more" onclick="window.switchTab('finances')">${t('requests_more', '+{count} more requests', { count: more })}</button>` : ''}
        </div>`;
}

function renderAdminRequests() {
    const target = $('admin-requests-inline');
    if (!target) return;
    const pending = pendingRequests();
    target.innerHTML = pending.length ? requestsCard('fin', pending, pending.length) : '';
}

// Start page: open requests for those who decide on them (treasurers, owner)
function renderHomeFinanceRequests() {
    const target = $('home-finance-requests');
    if (!target) return;
    const pending = canApproveRequests() ? pendingRequests() : [];
    target.style.display = pending.length ? 'block' : 'none';
    target.innerHTML = pending.length ? requestsCard('home', pending.slice(0, HOME_REQUEST_COUNT), pending.length) : '';
}

// Detail popup: amount, person, dates, text, receipts and the decision
function openRequestDetail(reqId) {
    const req = requests.find(r => r.id === reqId);
    if (!req) return;
    openRequestId = reqId;
    const data = req.data || {};
    const color = REQUEST_COLORS[req.type] || 'var(--primary)';
    const type = REQUEST_TYPES[req.type] || { icon: 'file' };
    const name = req.personName || t('status_unknown', 'Unknown');
    const badge = $('reqd-badge');
    if (badge) {
        badge.style.setProperty('--req-color', color);
        badge.innerHTML = svgIcon(type.icon || 'file', 20, 2.2);
    }
    setText('reqd-title', requestTypeLabel(req));
    setText('reqd-subtitle', isOwnRequest(req) && !canApproveRequests() ? requestStateLabel(req) : name);
    const row = (icon, label, value) => value ? `
        <div class="reqd-row">
            <span class="reqd-row-icon">${svgIcon(icon, 16)}</span>
            <span class="reqd-row-label">${label}</span>
            <span class="reqd-row-value">${value}</span>
        </div>` : '';
    const text = req.type === 'expense' ? data.description : data.note;
    $('reqd-body').innerHTML = `
        <div class="reqd-hero" style="--req-color: ${color};">
            <span class="reqd-amount">${requestAmount(req)}</span>
            <span class="reqd-when">${requestDateLabel(req)}</span>
        </div>
        <div class="reqd-rows">
            ${isOwnRequest(req) && !canApproveRequests() ? '' : row('person', t('request_detail_person', 'From'), escapeHtml(name))}
            ${text ? row(req.type === 'expense' ? 'receipt' : 'fileText', req.type === 'expense' ? t('request_detail_purpose', 'Purpose') : t('request_detail_note', 'Note'), escapeHtml(text)) : ''}
            ${req.timestamp ? row('clock', t('request_detail_received', 'Received'), escapeHtml(dateTimeFormatter.format(new Date(req.timestamp)))) : ''}
            ${req.status !== 'pending' || !canApproveRequests() ? row('check', t('request_detail_status', 'Status'), `<span class="reqd-state" style="--state-color: ${(USER_REQUEST_STATES[req.status] || USER_REQUEST_STATES.pending)[0]};">${escapeHtml(requestStateLabel(req))}</span>`) : ''}
            ${req.status === 'rejected' ? row('alert', t('request_detail_reason', 'Reason'), escapeHtml(req.rejectionReason || t('user_no_reason', 'No reason given'))) : ''}
        </div>
        ${data.receipt ? `<div class="reqd-receipts" id="reqd-receipts"></div>` : ''}`;
    if (data.receipt) viewRequestReceipt(data.receipt, 'reqd-receipts');
    const canApprove = canApproveRequests() && req.status === 'pending';
    show('reqd-actions', canApprove, 'grid');
    show('reqd-reject', false, 'flex');
    setValue('reqd-reject-reason', '');
    setRequestBusy(false);
    openModal('request-detail-modal');
}

function toggleRejectForm(open) {
    show('reqd-actions', !open, 'grid');
    show('reqd-reject', open, 'flex');
    if (open) $('reqd-reject-reason')?.focus();
}

// Disables the decision buttons while it is being saved
function setRequestBusy(busy) {
    document.querySelectorAll('#request-detail-modal .reqd-footer button').forEach(btn => { btn.disabled = busy; });
}

function renderUnlinkedUsers() {
    const target = $('unlinkedUsers');
    if (!target) return;
    const linkedUids = new Set(people.filter(p => p.uid).map(p => p.uid));
    const unlinked = users.filter(u => !linkedUids.has(u.uid));
    if (unlinked.length === 0 || !canManageFinances()) {
        target.innerHTML = '';
        return;
    }
    const options = people.filter(p => !p.uid).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    target.innerHTML = `
        <div class="card" style="margin-bottom:20px;">
            <div class="card-header">${t('unlinked_title', '🧩 Unlinked Users ({count})', { count: unlinked.length })}</div>
            <div class="card-body">
                ${unlinked.map(u => `
                    <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                        <div style="flex:1; min-width:200px;">
                            <div style="font-weight:700;">${escapeHtml(u.firstName || '?')} ${escapeHtml(u.lastName || '')}</div>
                            <div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(u.email || '')}</div>
                        </div>
                        <select id="link-select-${u.uid}" class="form-select" style="flex:1; min-width:220px;">
                            <option value="">${t('unlinked_select_person', 'Select Person')}</option>
                            ${options}
                        </select>
                        <button class="btn btn-primary btn-small" style="width:auto;" data-uid="${escapeHtml(u.uid)}" onclick="assignUserToPerson(this.dataset.uid)">${t('unlinked_assign_btn', 'Assign')}</button>
                    </div>`).join('')}
            </div>
        </div>`;
}

async function assignUserToPerson(uid) {
    const select = $(`link-select-${uid}`);
    if (!select) return;
    const person = select.value && findPerson(select.value);
    if (!select.value) return showToast(t('unlinked_alert_select_person', 'Please select a person.'), 'error');
    if (!person) return showToast(t('toast_person_not_found', 'Person not found.'), 'error');
    await attempt(async () => {
        await update(ref(db, 'people/' + select.value), { uid });
        person.uid = uid;
        showToast(t('toast_assignment_saved', 'Assignment saved'));
        renderUnlinkedUsers();
        renderPeople();
    }, t('unlinked_alert_failed', 'Assignment failed. Please try again.'));
}

// --- Editing & deleting booked entries ---
function editRecordedPaymentByIndex(index) {
    if (!canManageFinances()) return;
    const tx = cachedTransactions?.[index];
    if (!tx) return console.error('editRecordedPaymentByIndex: Transaction not found at index', index);
    const type = { pay: 'payment', don: 'donation', exp: 'expense' }[tx.type] || tx.type;
    const personId = tx.personId || null;
    const paymentId = tx.paymentId || null;
    let targetIndex = tx.paymentIndex !== undefined ? tx.paymentIndex : -1;
    let payment = tx.payment || null;
    const person = type === 'payment' && findPerson(personId);
    if (person) {
        const idx = safeList(person.payments).findIndex(matchesPaymentId(paymentId));
        if (idx >= 0) targetIndex = idx;
        payment = safeList(person.payments)[targetIndex] || payment;
    }
    if (!payment) return console.error('editRecordedPayment: No payment structure resolved.', { personId, paymentId, targetIndex, type });

    currentEditedPayment = { personId, targetIndex, type, paymentId, original: payment };
    const isExpense = type === 'expense';
    setText('edit-payment-person', ({ donation: `[${t('report_type_donation', 'Donation')}] `, expense: `[${t('report_type_expense', 'Expense')}] ` }[type] || '') + (tx.personName || tx.who || t('status_unknown', 'Unknown')));
    setValue('edit-payment-amount', String(payment.amount ?? ''));
    setValue('edit-payment-date', payment.date || '');
    setValue('edit-payment-desc', payment.description || '');
    setValue('edit-payment-issuer', isExpense ? (payment.issuer || payment.name || '') : '');
    show('edit-payment-issuer-group', isExpense, 'block');
    show('edit-payment-receipts-group', isExpense, 'block');
    currentEditedReceipts = isExpense ? parseReceipts(payment.receipt) : [];
    if (isExpense) {
        setValue('edit-payment-new-receipt', '');
        renderEditReceiptsList();
    }
    openModal('edit-payment-modal');
}

async function saveEditedPayment() {
    if (!canManageFinances() || !currentEditedPayment) return;
    const amount = parseAmount(inputValue('edit-payment-amount'));
    const date = inputValue('edit-payment-date');
    const description = inputValue('edit-payment-desc').trim();
    const issuer = inputValue('edit-payment-issuer').trim();
    if (Number.isNaN(amount)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    if (!date) return showToast(t('alert_please_enter_date', 'Please specify a date.'), 'error');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showToast(t('alert_invalid_date', 'Invalid date.'), 'error');

    const saveBtn = document.querySelector('#edit-payment-modal button.btn-primary');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = t('setup_btn_saving', 'Saving...');
    }
    const opened = currentEditedPayment;
    const { type, personId, paymentId } = opened;
    try {
        if (type === 'payment') {
            await mutatePerson(personId, draft => {
                const payments = draft.payments;
                const idx = findPaymentIndex(payments, opened);
                if (idx < 0) throw new Error('The payment was changed or deleted in the meantime');
                payments[idx] = { ...payments[idx], amount, date, description };
                return { ...draft, payments, totalPaid: sumAmounts(payments) };
            });
            showToast(t('toast_payment_updated', 'Payment updated'));
        } else if (type === 'expense') {
            for (const file of $('edit-payment-new-receipt')?.files || []) {
                try {
                    currentEditedReceipts.push(await uploadReceipt(file, issuer || 'Beleg', date));
                } catch (uploadErr) {
                    console.error('Error uploading new receipt in edit:', uploadErr);
                    showToast(t('alert_upload_error_for', 'Failed to upload: ') + file.name + ' - ' + uploadErr.message, 'error');
                    throw uploadErr;
                }
            }
            const receipt = currentEditedReceipts.length > 0 ? JSON.stringify(currentEditedReceipts) : '';
            await mutateCollection('expenses', list => replaceById(list, paymentId, { amount, date, description, issuer, receipt }));
            showToast(t('toast_expense_updated', 'Expense updated'));
        } else {
            await mutateCollection('donations', list => replaceById(list, paymentId, { amount, date, description }));
            showToast(t('toast_donation_updated', 'Donation updated'));
        }
        closeModal('edit-payment-modal');
        currentEditedPayment = null;
        currentEditedReceipts = [];
        refreshFinanceViews();
    } catch (err) {
        console.error('Fehler beim Bearbeiten:', err);
        showToast(t('toast_update_failed', 'Entry could not be updated'), 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = t('btn_save', 'Save');
        }
    }
}

const fileRowInner = (preview, name, actions, nameStyle = 'color:var(--text); font-weight:600;') => `
    <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
        ${preview}
        <span style="${STYLE.fileName} ${nameStyle}">${escapeHtml(name)}</span>
    </div>
    ${actions ? `<div style="display:flex; gap:6px;">${actions}</div>` : ''}`;

let receiptsRenderToken = 0;
async function renderEditReceiptsList() {
    const listEl = $('edit-payment-receipts-list');
    if (!listEl) return;
    // A newer render (e.g. after deleting a receipt) replaces this one while it still waits for images
    const token = ++receiptsRenderToken;
    if (currentEditedReceipts.length === 0) {
        listEl.innerHTML = `<div style="color:var(--text-secondary); font-size:0.85rem;">${t('no_receipts', 'No receipts available.')}</div>`;
        return;
    }
    listEl.innerHTML = '';
    for (const filename of [...currentEditedReceipts]) {
        const item = document.createElement('div');
        item.style.cssText = STYLE.fileRow;
        item.innerHTML = fileRowInner('<div class="spinner" style="width:16px; height:16px; border-width:2px; margin:0;"></div>', filename, '', 'color:var(--text-secondary);');
        listEl.appendChild(item);
        const deleteBtn = iconButton(`deleteEditReceipt(${jsArg(filename)})`, t('btn_delete', 'Delete'));
        try {
            const imgUrl = await fetchReceiptImage(filename);
            if (token !== receiptsRenderToken) return;
            item.innerHTML = fileRowInner(`<img src="${imgUrl}" style="${STYLE.thumb}" alt="${t('receipt', 'Receipt')}">`, filename,
                `<a href="${imgUrl}" download="${escapeHtml(filename)}" class="btn btn-secondary btn-small" style="${STYLE.outlineBtn} ${STYLE.iconBtn}" title="${t('download_btn', 'Download')}">${svgIcon('download')}</a>${deleteBtn}`);
        } catch {
            if (token !== receiptsRenderToken) return;
            item.innerHTML = fileRowInner('<span style="font-size:1.25rem;">⚠️</span>', filename, deleteBtn, 'color:var(--text);');
        }
    }
}

function deleteEditReceipt(filename) {
    if (!confirmAction(t('confirm_delete_receipt', 'Are you sure you want to delete this receipt?'))) return;
    currentEditedReceipts = currentEditedReceipts.filter(fn => fn !== filename);
    renderEditReceiptsList();
}

async function confirmDeleteRecordedPayment() {
    if (!canManageFinances() || !currentEditedPayment) return;
    const opened = currentEditedPayment;
    const { type, personId, paymentId } = opened;
    closeMultipleModals(['confirm-delete-modal', 'edit-payment-modal']);
    try {
        if (type === 'payment') {
            await mutatePerson(personId, draft => {
                const idx = findPaymentIndex(draft.payments, opened);
                if (idx < 0) throw new Error('The payment was changed or deleted in the meantime');
                const payments = draft.payments.filter((entry, i) => i !== idx);
                return { ...draft, payments, totalPaid: sumAmounts(payments) };
            });
        } else {
            await mutateCollection(type === 'donation' ? 'donations' : 'expenses', list => list.filter(entry => String(entry.id) !== String(paymentId)));
        }
        showToast({ payment: t('toast_payment_deleted', 'Payment deleted'), donation: t('toast_donation_deleted', 'Donation deleted'), expense: t('toast_expense_deleted', 'Expense deleted') }[type]);
        currentEditedPayment = null;
        refreshFinanceViews();
    } catch (err) {
        console.error('Fehler beim Löschen:', err);
        showToast(t('toast_delete_failed', 'Entry could not be deleted'), 'error');
    }
}

// --- Request approval ---
const newId = () => Date.now().toString();

// Another treasurer (or the same one on another device) may have decided the request since this screen was loaded
async function requestStillPending(reqId) {
    if ((await get(ref(db, 'requests/' + reqId))).val()?.status === 'pending') return true;
    await showRequestAlreadyDecided();
    return false;
}

async function showRequestAlreadyDecided() {
    closeModal('request-detail-modal');
    await loadData();
    showToast(t('toast_request_already_decided', 'This request was already decided.'), 'error');
}

async function approveRequest(reqId = openRequestId) {
    const req = requests.find(r => r.id === reqId);
    if (!req) return;
    setRequestBusy(true);
    await attempt(async () => {
        if (!(await requestStillPending(reqId))) return;
        // Bookings carry the request's id (assets/finance.js): approving it again cannot book the money twice
        let before = null;
        if (req.type === 'expense') await mutateCollection('expenses', list => addApprovedExpense(list, req));
        else await mutatePerson(req.personId, person => {
            before = { status: person.status, statusHistory: person.statusHistory };
            return applyApprovedRequest(person, req, t('req_payment_approved_desc', 'Payment (approved)'));
        });
        try {
            await update(ref(db, 'requests/' + reqId), { status: 'approved' });
        } catch (err) {
            if (err.status !== 409) throw err;
            // Rejected by someone else between the check and now: the booking is taken back
            if (req.type === 'expense') await mutateCollection('expenses', list => withoutApprovedExpense(list, req));
            else await mutatePerson(req.personId, person => withoutApprovedRequest(person, req, before));
            return showRequestAlreadyDecided();
        }
        closeModal('request-detail-modal');
        await loadData();
        showToast(t('toast_request_approved', 'Request approved'));
    }, err => (err?.key ? t(err.key, err.message) : t('alert_approve_failed', 'Could not approve request. Please try again.')));
    setRequestBusy(false);
}

// Rejection with an optional reason typed into the popup (instead of a browser prompt)
async function confirmRejectRequest(reqId = openRequestId) {
    const reason = inputValue('reqd-reject-reason').trim();
    setRequestBusy(true);
    await attempt(async () => {
        if (!(await requestStillPending(reqId))) return;
        try {
            await update(ref(db, 'requests/' + reqId), { status: 'rejected', rejectionReason: reason || 'Kein Grund angegeben' });
        } catch (err) {
            if (err.status === 409) return showRequestAlreadyDecided();
            throw err;
        }
        closeModal('request-detail-modal');
        await loadData();
        showToast(t('toast_request_rejected', 'Request rejected'));
    }, t('alert_reject_failed', 'Could not reject request. Please try again.'));
    setRequestBusy(false);
}

// --- Member views ---
const paidUntilText = paidUntil => (paidUntil ? monthYearFormatter.format(paidUntil) : t('never_paid', 'Never'));
const personPaidUntil = p => (p._paidUntil ? new Date(p._paidUntil) : null);
const standingOrderCovers = meta => meta.isActiveStandingOrder && !meta.isOverdue;

function renderUserView() {
    renderHomeMentoringCard();
    renderHomeDutiesCard();
    renderHomeFinanceRequests();
    const statusCard = $('user-status-card');
    const financeCard = $('user-finances-status-card');
    const historyEl = $('user-payment-history');
    // The start page shows the payment state only for members with a fee (compact); the finances tab shows all
    const setCards = html => {
        if (statusCard) {
            statusCard.innerHTML = '';
            statusCard.style.display = 'none';
        }
        if (financeCard) financeCard.innerHTML = html;
    };
    const noMemberHtml = `
        <div style="text-align:center; padding: 20px; color: var(--text-secondary); background: var(--surface); border-radius: 16px; border: 1px solid var(--border);">
            ${t('user_no_member_found', 'No member record found.<br>Please contact an administrator.')}
        </div>`;

    if (currentUser && currentUser.pays === false) {
        setCards(`
            <div class="user-hero-status user-status-ok" style="border-color: var(--border);">
                <div style="font-size: 2rem; margin-bottom: 8px;">👤</div>
                <h2 style="color: var(--text); font-size: 1.25rem; font-weight: 800; margin-bottom: 5px;">
                    ${t('user_account_non_paying_title', 'User Account')}
                </h2>
                <div style="font-size: 0.95rem; color: var(--text-secondary);">
                    ${t('user_account_non_paying_desc', 'Active user account (No contribution required)')}
                </div>
            </div>`);
        if (historyEl) historyEl.innerHTML = '';
    } else if (people.length === 0) {
        setCards(noMemberHtml);
        if (historyEl) historyEl.innerHTML = `
            <div style="text-align:center; padding: 20px; color: var(--text-secondary); background: var(--surface); border-radius: 12px; border: 1px solid var(--border);">
                ${t('user_no_history', 'No entries yet')}
            </div>`;
    } else {
        const p = findLinkedPerson(currentUser?.uid);
        if (!p) return setCards(noMemberHtml);
        const meta = p._statusMeta || { text: t('status_unknown', 'Unknown'), isOverdue: false, isSoonDue: false };
        const currentStatus = p._currentStatus || p.status;
        const [statusClass, accent, rgb] = meta.isOverdue ? ['user-status-overdue', 'var(--danger)', '239,68,68']
            : meta.isSoonDue ? ['user-status-soon', 'var(--warning)', '245,158,11'] : ['user-status-ok', 'var(--success)', '16,185,129'];
        const tint = `background:rgba(${rgb},0.08); border-color:rgba(${rgb},0.25);`;
        const statusText = escapeHtml(translateStatusText(meta.text));
        const subline = style => `<div class="user-finance-hero-sub"${style}>${standingOrderCovers(meta) ? t('user_standing_order_active', 'Standing order active') : `${t('user_paid_until', 'Paid until')} <strong>${paidUntilText(personPaidUntil(p))}</strong>`}</div>`;
        const overdueBox = style => meta.isOverdue ? `
            <div class="user-finance-overdue-box"${style}>
                <div class="user-finance-overdue-label">${t('user_open_amount', 'Outstanding amount')}</div>
                <div class="user-finance-overdue-amount">${euro(p._overdueAmount || 0)}</div>
            </div>` : '';
        const requestStatus = t('user_req_status_tooltip', 'Request status change');

        if (statusCard) renderHomePaymentStatus(statusCard, p, meta, statusText);
        if (financeCard) {
            // One glance: a big symbol, the state in plain words, then fee and status as two chips
            const symbol = meta.isOverdue ? svgIcon('alert', 26, 2.4) : meta.isSoonDue ? svgIcon('clock', 26, 2.4) : svgIcon('check', 28, 2.8);
            financeCard.innerHTML = `
                <div class="user-finance-hero-card ${statusClass}" style="${tint} --hero-accent:${accent}; --hero-rgb:${rgb};">
                    <div class="user-finance-hero-top">
                        <span class="user-finance-hero-symbol" aria-hidden="true">${symbol}</span>
                        <div class="user-finance-hero-info">
                            <div class="user-finance-hero-title" style="color:${accent};">${statusText}</div>
                            ${subline('')}
                        </div>
                    </div>
                    ${overdueBox('')}
                    <div class="user-finance-chips">
                        <span class="user-finance-chip">${t('user_fee_per_month', '{amount} a month', { amount: `<strong>${euro(settings[currentStatus] || 0)}</strong>` })}</span>
                        <button type="button" class="user-finance-chip is-action" onclick="openUserRequestModal('status')" title="${requestStatus}" aria-label="${requestStatus}">
                            ${escapeHtml(getStatusLabels(false)[currentStatus] || currentStatus)}${svgIcon('chevronRight', 14, 2.5)}
                        </button>
                    </div>
                </div>`;
        }
        if (historyEl) historyEl.innerHTML = generateTimelineHTML(p);
    }
    renderUserRequests();
}

// Own requests of a member: calm rows like the treasurer list; a tap opens the request (status, reason)
const USER_REQUEST_STATES = {
    pending: ['#f59e0b', 'req_status_pending', 'Pending'],
    approved: ['#10b981', 'req_status_approved', 'Approved'],
    rejected: ['#ef4444', 'req_status_rejected', 'Rejected']
};
const requestStateLabel = req => {
    const [, key, fallback] = USER_REQUEST_STATES[req.status] || USER_REQUEST_STATES.pending;
    return t(key, fallback);
};

const MY_REQUESTS_SHOWN = 3;
let showAllMyRequests = false;
function toggleAllMyRequests() {
    showAllMyRequests = !showAllMyRequests;
    renderUserRequests();
}

function renderUserRequests() {
    const reqList = $('user-requests-list');
    if (!reqList) return;
    const mine = currentUser ? requests.filter(isOwnRequest).sort((a, b) => b.timestamp - a.timestamp) : [];
    if (mine.length === 0) {
        reqList.innerHTML = `
            <div class="my-req-empty">
                ${svgIcon('fileText', 22)}
                <span class="my-req-empty-title">${t('user_no_requests_title', 'No requests yet')}</span>
                <span class="my-req-empty-desc">${t('user_no_requests_hint', 'Above you can report a payment, submit an expense or change your status.')}</span>
            </div>`;
        return;
    }
    const statusLabels = getStatusLabels(false);
    const shown = showAllMyRequests ? mine : mine.slice(0, MY_REQUESTS_SHOWN);
    const rows = shown.map(req => {
        const data = req.data || {};
        const type = REQUEST_TYPES[req.type] || { icon: 'file' };
        const [stateColor] = USER_REQUEST_STATES[req.status] || USER_REQUEST_STATES.pending;
        // A second line only where it helps: why it was rejected, or what an expense was for
        const text = req.status === 'rejected'
            ? t('user_request_reason', 'Reason: {reason}', { reason: req.rejectionReason || t('user_no_reason', 'No reason given') })
            : (req.type === 'expense' ? data.description : '') || '';
        return `
            <button type="button" class="home-msg-row req-row my-req-row" style="--req-color: ${REQUEST_COLORS[req.type] || 'var(--primary)'}; --state-color: ${stateColor};" data-id="${escapeHtml(req.id)}" onclick="window.openRequestDetail(this.dataset.id)">
                <span class="my-req-tile">${svgIcon(type.icon || 'file', 18, 2.2)}</span>
                <span class="home-msg-text">
                    <span class="home-msg-name-line">
                        <span class="home-msg-name">${escapeHtml(requestTypeLabel(req))}</span>
                        <span class="req-row-amount">${requestAmount(req, statusLabels)}</span>
                    </span>
                    <span class="my-req-state"><span class="req-row-dot"></span>${requestStateLabel(req)}${req.timestamp ? ` · ${formatDateFast(req.timestamp)}` : ''}${data.receipt ? ` · ${svgIcon('paperclip', 11)}` : ''}</span>
                    ${text ? `<span class="home-msg-snippet-line"><span class="home-msg-snippet${req.status === 'rejected' ? ' my-req-reason' : ''}">${escapeHtml(text)}</span></span>` : ''}
                </span>
                ${svgIcon('chevronRight', 16, 2.5, 'class="req-row-chevron"')}
            </button>`;
    }).join('');
    reqList.innerHTML = `
        <div class="home-msg-card my-req-card">
            <div class="home-msg-head">
                <span class="home-msg-icon req-card-icon">${svgIcon('fileText', 18)}</span>
                <span class="home-msg-title">${t('user_requests_title', 'My Requests')}</span>
                <span class="home-msg-total my-req-total">${formatBadgeCount(mine.length)}</span>
            </div>
            <div class="home-msg-list">${rows}</div>
            ${mine.length > MY_REQUESTS_SHOWN ? `<button type="button" class="home-msg-more req-more" onclick="window.toggleAllMyRequests()">${showAllMyRequests ? t('user_requests_show_less', 'Show less') : t('user_requests_show_all', 'Show all {count}', { count: mine.length })}</button>` : ''}
        </div>`;
}

function renderPeople() {
    const list = $('peopleList');
    const payingPeople = people.filter(p => !(p.isDeleted || p.data?.isDeleted || p.pays === false || p.data?.pays === false));
    $('emptyState').style.display = payingPeople.length ? 'none' : 'block';
    if (payingPeople.length === 0) {
        list.innerHTML = '';
        return;
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    const overdue = payingPeople.filter(p => p._statusMeta?.isOverdue).sort(byName);
    const current = payingPeople.filter(p => !p._statusMeta?.isOverdue).sort(byName);
    const section = (items, color, key, fallback) => items.length
        ? `<h3 class="list-section-title" style="color:var(${color})">${t(key, fallback)} (<span class="list-section-count">${items.length}</span>)</h3>` + items.map(generatePersonHTML).join('')
        : '';
    list.innerHTML = `
        <div class="people-grid-container">
            <div class="people-column overdue-column">${section(overdue, '--danger', 'overdue_header', 'Overdue')}</div>
            <div class="people-column valid-column">${section(current, '--success', 'current_members_header', 'Current Members')}</div>
        </div>
        <p id="people-no-match" class="people-no-match" hidden>${t('people_no_match', 'No member matches your search.')}</p>`;
    filterPeopleSync();
}

function generateTimelineHTML(person) {
    const history = safeList(person.statusHistory);
    const events = history.map(h => ({ type: 'status', dateStr: h.startDate, status: h.status }));
    const currentStart = history.length > 0 ? history[history.length - 1].endDate : (person.originalMemberSince || person.memberSince);
    if (currentStart) events.push({ type: 'status', dateStr: currentStart, status: person.status });
    safeList(person.payments).forEach(p => events.push({ type: 'payment', dateStr: p.date, amount: p.amount, description: p.description }));
    if (events.length === 0) return `<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">${t('timeline_no_entries', 'No entries found.')}</div>`;

    const statusLabels = getStatusLabels(true);
    const line = (title, meta) => `
        <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div style="font-weight: 600;">${title}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">${meta}</div>
            </div>
        </div>`;
    // A payment without a date (older or imported data) goes to the end instead of breaking the whole view
    return `<div class="timeline">${events.sort((a, b) => String(b.dateStr || '').localeCompare(String(a.dateStr || ''))).map(ev => {
        const date = formatDateFast(ev.dateStr);
        return ev.type === 'status'
            ? line(`${t('timeline_status_change', 'Status Change')}: ${escapeHtml(statusLabels[ev.status] || ev.status)}`, `${t('timeline_valid_from', 'Valid from')} ${date}`)
            : line(`${t('timeline_payment', 'Payment')}: ${euro(ev.amount)}`, `${escapeHtml(ev.description) || t('timeline_no_note', 'No note')} • ${date}`);
    }).join('')}</div>`;
}

function renderStandingOrders(p) {
    const orders = safeList(p.standingOrders);
    if (orders.length === 0) return '';
    // One calm row per standing order: round symbol, amount per month, dates and note as one line, state on the right
    const rows = orders.map(so => {
        const isEnded = so.endDate && new Date(so.endDate) < new Date();
        const note = so.note?.trim();
        const facts = [
            t('so_chip_start', 'Start: {date}', { date: formatDateFast(so.startDate) }),
            so.endDate ? t('so_chip_end', 'End: {date}', { date: formatDateFast(so.endDate) }) : '',
            note && note !== 'Ohne Notiz' && note !== 'No note' ? note : ''
        ].filter(Boolean).map(escapeHtml).join(' · ');
        return `
            <div class="so-row${isEnded ? ' is-ended' : ''}">
                <span class="so-row-icon" aria-hidden="true">${svgIcon('rotate', 16, 2.2)}</span>
                <div class="so-row-text">
                    <div class="so-row-amount">${t('user_fee_per_month', '{amount} a month', { amount: `<strong>${euro(so.amount)}</strong>` })}</div>
                    <div class="so-row-facts">${facts}</div>
                </div>
                <span class="so-row-state ${isEnded ? 'ended' : 'active'}">${isEnded ? t('status_ended', 'Ended') : t('status_active', 'Active')}</span>
                ${canManageFinances() ? `
                <button type="button" class="so-row-edit" data-pid="${escapeHtml(p.id)}" data-soid="${escapeHtml(so.id)}" onclick="openEndStandingOrderModal(this.dataset.pid, this.dataset.soid)" title="${escapeHtml(t('edit_end_title', 'Edit/End'))}" aria-label="${escapeHtml(t('edit_end_title', 'Edit/End'))}">
                    ${svgIcon('edit', 15, 2)}
                </button>` : ''}
            </div>`;
    }).join('');
    return `
        <div class="so-block">
            <div class="history-header">${t('modal_standing_order', 'Standing Order')}</div>
            <div class="so-rows">${rows}</div>
        </div>`;
}

function generatePersonHTML(p) {
    const meta = p._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
    const dateText = paidUntilText(personPaidUntil(p));
    const pillClass = meta.isOverdue ? 'status-err' : meta.isSoonDue ? 'status-warn' : 'status-ok';
    const statusLabels = getStatusLabels(false);
    const currentStatus = p._currentStatus || p.status;
    const id = escapeHtml(p.id);
    // Actions like the member finance page: a tinted tile, a round symbol, a short title
    const memberAction = (handler, icon, color, label) => `
        <button type="button" class="req-action member-action" style="--req-color: ${color};" data-id="${id}" onclick="${handler}(this.dataset.id)">
            <span class="req-action-icon">${svgIcon(icon, 20, 2)}</span>
            <span class="req-action-text"><span class="req-action-title">${label}</span></span>
        </button>`;
    return `
        <div class="person-wrapper">
            <div id="person-item-${p.id}" class="person-item" role="button" tabindex="0" aria-expanded="false" data-id="${id}" onclick="toggleDetails(this.dataset.id)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); toggleDetails(this.dataset.id);}">
                <div class="person-pill">
                    ${renderAvatarWrap(p.uid || p.data?.uid, p.name, { wrapClass: 'person-avatar', imgClass: 'person-avatar-img', initialsClass: 'person-avatar-initials' })}
                    <div class="person-left">
                        <div class="person-name">${escapeHtml(p.name)}</div>
                        <span class="person-status">${escapeHtml(statusLabels[currentStatus] || currentStatus)}</span>
                    </div>
                    <div class="person-right">
                        ${standingOrderCovers(meta) ? '' : `<span class="payment-pill ${pillClass}">${dateText}</span>`}
                        <span class="time-remaining">${escapeHtml(translateStatusText(meta.text))}</span>
                    </div>
                    <span class="chevron" aria-hidden="true">›</span>
                </div>
            </div>
            <div id="drawer-${p.id}" class="person-details">
                <div class="details-content">
                    <div class="member-hero ${pillClass}">
                        <div class="member-hero-top">
                            <span class="member-hero-symbol" aria-hidden="true">${meta.isOverdue ? svgIcon('alert', 20, 2.4) : meta.isSoonDue ? svgIcon('clock', 20, 2.4) : svgIcon('check', 22, 2.8)}</span>
                            <div class="member-hero-info">
                                <div class="member-hero-title">${escapeHtml(translateStatusText(meta.text))}</div>
                                <div class="member-hero-sub">${t('paid_until', 'Paid until')} <strong>${dateText}</strong></div>
                            </div>
                        </div>
                        ${meta.isOverdue ? `
                        <div class="member-hero-overdue">
                            <span>${t('overdue_amount_label', 'Outstanding Amount')}</span>
                            <strong>${euro(p._overdueAmount || 0)}</strong>
                        </div>` : ''}
                        <div class="user-finance-chips">
                            <span class="user-finance-chip">${t('user_fee_per_month', '{amount} a month', { amount: `<strong>${euro(settings[currentStatus] || 0)}</strong>` })}</span>
                            <span class="user-finance-chip">${escapeHtml(statusLabels[p.status] || p.status)}</span>
                        </div>
                    </div>
                    ${renderStandingOrders(p)}
                    ${canManageFinances() ? `
                    <div class="member-actions-grid">
                        ${memberAction('openPaymentModal', 'coin', '#10b981', t('record_payment_btn', 'Book Payment'))}
                        ${memberAction('openChangeStatusModal', 'refresh', '#6366f1', t('status_btn', 'Status'))}
                        ${memberAction('sendStatusEmail', 'mail', '#0891b2', t('email_btn', 'Email'))}
                    </div>` : ''}
                    <div class="history-header">${t('history_label', 'History')}</div>
                    <div id="timeline-${p.id}">
                        <div style="padding:10px; color:var(--text-secondary); font-size:0.8rem; font-style:italic;">${t('loading_history', 'Loading history...')}</div>
                    </div>
                </div>
            </div>
        </div>`;
}

function toggleDetails(id) {
    const drawer = $(`drawer-${id}`);
    const header = $(`person-item-${id}`);
    const isOpen = drawer.style.maxHeight;
    document.querySelectorAll('.person-details, .person-item, .person-wrapper').forEach(el => {
        el.classList.remove('active');
        if (el.classList.contains('person-details')) el.style.maxHeight = null;
        if (el.classList.contains('person-item')) el.setAttribute('aria-expanded', 'false');
    });
    if (isOpen) return;
    // Timelines are rendered lazily on first open
    const placeholder = $(`timeline-${id}`);
    const person = findPerson(id);
    if (placeholder && !placeholder.dataset.loaded && person) {
        placeholder.innerHTML = generateTimelineHTML(person);
        placeholder.dataset.loaded = 'true';
    }
    header.classList.add('active');
    header.setAttribute('aria-expanded', 'true');
    drawer.classList.add('active');
    drawer.style.maxHeight = drawer.scrollHeight + 'px';
    header.closest('.person-wrapper')?.classList.add('active');
}

// Search: the counts in the headings follow what is shown, an empty group hides, and nothing found says so
function filterPeopleSync() {
    const term = $('people-search')?.value.toLowerCase() || '';
    let shown = 0;
    document.querySelectorAll('#peopleList .people-column').forEach(column => {
        let count = 0;
        column.querySelectorAll('.person-wrapper').forEach(item => {
            const match = item.querySelector('.person-name')?.textContent.toLowerCase().includes(term);
            item.style.display = match ? 'block' : 'none';
            if (match) count++;
        });
        const title = column.querySelector('.list-section-title');
        if (title) {
            title.hidden = count === 0;
            const counter = title.querySelector('.list-section-count');
            if (counter) counter.textContent = count;
        }
        shown += count;
    });
    const none = $('people-no-match');
    if (none) none.hidden = shown > 0 || !term;
}

async function renderStats() {
    try {
        const res = await api('/stats');
        if (!res.ok) throw new Error('Stats fetch failed');
        setText('heroAmount', currencyFormatter.format((await res.json()).totalBalance || 0));
    } catch (err) {
        console.error('Fehler beim Laden der Statistiken:', err);
    }
}

// --- Transaction history ---
let transactionPage = 1;
let cachedTransactions = null;
let transactionTotalItems = 0;
let transactionSearchQuery = '';
const TRANSACTIONS_PER_PAGE = 150;
const TX_ICONS = { pay: 'person', don: 'heart', exp: 'dollar' };
// Expenses only store the issuer's name: the account behind it, for the profile picture
function uidForName(name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    const person = people.find(p => p.uid && String(p.name || '').trim().toLowerCase() === wanted);
    if (person) return person.uid;
    const account = (users || []).find(u => String(fullName(u) || '').trim().toLowerCase() === wanted);
    return account ? (account.uid || account.id) : null;
}
const txAvatarUid = tx => (tx.type === 'pay' ? tx.personUid : tx.type === 'exp' ? uidForName(tx.who) : null) || null;
const txSign = tx => (tx.type === 'exp' ? '-' : '+');
const txColor = tx => (tx.type === 'exp' ? 'text-danger' : 'text-success');

async function renderHistoryTab(resetLimit = true) {
    if (resetLimit) {
        transactionPage = 1;
        cachedTransactions = null;
    }
    const container = $('history-page-list');
    if (!container) return;
    transactionSearchQuery = inputValue('history-search').trim();
    const search = transactionSearchQuery;
    if (resetLimit) {
        container.innerHTML = `
            <div class="trans-item" style="pointer-events: none;">
                <div style="display: flex; align-items: center; flex: 1;">
                    <div class="skeleton" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 16px; flex-shrink: 0;"></div>
                    <div class="trans-left" style="gap: 6px; flex: 1;">
                        <div class="skeleton" style="width: 140px; height: 16px;"></div>
                        <div class="skeleton" style="width: 100px; height: 12px; margin-top: 4px;"></div>
                    </div>
                </div>
                <div class="skeleton" style="width: 70px; height: 18px;"></div>
            </div>`.repeat(15);
    }
    try {
        const res = await api(`/transactions?page=${transactionPage}&perPage=${TRANSACTIONS_PER_PAGE}${search ? `&search=${encodeURIComponent(search)}` : ''}`);
        if (!res.ok) throw new Error('Failed to fetch transactions');
        const data = await res.json();
        cachedTransactions = resetLimit ? data.items : [...(cachedTransactions || []), ...data.items];
        transactionTotalItems = data.totalItems;
        if (!cachedTransactions || cachedTransactions.length === 0) {
            container.innerHTML = emptyNotice(t('no_transactions', 'No transactions found.'), 'text-align:center; padding:30px 20px; color:var(--text-secondary);');
            return;
        }
        let lastDate = null;
        let html = cachedTransactions.map((tx, index) => {
            const date = tx.date ? formatDateFast(tx.date) : t('no_date', 'No date');
            const header = date !== lastDate ? `<div style="margin: ${index === 0 ? '0' : '20px'} 0 8px 10px; font-weight: bold; font-size: 0.9rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">${date}</div>` : '';
            lastDate = date;
            const receiptBadge = tx.receipt ? `<span class="receipt-badge-inline" title="${escapeHtml(t('report_receipt_attached', 'Receipt attached'))}" style="display:inline-flex; align-items:center; vertical-align:-2px; margin-left:6px; color:var(--primary); opacity:0.85; flex-shrink: 0;">${svgIcon('paperclip', 14, 2.2)}</span>` : '';
            const desc = tx.description?.trim() ? `<span class="trans-desc">${escapeHtml(tx.description)}</span>` : '';
            const iconClass = TX_ICONS[tx.type] ? tx.type : 'exp';
            return `${header}
                <div class="trans-item" role="button" tabindex="0" data-id="${escapeHtml(tx.id)}" data-type="${escapeHtml(tx.type)}" onclick="showTransactionDetails(this.dataset.id, this.dataset.type)" onkeydown="if(event.key==='Enter'||event.key===' '){showTransactionDetails(this.dataset.id, this.dataset.type)}" style="cursor:pointer;">
                    <div style="display: flex; align-items: center; flex: 1; min-width: 0;">
                        <div class="trans-icon-wrapper ${iconClass}"${txAvatarUid(tx) ? ` data-uid="${escapeHtml(txAvatarUid(tx))}" data-name="${escapeHtml(tx.who || '')}"` : ''}${tx.type === 'exp' ? ' data-badge="exp"' : ''}>
                            ${svgIcon(TX_ICONS[iconClass], 20)}
                        </div>
                        <div class="trans-left" style="flex: 1; min-width: 0;">
                            <span style="font-weight:600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(tx.who)}</span>
                            ${desc || receiptBadge ? `<div class="trans-meta">${desc}${receiptBadge}</div>` : ''}
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; margin-left: 12px; flex-shrink: 0;">
                        <div class="trans-amount ${txColor(tx)}" style="font-size: 1.1rem;">${txSign(tx)}${euro(tx.amount)}</div>
                    </div>
                </div>`;
        }).join('');
        if (cachedTransactions.length < transactionTotalItems) {
            html += `
                <div style="text-align:center; padding:20px;">
                    <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom: 12px;">${t('showing_transactions_count', 'Showing {count} of {total} transactions.', { count: cachedTransactions.length, total: transactionTotalItems })}</div>
                    <button class="btn btn-secondary" onclick="loadMoreHistory()">${t('load_more_btn', 'Load more...')}</button>
                </div>`;
        }
        const scrollContainer = container.parentElement;
        const previousScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        container.innerHTML = html;
        container.querySelectorAll('.trans-icon-wrapper[data-uid]').forEach(wrapper => {
            getProfilePicUrl(wrapper.dataset.uid).then(url => {
                const badge = wrapper.dataset.badge === 'exp' ? `<span class="trans-type-badge">${svgIcon('dollar', 10, 2.8)}</span>` : '';
                if (!url) {
                    // Known person without a picture: initials instead of the plain icon
                    if (wrapper.dataset.name) {
                        wrapper.classList.add('avatar');
                        wrapper.innerHTML = `<span class="avatar-initials trans-initials">${escapeHtml(getInitials(wrapper.dataset.name))}</span>${badge}`;
                    }
                    return;
                }
                // Expenses keep a small red badge on the picture, so they stay recognisable at a glance
                wrapper.innerHTML = `<img src="${url}" alt="${escapeHtml(t('profile_pic_title', 'Profile Picture'))}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`
                    + badge;
                wrapper.style.background = 'transparent';
                wrapper.style.color = 'inherit';
            });
        });
        if (!resetLimit && scrollContainer) scrollContainer.scrollTop = previousScrollTop;
    } catch (err) {
        console.error('Fehler beim Laden der Transaktionen:', err);
        container.innerHTML = emptyNotice(t('error_loading_transactions', 'Error loading transactions.'), 'text-align:center; padding:30px 20px; color:var(--danger);');
    }
}

const detailRow = (label, value) => `
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-light); padding-bottom:6px;">
        <span style="color:var(--text-secondary); font-size:0.78rem; font-weight:500;">${label}</span>
        <span style="font-weight:600; color:var(--text);">${value}</span>
    </div>`;
const TX_DETAIL_BADGES = {
    pay: ['badge-person', 'color:var(--text); background:var(--surface); border:1px solid var(--border);', '💳'],
    don: ['badge-donation', '', '💚'],
    exp: ['badge-expense', '', '🧾']
};

async function showTransactionDetails(id, type) {
    const tx = cachedTransactions?.find(x => String(x.id) === String(id));
    const typeName = { exp: t('action_expense', 'Expense'), don: t('btn_add_donation', 'Donation'), pay: t('action_payment', 'Payment') }[type];
    if (!tx || !typeName) return;
    const who = type === 'don' ? tx.name || tx.who : tx.who;
    openModal('transaction-details-modal');

    const editBtn = $('details-edit-btn');
    if (editBtn) {
        editBtn.style.display = canManageFinances() ? 'inline-flex' : 'none';
        if (canManageFinances()) {
            const index = cachedTransactions.findIndex(x => String(x.id) === String(tx.id));
            editBtn.onclick = () => {
                closeModal('transaction-details-modal');
                setTimeout(() => index >= 0 ? editRecordedPaymentByIndex(index) : console.error('detailsEditBtn: Transaction index not found in cache for ID', tx.id), 50);
            };
        }
    }

    const content = $('transaction-details-content');
    const [badgeClass, badgeStyle, badgeIcon] = TX_DETAIL_BADGES[tx.type] || TX_DETAIL_BADGES.pay;
    const description = tx.description || tx.note;
    content.innerHTML = `
        <div style="background:var(--surface-alt); border:1px solid var(--border-light); border-radius:14px; padding:12px 14px; text-align:center; margin-bottom:10px; display:flex; flex-direction:column; align-items:center; gap:5px;">
            <div style="display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:18px; font-size:0.75rem; font-weight:700; ${badgeStyle}" class="${badgeClass}">
                <span>${badgeIcon}</span> ${escapeHtml(typeName)}
            </div>
            <div style="font-size:1.55rem; font-weight:800; color:var(--text); letter-spacing:-0.02em;">${euro(tx.amount)}</div>
        </div>
        <div class="modal-section-card" style="gap:8px;">
            <div class="modal-section-header">
                <span>ℹ️</span> <span>${escapeHtml(t('details_section_info', 'Transaction details'))}</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; font-size:0.86rem;">
                ${detailRow(`📅 ${escapeHtml(t('modal_date', 'Date'))}`, tx.date ? formatDateFast(tx.date) : '-')}
                ${who ? detailRow(`👤 ${escapeHtml(t('details_person', 'Person'))}`, escapeHtml(who)) : ''}
                ${tx.issuer ? detailRow(`🏛️ ${escapeHtml(t('details_issued_by', 'Issued by'))}`, escapeHtml(tx.issuer)) : ''}
                ${description ? `
                <div style="display:flex; flex-direction:column; gap:4px; padding-top:2px;">
                    <span style="color:var(--text-secondary); font-size:0.78rem; font-weight:500;">📝 ${escapeHtml(t('details_description', 'Description'))}</span>
                    <span style="font-weight:500; color:var(--text); background:var(--surface); padding:7px 10px; border-radius:8px; border:1px solid var(--border-light); word-break:break-word; white-space:pre-wrap; font-size:0.84rem;">${escapeHtml(description)}</span>
                </div>` : ''}
            </div>
        </div>
        <div id="receipt-container" style="margin-top:10px;"></div>`;

    const noReceipts = `<div style="color:var(--text-secondary); text-align:center; font-size:0.9rem;">${t('no_receipts', 'No receipts available.')}</div>`;
    if (!tx.receipt) {
        $('receipt-container').innerHTML = noReceipts;
        return;
    }
    await renderReceiptsInto($('receipt-container'), tx.receipt, {
        holder: content,
        loading: `<div class="spinner" style="margin:20px auto;"></div><div style="text-align:center">${t('loading_receipts', 'Loading receipt(s)...')}</div>`,
        header: `<div style="font-weight:600; margin-bottom:10px;">${t('details_receipts', 'Receipts')}</div>`,
        listStyle: 'display:flex; flex-direction:column; gap:15px;',
        empty: noReceipts,
        error: `<div style="color:var(--danger); text-align:center;">${t('error_loading_receipts', 'Receipt(s) could not be loaded.')}</div>`
    });
}

function viewRequestReceipt(receiptField, containerId) {
    const container = $(containerId);
    if (!container) return;
    renderReceiptsInto(container, receiptField, {
        loading: `<div class="spinner" style="margin:10px auto;"></div><div style="text-align:center; font-size:0.8rem; color:var(--text-secondary);">${t('loading_receipts', 'Loading receipt(s)...')}</div>`,
        listStyle: 'display:flex; flex-direction:column; gap:15px; margin-top:10px;',
        empty: `<div style="color:var(--text-secondary); font-size:0.8rem; margin-top:10px;">${t('no_receipts', 'No receipts available.')}</div>`,
        error: `<div style="color:var(--danger); font-size:0.8rem; margin-top:10px;">${t('error_loading_receipts', 'Receipt(s) could not be loaded.')}</div>`
    });
}

// --- Financial report & PDF export ---
let allReportTransactions = [];
const selectedManualTransactionIds = new Set();
const reportKey = (tx, idx) => String(tx.id || tx.paymentId || `tx_${idx}`);
const reportPlaceholder = (icon, text, style = '') => `
    <div class="report-placeholder-container"${style}>
        ${icon}
        <p style="font-weight: 600; margin: 0;">${text}</p>
    </div>`;

async function openExportReportModal() {
    const preview = $('report-print-preview');
    if (preview) preview.innerHTML = reportPlaceholder('<div class="spinner" style="margin: 0 auto 15px;"></div>', t('loading', 'Loading data...'));
    openModal('export-report-modal');
    try {
        allReportTransactions = [];
        for (let page = 1, totalPages = 1; page <= totalPages; page++) {
            const res = await api(`/transactions?page=${page}&perPage=500`);
            if (!res.ok) throw new Error('Failed to fetch transactions');
            const data = await res.json();
            allReportTransactions = allReportTransactions.concat(data.items || []);
            totalPages = data.totalPages || 1;
        }
        const years = new Set(allReportTransactions.map(tx => parseInt((tx.date || '').slice(0, 4), 10)).filter(y => !isNaN(y)));
        if (years.size === 0) years.add(new Date().getFullYear());
        const yearSelect = $('report-year-select');
        if (yearSelect) yearSelect.innerHTML = [...years].sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join('');

        const yearStart = `${new Date().getFullYear()}-01-01`;
        ['report-date-from', 'report-person-date-from'].forEach(id => setValue(id, yearStart));
        ['report-date-to', 'report-person-date-to'].forEach(id => setValue(id, getTodayStr()));
        const personSelect = $('report-person-select');
        if (personSelect) personSelect.innerHTML = [...people].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

        selectedManualTransactionIds.clear();
        const checklist = $('report-manual-checklist');
        if (checklist) {
            checklist.innerHTML = allReportTransactions.length === 0
                ? emptyNotice(t('no_transactions', 'No transactions found.'))
                : allReportTransactions.map((tx, idx) => {
                    const key = reportKey(tx, idx);
                    return `
                        <div class="report-checklist-item" onclick="window.toggleManualTransactionSelection(${jsArg(key)})">
                            <input type="checkbox" id="chk-report-${key}" value="${key}" onclick="event.stopPropagation(); window.toggleManualTransactionSelection(${jsArg(key)})">
                            <div class="report-checklist-info">
                                <span style="font-weight: 600;">${escapeHtml(tx.who)}</span>
                                <span class="report-checklist-meta">${tx.date ? formatDateFast(tx.date) : ''} &bull; <span class="${txColor(tx)}">${txSign(tx)}${euro(tx.amount)}</span></span>
                            </div>
                        </div>`;
                }).join('');
        }
        $('report-type-select').value = 'annual';
        onReportTypeChange();
    } catch (err) {
        console.error('Fehler beim Laden der Berichtstransaktionen:', err);
        if (preview) preview.innerHTML = reportPlaceholder('<div class="report-placeholder-icon">⚠️</div>', t('alert_error_loading_data', 'Failed to load data. Please reload the page.'), ' style="color: var(--danger);"');
    }
}

function toggleManualTransactionSelection(id) {
    const key = String(id);
    const selected = !selectedManualTransactionIds.delete(key);
    if (selected) selectedManualTransactionIds.add(key);
    const chk = $(`chk-report-${key}`);
    if (chk) chk.checked = selected;
    updateReportPreview();
}

// Report kind and detail level are picked with cards / tabs that set the (hidden) selects
function setReportType(type) {
    const select = $('report-type-select');
    if (!select) return;
    select.value = type;
    onReportTypeChange();
}

function setReportTier(tier) {
    const select = $('report-tier-select');
    if (!select) return;
    select.value = tier;
    updateReportPreview();
}

const REPORT_TIER_HINTS = {
    compact: ['report_tier_compact_hint', 'Totals and a summary by kind only'],
    standard: ['report_tier_standard_hint', 'Totals and every booking'],
    detailed: ['report_tier_detailed_hint', 'Also notes, tags and receipts']
};

function onReportTypeChange() {
    const type = inputValue('report-type-select');
    document.querySelectorAll('.report-type-card').forEach(card => card.classList.toggle('is-active', card.dataset.reportType === type));
    const viewport = document.querySelector('.report-preview-viewport');
    if (viewport) viewport.scrollTop = 0;
    const containers = { annual: 'report-year-picker-container', custom: 'report-date-range-container', manual: 'report-manual-checklist-container', person: 'report-person-selector-container' };
    for (const [key, id] of Object.entries(containers)) show(id, type === key, 'block');
    updateReportPreview();
}

const inDateRange = (tx, from, to) => {
    const d = (tx.date || '').slice(0, 10);
    return !(from && d < from) && !(to && d > to);
};

// Returns { filtered, description, person } for the selected report type.
function selectReportTransactions(type) {
    if (type === 'annual') {
        const year = String(inputValue('report-year-select'));
        return { filtered: allReportTransactions.filter(tx => (tx.date || '').slice(0, 4) === year), description: `${t('report_year_filter', 'Year:')} ${year}` };
    }
    if (type === 'custom') {
        const from = inputValue('report-date-from');
        const to = inputValue('report-date-to');
        const [fromText, toText] = [from, to].map(d => (d ? formatDateFast(d) : ''));
        return {
            filtered: allReportTransactions.filter(tx => inDateRange(tx, from, to)),
            description: fromText && toText ? `${fromText} - ${toText}` : fromText ? t('report_from_date', 'From {date}', { date: fromText }) : toText ? t('report_until_date', 'Until {date}', { date: toText }) : t('report_all_transactions', 'All transactions')
        };
    }
    if (type === 'manual') {
        return { filtered: allReportTransactions.filter((tx, idx) => selectedManualTransactionIds.has(reportKey(tx, idx))), description: t('report_manual_selection', 'Manual Selection') };
    }
    const personId = inputValue('report-person-select');
    const person = findPerson(personId);
    const name = person ? person.name : '';
    const from = inputValue('report-person-date-from');
    const to = inputValue('report-person-date-to');
    const filtered = allReportTransactions.filter(tx => {
        const matchesId = String(tx.personId) === String(personId) || (tx.personUid && person && tx.personUid === person.uid);
        const matchesName = tx.who && name && tx.who.trim().toLowerCase() === name.trim().toLowerCase();
        return (matchesId || matchesName) && inDateRange(tx, from, to);
    });
    return { filtered, person, description: `${name}${from || to ? `: ${from ? formatDateFast(from) : ''} - ${to ? formatDateFast(to) : ''}` : ''}` };
}

const REPORT_TYPE_LABELS = { pay: ['report_type_membership', 'Membership fee'], don: ['report_type_donation', 'Donation'], exp: ['report_type_expense', 'Expense'] };
const bookingsCount = count => count === 1 ? t('report_bookings_one', '1 booking') : t('report_bookings_count', '{count} bookings', { count });
// Plain colours on the PDF page: html2canvas cannot read color-mix()
const REPORT_TYPE_COLORS = {
    pay: 'color: #059669; background: #ecfdf5; border-color: #a7f3d0;',
    don: 'color: #7c3aed; background: #f5f3ff; border-color: #ddd6fe;',
    exp: 'color: #dc2626; background: #fef2f2; border-color: #fecaca;'
};

function renderReportRows(filtered, tier) {
    return filtered.map(tx => {
        const isExp = tx.type === 'exp';
        const [key, fallback] = REPORT_TYPE_LABELS[tx.type] || REPORT_TYPE_LABELS.exp;
        const partner = tx.type === 'pay' ? tx.who : tx.type === 'don' ? tx.who || t(key, fallback) : tx.description || tx.who || t(key, fallback);
        const issuer = isExp && tx.description && tx.who && tx.who !== tx.description ? tx.who : '';
        let rows = `
            <tr>
                <td class="pv-date">${tx.date ? formatDateFast(tx.date) : ''}</td>
                <td><span class="pv-type" style="${REPORT_TYPE_COLORS[tx.type] || REPORT_TYPE_COLORS.exp}">${t(key, fallback)}</span></td>
                <td class="pv-desc">${escapeHtml(partner)}${issuer ? `<span class="pv-sub">${escapeHtml(issuer)}</span>` : ''}</td>
                <td class="amount-cell ${isExp ? 'amount-expense' : 'amount-income'}">${txSign(tx)}${euro(tx.amount)}</td>
            </tr>`;
        const notes = !isExp ? (tx.description || tx.note || '') : '';
        const tags = tx.tags ? (Array.isArray(tx.tags) ? tx.tags : [tx.tags]) : [];
        if (tier === 'detailed' && (notes || tx.receipt || tags.length > 0)) {
            rows += `
                <tr class="preview-detail-row">
                    <td></td>
                    <td colspan="3">${notes ? `<div class="preview-notes">„${escapeHtml(notes)}“</div>` : ''}${tags.length ? `<div>${tags.map(tag => `<span class="preview-tags-badge">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${tx.receipt ? `
                        <div class="preview-attachment-indicator">
                            ${svgIcon('paperclip', 12, 2.5)}
                            <span>${t('report_receipt_attached', 'Receipt attached')}</span>
                        </div>` : ''}</td>
                </tr>`;
        }
        return rows;
    }).join('');
}

// Compact reports: one line per kind (count and sum) instead of every booking
function renderReportBreakdown(filtered) {
    const rows = ['pay', 'don', 'exp'].map(type => {
        const items = filtered.filter(tx => (tx.type === 'exp' ? 'exp' : tx.type) === type);
        if (!items.length) return '';
        const [key, fallback] = REPORT_TYPE_LABELS[type];
        const sum = sumAmounts(items);
        return `
            <tr>
                <td><span class="pv-type" style="${REPORT_TYPE_COLORS[type]}">${t(key, fallback)}</span></td>
                <td class="pv-count">${bookingsCount(items.length)}</td>
                <td class="amount-cell ${type === 'exp' ? 'amount-expense' : 'amount-income'}">${type === 'exp' ? '-' : '+'}${euro(sum)}</td>
            </tr>`;
    }).join('');
    return `
        <table class="preview-table preview-breakdown">
            <thead><tr><th>${t('report_table_type', 'Kind')}</th><th>${t('report_table_count', 'Count')}</th><th style="text-align: right;">${t('report_table_amount', 'Amount')}</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function updateReportPreview() {
    const type = inputValue('report-type-select');
    const tier = inputValue('report-tier-select');
    document.querySelectorAll('.report-tier-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.reportTier === tier));
    const [hintKey, hintFallback] = REPORT_TIER_HINTS[tier] || REPORT_TIER_HINTS.standard;
    setText('report-tier-hint', t(hintKey, hintFallback));
    const preview = $('report-print-preview');
    if (!preview) return;
    const { filtered, description, person } = selectReportTransactions(type);
    filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const income = sumAmounts(filtered.filter(tx => tx.type !== 'exp'));
    const expenses = sumAmounts(filtered.filter(tx => tx.type === 'exp'));
    const net = income - expenses;
    setText('report-footer-summary', filtered.length
        ? `${bookingsCount(filtered.length)} · ${t('report_balance', 'Balance')} ${net >= 0 ? '+' : ''}${euro(net)}`
        : '');
    $('btn-download-pdf')?.toggleAttribute('disabled', filtered.length === 0);
    if (filtered.length === 0) {
        preview.innerHTML = reportPlaceholder(`<div class="report-placeholder-icon">${svgIcon('fileText', 40, 1.6)}</div>`, type === 'manual'
            ? t('report_pick_bookings', 'Tick the bookings on the left that should go into the report.')
            : t('report_no_data', 'No data found for the selected period'));
        requestAnimationFrame(resizeReportPreview);
        return;
    }
    const countOf = list => bookingsCount(list.length);
    const statCard = (label, cls, value, note) => `
        <div class="preview-stat-card ${cls}">
            <div class="preview-stat-label">${label}</div>
            <div class="preview-stat-value ${cls}">${value}</div>
            ${note ? `<div class="preview-stat-note">${note}</div>` : ''}
        </div>`;
    const overdue = person?._overdueAmount || 0;
    const thirdCard = type !== 'person' ? statCard(t('report_balance', 'Balance'), `balance ${net >= 0 ? 'income' : 'expense'}`, `${net >= 0 ? '+' : ''}${euro(net)}`, countOf(filtered))
        : overdue > 0 ? statCard(t('report_outstanding_till_today', 'Outstanding (to date)'), 'expense', euro(overdue))
        : statCard(t('status_label', 'Status'), 'income is-text', t('report_status_good', 'No arrears'));
    const kindTitle = { annual: t('report_kind_annual', 'Annual overview'), custom: t('report_kind_custom', 'Overview for a period'),
        manual: t('report_kind_manual', 'Selected bookings'), person: t('report_kind_person', 'Overview for one member') }[type] || '';
    preview.innerHTML = `
        <div class="pv-band"></div>
        <div class="preview-header">
            <div class="preview-logo">
                <img class="pv-logo-img" src="assets/church-logo.svg" alt="" onerror="this.remove()">
                <span>${escapeHtml(APP_NAME)}</span>
            </div>
            <div class="preview-meta">
                <div class="pv-meta-label">${t('report_created_on', 'Created on')}</div>
                <div class="pv-meta-value">${formatDateFast(getTodayStr())}</div>
            </div>
        </div>
        <div class="preview-title-block">
            <div class="pv-kicker">${kindTitle}</div>
            <h2>${t('report_financial_report', 'Financial Report')}</h2>
            <div class="pv-period">${escapeHtml(description)}</div>
        </div>
        <div class="preview-stats-grid">
            ${statCard(t('nav_income', 'Income'), 'income', `+${euro(income)}`, countOf(filtered.filter(tx => tx.type !== 'exp')))}
            ${statCard(t('nav_expenses', 'Expenses'), 'expense', `-${euro(expenses)}`, countOf(filtered.filter(tx => tx.type === 'exp')))}
            ${thirdCard}
        </div>
        <div class="pv-section-title">${tier === 'compact' ? t('report_by_kind', 'By kind') : t('report_bookings', 'Bookings')}</div>
        ${tier === 'compact' ? renderReportBreakdown(filtered) : `
        <table class="preview-table">
            <thead><tr><th>${t('report_table_date', 'Date')}</th><th>${t('report_table_type', 'Kind')}</th><th>${t('report_table_desc', 'Description / Partner')}</th><th style="text-align: right;">${t('report_table_amount', 'Amount')}</th></tr></thead>
            <tbody>${renderReportRows(filtered, tier)}</tbody>
            <tfoot><tr><td colspan="3">${t('report_balance', 'Balance')}</td><td class="amount-cell ${net >= 0 ? 'amount-income' : 'amount-expense'}">${net >= 0 ? '+' : ''}${euro(net)}</td></tr></tfoot>
        </table>`}
        <div class="pv-footer">
            <span>${escapeHtml(APP_NAME)} · ${t('report_financial_report', 'Financial Report')}</span>
            <span>${escapeHtml(description)}</span>
        </div>`;
    requestAnimationFrame(resizeReportPreview);
}

async function downloadReportPdf() {
    const element = $('report-print-preview');
    if (!element) return;
    setButtonLoading('btn-download-pdf', true, t('report_generating', 'Generating...'));
    await loadScriptOnce(HTML2PDF_SRC).catch(() => {});
    if (typeof html2pdf === 'undefined') {
        setButtonLoading('btn-download-pdf', false, null);
        return showToast(t('report_pdf_lib_error', 'PDF library failed to load.'), 'error');
    }
    // Render an unscaled off-screen A4-width clone to avoid a blank first page
    const printContainer = document.createElement('div');
    printContainer.style.cssText = 'position: absolute; left: 0; top: 0; width: 794px; pointer-events: none; z-index: -9999; background: #ffffff;';
    const clone = element.cloneNode(true);
    clone.style.cssText += 'transform: none; min-height: auto; width: 794px; margin: 0; box-sizing: border-box; background: #ffffff;';
    printContainer.appendChild(clone);
    document.body.appendChild(printContainer);
    const done = () => {
        setButtonLoading('btn-download-pdf', false);
        printContainer.remove();
    };
    html2pdf().set({
        margin: 0,
        filename: `${APP_NAME.replace(/[^a-zA-Z0-9]/g, '_')}_${t('report_file_name', 'Financial_Report')}_${getTodayStr()}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false, scrollY: 0, scrollX: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.preview-stat-card', '.preview-header', '.preview-title-block', '.pv-footer', 'tr'] }
    }).from(clone).save().then(done).catch(err => {
        console.error('PDF generation failed:', err);
        done();
        showToast(t('report_pdf_error', 'Failed to generate PDF.'), 'error');
    });
}

function resizeReportPreview() {
    const viewport = document.querySelector('.report-preview-viewport');
    const canvas = $('report-print-preview');
    if (!viewport || !document.querySelector('.report-preview-scale-container') || !canvas) return;
    viewport.style.setProperty('--preview-scale', Math.min(1, (viewport.clientWidth - 40) / 794));
    viewport.style.setProperty('--preview-height', `${canvas.offsetHeight || 1120}px`);
}

window.addEventListener('resize', debounce(() => {
    if ($('export-report-modal')?.classList.contains('show')) resizeReportPreview();
}, 100));

// --- Booking payments, donations & expenses ---
function openPaymentModal(id) {
    if (!canManageFinances()) return;
    currentPersonId = id;
    openModal('add-payment-modal');
}

// "Dauerauftrag" switches the date label to the start date
function updatePaymentDateLabel() {
    setText('payment-date-label', isChecked('payment-is-standing-order') ? t('modal_date_start', 'Start Date') : t('modal_date', 'Date'));
}

async function addPayment() {
    if (!validateRequired(['payment-amount', 'payment-date'])) return;
    setButtonLoading('btn-add-payment', true, t('btn_booking', 'Booking...'));
    const amount = parseAmount(inputValue('payment-amount'));
    const date = inputValue('payment-date');
    const note = inputValue('payment-desc');
    const isStandingOrder = isChecked('payment-is-standing-order');
    try {
        if (!currentPersonId) return;
        if (isNaN(amount)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
        const updated = await mutatePerson(currentPersonId, person => isStandingOrder
            ? { ...person, standingOrders: [...safeList(person.standingOrders), { id: newId(), amount, startDate: date, note, lastAutoPayment: null }] }
            : { ...person, payments: [...person.payments, { amount, date, description: note, id: Date.now() }], totalPaid: (person.totalPaid || 0) + amount });
        if (!updated) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
        closeModal('add-payment-modal');
        if (currentUser && !currentUser.admin) renderUserView();
        else refreshFinanceViews();
        $('payment-is-standing-order').checked = false;
        setText('payment-date-label', t('modal_date', 'Date'));
        showToast(t('toast_payment_booked', 'Payment booked'));
    } catch (err) {
        console.error('Fehler beim Speichern der Zahlung:', err);
        showToast(t('alert_save_payment_failed', 'Payment could not be saved. Please try again.'), 'error');
    } finally {
        setButtonLoading('btn-add-payment', false);
    }
}

async function addDonation() {
    if (!validateRequired(['donation-amount', 'donation-date', 'donation-name'])) return;
    const amount = parseAmount(inputValue('donation-amount'));
    if (isNaN(amount)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    setButtonLoading('btn-add-donation', true, t('setup_btn_saving', 'Saving...'));
    try {
        const donation = { amount, name: inputValue('donation-name'), date: inputValue('donation-date'), description: inputValue('donation-desc').trim(), id: Date.now() };
        await mutateCollection('donations', list => [...list, donation]);
        closeModal('add-donation-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        ['donation-amount', 'donation-name', 'donation-date', 'donation-desc'].forEach(id => setValue(id, ''));
        showToast(t('toast_donation_saved', 'Donation saved'));
    } catch (err) {
        console.error('Fehler beim Speichern der Spende:', err);
        showToast(t('alert_save_donation_failed', 'Donation could not be saved. Please try again.'), 'error');
    } finally {
        setButtonLoading('btn-add-donation', false);
    }
}

async function addExpense() {
    if (!validateRequired(['expense-amount', 'expense-date', 'expense-issuer', 'expense-desc'])) return;
    const amount = parseAmount(inputValue('expense-amount'));
    if (isNaN(amount)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    const [issuer, date, description] = ['expense-issuer', 'expense-date', 'expense-desc'].map(inputValue);
    setButtonLoading('btn-add-expense', true, t('setup_btn_saving', 'Saving...'));
    try {
        let receipt = null;
        if (pendingUploads.expense.files.length > 0) {
            setButtonLoading('btn-add-expense', true, t('btn_uploading', 'Uploading...'));
            try {
                receipt = await uploadAll(pendingUploads.expense.files, issuer, date);
            } catch (err) {
                console.error(err);
                return showToast(t('alert_receipt_upload_error', 'Failed to upload receipt: ') + err.message, 'error');
            }
        }
        await mutateCollection('expenses', list => [...list, { amount, issuer, description, date, id: Date.now(), receipt }]);
        closeModal('add-expense-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        ['expense-amount', 'expense-issuer', 'expense-desc', 'expense-receipt'].forEach(id => setValue(id, ''));
        resetPendingFiles('expense');
        showToast(t('toast_expense_saved', 'Expense saved'));
    } catch (err) {
        console.error('Fehler beim Speichern der Ausgabe:', err);
        showToast(t('alert_save_expense_failed', 'Expense could not be saved. Please try again.'), 'error');
    } finally {
        setButtonLoading('btn-add-expense', false);
    }
}

// --- Standing orders ---
let editingSoId = null;
let editingPersonId = null;

function openEndStandingOrderModal(personId, soId) {
    if (!canManageFinances()) return;
    editingPersonId = personId;
    editingSoId = soId;
    const person = findPerson(personId);
    if (person) setValue('end-so-date', safeList(person.standingOrders).find(s => String(s.id) === String(soId))?.endDate || getTodayStr());
    openModal('end-standing-order-modal');
}

async function saveStandingOrderEnd() {
    if (!editingPersonId || !editingSoId) return;
    const endDate = inputValue('end-so-date');
    if (!endDate) return showToast(t('alert_please_choose_date', 'Please choose a date.'), 'error');
    const isThisOrder = so => String(so.id) === String(editingSoId);
    try {
        await mutatePerson(editingPersonId, person => {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            // Drop auto-payments booked after the new end date; remove the order entirely once it has ended
            const payments = person.payments.filter(p => !(p.isAuto && p.id.startsWith(`auto_${editingSoId}_`) && new Date(p.date) > end));
            const standingOrders = safeList(person.standingOrders)
                .map(so => (isThisOrder(so) ? { ...so, endDate } : so))
                .filter(so => !(end < new Date() && isThisOrder(so)));
            return { ...person, standingOrders, payments, totalPaid: sumAmounts(payments) };
        });
        await renderViews();
        closeModal('end-standing-order-modal');
        showToast(t('toast_so_updated', 'Standing order updated'));
    } catch (err) {
        console.error('Fehler beim Beenden:', err);
        showToast(t('alert_save_error', 'Error while saving.'), 'error');
    }
}

async function deleteStandingOrderCompletely() {
    if (!confirmAction(t('confirm_delete_so', 'Are you sure you want to remove this standing order completely? History will be lost.'))) return;
    await attempt(async () => {
        await mutatePerson(editingPersonId, person => ({ ...person, standingOrders: safeList(person.standingOrders).filter(so => String(so.id) !== String(editingSoId)) }));
        await renderViews();
        closeModal('end-standing-order-modal');
        showToast(t('toast_so_deleted', 'Standing order deleted'));
    }, t('alert_delete_error', 'Error while deleting.'));
}

// --- Member status changes & status e-mail (applyStatusChangeToHistory: assets/finance.js) ---
function openChangeStatusModal(id) {
    if (!canManageFinances()) return;
    currentPersonId = id;
    const person = findPerson(id);
    if (person) setValue('change-status-select', person.status || 'vollverdiener');
    setValue('change-status-date', getTodayStr());
    openModal('change-status-modal');
}

async function saveStatusChange() {
    if (!currentPersonId) return;
    const changeDate = inputValue('change-status-date');
    if (!changeDate) return showToast(t('alert_please_enter_date', 'Please specify a date.'), 'error');
    try {
        const updated = await mutatePerson(currentPersonId, person => applyStatusChangeToHistory(person, inputValue('change-status-select'), changeDate));
        if (!updated) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
        await renderViews();
        closeModal('change-status-modal');
        showToast(t('toast_status_changed', 'Status changed'));
    } catch (err) {
        console.error('Fehler bei der Statusänderung:', err);
        showToast(t('alert_status_change_failed', 'Status change failed: ') + (err.key ? t(err.key, err.message) : err.message), 'error');
    }
}

async function sendStatusEmail(personId) {
    if (!canManageFinances()) return;
    const person = findPerson(personId);
    if (!person) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
    const email = person.uid && users.find(u => u.uid === person.uid)?.email;
    if (!email) return showToast(t('toast_no_email', 'No email address found for this person'), 'error');

    const meta = person._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
    const readableStatus = getStatusLabels(false)[person._currentStatus || person.status] || person._currentStatus || person.status;
    const paidUntil = person._paidUntil ? new Date(person._paidUntil) : calculatePaidUntil(person);
    const paidUntilLabel = paidUntil ? monthYearFormatter.format(paidUntil) : t('never_paid', 'Never');
    const today = new Date();
    const overdueMonths = paidUntil ? Math.max(0, (today.getFullYear() * 12 + today.getMonth()) - (paidUntil.getFullYear() * 12 + paidUntil.getMonth())) : 0;
    const monthStr = overdueMonths === 1 ? t('email_status_one_month', 'one month') : t('email_status_n_months', '{count} months', { count: overdueMonths });
    const openAmount = euro(person._overdueAmount || 0);
    const box = (color, border, inner) => `<div style="background-color: ${color}; border-left: 4px solid ${border}; padding: 15px; border-radius: 8px; margin-bottom: 25px;">${inner}</div>`;
    const okParagraph = text => `<p style="margin: 0; color: #15803D; font-size: 16px; font-weight: 600;">${text}</p>`;
    let customMessage;
    let customHtml;
    if (meta.isActiveStandingOrder) {
        customMessage = t('email_status_standing_order', 'Your standing order is active – so there is nothing else you need to do!');
        customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
    } else if (meta.isOverdue) {
        const overdueText = months => t('email_status_overdue', 'This means your fee is currently overdue for {months}.', { months });
        const amountText = t('email_status_open_amount', 'The total outstanding amount is {amount}.', { amount: openAmount });
        customMessage = `${overdueText(monthStr)}\n${amountText}`;
        customHtml = box('#FEF2F2', '#EF4444', `<p style="margin: 0 0 5px 0; color: #B91C1C; font-size: 16px;">${overdueText(`<strong>${escapeHtml(monthStr)}</strong>`)}</p><p style="margin: 0; color: #B91C1C; font-size: 16px; font-weight: 600;">${escapeHtml(amountText)}</p>`);
    } else {
        customMessage = t('email_status_ok', 'Your fee account is fully settled. Thank you very much!');
        customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
    }
    const paragraph = (margin, content, extra = ' line-height: 1.5;') => `<p style="margin: ${margin}; font-size: 16px;${extra}">${content}</p>`;
    const mail = {
        greeting: name => t('email_status_greeting', 'Hello {name},', { name }),
        intro: t('email_status_intro', 'here is a short update on the current status of your membership fees.'),
        tier: status => t('email_status_tier', 'Your fee category is currently set to {status}.', { status }),
        paidUntil: date => t('email_status_paid_until', 'According to our records, you have paid your fees up to and including {date}.', { date }),
        questions: t('email_status_questions', 'If you have any questions, feel free to get in touch at any time.'),
        regards: t('email_status_regards', 'Kind regards,'),
        signature: app => t('email_status_signature', 'Your {app} team', { app })
    };
    const text = `${mail.greeting(person.name)}\n\n${mail.intro}\n\n${mail.tier(`'${readableStatus}'`)}\n${mail.paidUntil(paidUntilLabel)}\n\n${customMessage}\n\n${mail.questions}\n\n${mail.regards}\n${mail.signature(APP_NAME)}`;
    const html = `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
                    <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(APP_NAME)}</h1>
                </div>
                <div style="padding: 40px 30px;">
                    <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; color: #1A202C;">${mail.greeting(escapeHtml(person.name))}</h2>
                    ${paragraph('0 0 15px 0', escapeHtml(mail.intro))}
                    ${paragraph('0 0 15px 0', mail.tier(`<strong style="color: #14B8A6;">${escapeHtml(readableStatus)}</strong>`))}
                    ${paragraph('0 0 25px 0', mail.paidUntil(`<strong style="color: #4A5568;">${escapeHtml(paidUntilLabel)}</strong>`))}
                    ${customHtml}
                    ${paragraph('0 0 5px 0', escapeHtml(mail.questions), ' color: #4A5568;')}
                    <br>
                    ${paragraph('0 0 5px 0', escapeHtml(mail.regards), ' color: #4A5568;')}
                    ${paragraph('0', mail.signature(escapeHtml(APP_NAME)), ' font-weight: 600; color: #2D3748;')}
                </div>
            </div>
        </div>`;
    await attempt(async () => {
        const res = await api('/send-email', 'POST', { to: email, subject: t('email_status_subject', 'Your membership fee status - {app}', { app: APP_NAME }), text, html });
        if (res.ok) {
            showToast(t('toast_email_sent', 'Status email sent'));
        } else {
            showToast(t('toast_email_failed', 'Failed to send email'), 'error');
            console.error('Email API response not ok:', await res.text());
        }
    }, t('toast_email_failed', 'Failed to send email'), { toast: 'error' });
}

// --- Member requests (payment, status change, expense) ---
let currentRequestType = null;
const modalSection = (icon, title, body) => `
    <div class="modal-section-card">
        <div class="modal-section-header">
            <span>${icon}</span> <span>${title}</span>
        </div>
        ${body}
    </div>`;
const amountField = () => `
    <div class="form-group">
        <div class="hero-amount-wrapper">
            <span class="hero-amount-prefix">€</span>
            <input type="text" inputmode="decimal" id="req-amount" class="form-input hero-amount-input" placeholder="${t('amount_placeholder', '0.00')}">
        </div>
    </div>`;
const requestDateInput = () => `<input type="date" id="req-date" class="form-input" value="${getTodayStr()}">`;

const REQUEST_FORMS = {
    payment: {
        badge: ['badge-donation', '💳'],
        title: () => [t('user_req_payment_title', 'Report payment'), t('user_req_payment_subtitle', 'Report a fee payment or deposit to the admin')],
        body: () => modalSection('💶', t('req_section_payment_amount', 'Payment amount'), amountField())
            + modalSection('⚙️', t('modal_section_payment_type', 'Payment type & date'), `
                <div class="modal-switch-row">
                    <label class="switch">
                        <input type="checkbox" id="req-is-standing-order" onchange="document.getElementById('req-date-label').innerText = this.checked ? ${jsArg(t('modal_date_start', 'Start Date'))} : ${jsArg(t('modal_date', 'Date'))}">
                        <span class="slider"></span>
                    </label>
                    <label for="req-is-standing-order" class="modal-switch-label">${t('modal_standing_order', 'Standing Order')}</label>
                </div>
                <div class="form-group">
                    <label class="form-label" id="req-date-label" for="req-date">${t('modal_date', 'Date')}</label>
                    ${requestDateInput()}
                </div>`)
            + modalSection('📝', t('req_section_note', 'Note / Reference'), `
                <div class="form-group">
                    <input type="text" id="req-note" class="form-input" placeholder="${t('modal_note_placeholder', 'e.g. May fee')}">
                </div>`)
    },
    status: {
        badge: ['badge-person', '⚡'],
        title: () => [t('user_req_status_title', 'Request status change'), t('user_req_status_subtitle', 'Request a new membership status')],
        body: () => {
            const myPerson = people.length > 0 ? findLinkedPerson(currentUser?.uid) : null;
            const current = myPerson?._currentStatus || myPerson?.status;
            const labels = getStatusLabels(true);
            return modalSection('💼', t('modal_new_status', 'New Status'), `
                <div class="form-group">
                    <select id="req-status" class="form-select">
                        ${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>`)
                + modalSection('📅', t('modal_valid_from', 'Valid From'), `
                <div class="form-group">
                    ${requestDateInput()}
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:5px; line-height:1.35;">
                        ${t('modal_status_desc', '<strong>Retroactive:</strong> Corrects calculations starting from the specified date.<br><strong>Future:</strong> The new status applies from the specified date (previous calculations remain).')}
                    </div>
                </div>`);
        }
    },
    expense: {
        badge: ['badge-expense', '🧾'],
        title: () => [t('user_req_expense_title', 'Report expense'), t('user_req_expense_subtitle', 'Submit expense for reimbursement')],
        body: () => modalSection('💶', t('modal_section_amount', 'Expense amount'), amountField())
            + modalSection('ℹ️', t('modal_section_info', 'Expense details'), `
                <div class="form-group">
                    <label class="form-label" for="req-desc">${t('req_desc_label', 'Description')}</label>
                    <input type="text" id="req-desc" class="form-input" placeholder="${t('modal_expense_what_placeholder', 'What for?')}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="req-date">${t('modal_date', 'Date')}</label>
                    ${requestDateInput()}
                </div>`)
            + modalSection('📎', t('modal_expense_receipt', 'Receipt'), `
                <div class="file-upload-dropzone">
                    <div class="file-upload-icon">📁</div>
                    <div class="file-upload-text">${t('modal_expense_receipt_text', 'Select a receipt or drag it here')}</div>
                    <div class="file-upload-subtext">JPG, PNG, HEIC, PDF</div>
                    <input type="file" id="req-receipt" accept="image/*,.heic,.heif,.pdf" multiple onchange="window.handleReqReceiptFiles(this.files)">
                </div>
                <div id="req-receipt-preview-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;"></div>`)
    }
};
const REQUEST_CHOICES = [
    ['payment', 'rgba(6, 182, 212, 0.12)', 'var(--primary)', '💳', 'user_req_type_payment', 'Payment / Deposit', 'user_req_type_payment_desc', 'Report a fee payment or deposit.'],
    ['status', 'rgba(245, 158, 11, 0.12)', '#f59e0b', '⚡', 'user_req_type_status', 'Status Change', 'user_req_type_status_desc', 'Request a membership status change.'],
    ['expense', 'rgba(239, 68, 68, 0.12)', 'var(--danger)', '🧾', 'user_req_type_expense', 'Expense', 'user_req_type_expense_desc', 'Submit expense for reimbursement (with receipt).']
];

function openUserRequestModal(type) {
    currentRequestType = type || null;
    resetPendingFiles('req');
    const form = REQUEST_FORMS[type];
    const badge = $('req-modal-badge');
    const [badgeClass, badgeIcon] = form ? form.badge : ['badge-donation', '📝'];
    if (badge) {
        badge.className = `modal-icon-badge ${badgeClass}`;
        badge.textContent = badgeIcon;
    }
    const [title, subtitle] = form ? form.title() : [t('user_request_modal_title', 'Request'), t('user_req_select_subtitle', 'Select request type')];
    if ($('req-modal-title')) $('req-modal-title').innerText = title;
    if ($('req-modal-subtitle')) $('req-modal-subtitle').innerText = subtitle;
    show('req-modal-back-btn', !!form, 'inline-flex');
    show('btn-submit-request', !!form, 'block');
    $('req-form-content').innerHTML = form ? form.body() : `
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 2px;">
            ${REQUEST_CHOICES.map(([key, bg, color, icon, titleKey, titleFallback, descKey, descFallback]) => `
                <button type="button" onclick="openUserRequestModal(${jsArg(key)})" style="display: flex; align-items: center; text-align: left; width: 100%; background: var(--surface-alt); border: 1px solid var(--border-light); border-radius: 12px; padding: 10px 12px; cursor: pointer; transition: all 0.2s ease;">
                    <div style="width: 34px; height: 34px; border-radius: 9px; background: ${bg}; color: ${color}; display: flex; align-items: center; justify-content: center; font-size: 1.05rem; flex-shrink: 0; margin-right: 11px;">
                        ${icon}
                    </div>
                    <div style="min-width: 0; flex: 1;">
                        <div style="color: var(--text); font-weight: 700; font-size: 0.88rem;">${t(titleKey, titleFallback)}</div>
                        <div style="color: var(--text-secondary); font-size: 0.76rem; margin-top: 1px;">${t(descKey, descFallback)}</div>
                    </div>
                </button>`).join('')}
        </div>`;
    openModal('user-request-modal');
}

// Validates the open request form; returns { type, data } or null after alerting the user.
function collectRequestData(date) {
    const fillFields = () => showToast(t('alert_fill_fields', 'Please fill out all fields.'), 'error');
    const invalidAmount = () => showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    if (currentRequestType === 'status') {
        const newStatus = $('req-status') ? inputValue('req-status') : 'vollverdiener';
        return newStatus ? { type: 'status', data: { newStatus, date } } : fillFields();
    }
    const typed = inputValue('req-amount').trim();
    const parsed = parseAmount(typed);
    // Stored as a plain number text ("1500", "12.5") like before
    const amount = String(parsed);
    if (currentRequestType === 'expense') {
        const description = inputValue('req-desc').trim();
        if (!typed || !description) return fillFields();
        if (!(parsed > 0)) return invalidAmount();
        return { type: 'expense', data: { amount, description, date } };
    }
    if (currentRequestType !== 'payment') return { type: 'payment', data: {} };
    if (!typed) return fillFields();
    if (!(parsed > 0)) return invalidAmount();
    return { type: isChecked('req-is-standing-order') ? 'standing_order' : 'payment', data: { amount, date, note: inputValue('req-note').trim() } };
}

async function submitUserRequest() {
    if (!currentUser) return;
    const person = people.find(p => p.uid === currentUser.uid) || null;
    const personId = person ? person.id : (currentUser.uid || currentUser.id || 'unknown');
    const personName = person ? person.name : (fullName(currentUser) || currentUser.name || currentUser.email || t('user_fallback_name', 'User'));
    const date = $('req-date') ? inputValue('req-date') : getTodayStr();
    if (!date) return showToast(t('alert_fill_fields', 'Please fill out all fields.'), 'error');
    const request = collectRequestData(date);
    if (!request) return;

    if (request.type === 'expense') {
        const files = pendingUploads.req.files.length > 0 ? pendingUploads.req.files : Array.from($('req-receipt')?.files || []);
        if (files.length > 0) {
            setButtonLoading('btn-submit-request', true, t('btn_uploading', 'Uploading...'));
            try {
                request.data.receipt = await uploadAll(files, personName, date);
            } catch (err) {
                showToast(t('alert_upload_error', 'Upload failed: ') + err.message, 'error');
                return setButtonLoading('btn-submit-request', false);
            }
        }
    }
    const newReq = { id: newId(), type: request.type, userId: currentUser.uid || currentUser.id, personId, personName, data: request.data, status: 'pending', timestamp: Date.now() };
    setButtonLoading('btn-submit-request', true, t('btn_sending', 'Sending...'));
    try {
        await set(ref(db, 'requests/' + newReq.id), newReq);
        closeModal('user-request-modal');
        showToast(t('toast_request_sent', 'Request successfully sent'));
        // Show the request immediately, then sync with the server
        if (!requests.some(r => r.id === newReq.id)) {
            requests.unshift(newReq);
            renderUserView();
        }
        await loadData(true);
        api('/notify-admins', 'POST', { reqType: request.type, personName }).catch(e => console.warn('Fehler beim Senden der Admin-Info über Backend', e));
    } catch (err) {
        console.error('Fehler beim Senden der Anfrage:', err);
        showToast(t('alert_send_request_failed', 'Request could not be sent. Please try again.') + (err.message ? ` ${err.message}` : ''), 'error');
    } finally {
        setButtonLoading('btn-submit-request', false);
    }
}

// --- Receipt upload & download ---
async function fetchWithTimeout(resource, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        return await fetch(resource, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

const loadImage = src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
});

async function compressImage(file, quality) {
    const img = await loadImage(await readAsDataUrl(file));
    const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    canvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Canvas to Blob failed');
    return new File([blob], /\.jpe?g$/i.test(file.name) ? file.name : file.name.replace(/\.[^/.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

// Uploads a receipt (HEIC converted, large images recompressed) and resolves to the stored filename.
async function uploadReceipt(file, transactionName, transactionDate) {
    if (!auth.currentUser) throw new Error('Not authenticated');
    const token = await auth.currentUser.getIdToken();
    let uploadFile = await convertHeic(file, 0.8);
    const compressible = uploadFile.type.startsWith('image/') && uploadFile.type !== 'image/gif' && uploadFile.type !== 'image/svg+xml';
    if (compressible && uploadFile.size >= 500 * 1024) {
        try {
            uploadFile = await compressImage(uploadFile, uploadFile.size > 2 * 1024 * 1024 ? 0.65 : 0.75);
        } catch (e) {
            console.error('Compression failed:', e);
        }
    }
    try {
        const res = await fetchWithTimeout(`${API}/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: toFormData({ name: transactionName, date: transactionDate, receipt: uploadFile })
        });
        if (!res.ok) throw new Error('Upload failed: ' + res.statusText);
        return (await res.json()).filename;
    } catch (error) {
        console.error('Upload error:', error);
        throw error;
    }
}

async function fetchReceiptImage(filename) {
    if (!auth.currentUser) throw new Error('Not authenticated');
    const token = await auth.currentUser.getIdToken();
    try {
        const res = await fetchWithTimeout(`${API}/receipts/${encodeURIComponent(filename)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Fetch failed: ' + res.statusText);
        return URL.createObjectURL(await convertHeic(await res.blob(), 0.8, filename));
    } catch (error) {
        console.error('Fetch image error:', error);
        throw error;
    }
}

Object.assign(window, {
    assignUserToPerson, saveEditedPayment, deleteEditReceipt, confirmDeleteRecordedPayment, approveRequest, confirmRejectRequest, toggleRejectForm, openRequestDetail, toggleAllMyRequests, toggleDetails,
    showTransactionDetails, viewRequestReceipt, openExportReportModal, setReportType, setReportTier, updatePaymentDateLabel, toggleManualTransactionSelection, onReportTypeChange, updateReportPreview,
    downloadReportPdf, openPaymentModal, addPayment, addDonation, addExpense, openEndStandingOrderModal, saveStandingOrderEnd,
    deleteStandingOrderCompletely, openChangeStatusModal, saveStatusChange, sendStatusEmail, openUserRequestModal, submitUserRequest,
    loadMoreHistory: () => {
        transactionPage += 1;
        renderHistoryTab(false);
    },
    deleteRecordedPaymentClick: () => {
        if (canManageFinances() && currentEditedPayment) openModal('confirm-delete-modal');
    },
    filterPeople: debounce(filterPeopleSync, 300),
    filterHistory: debounce(() => {
        if (inputValue('history-search').trim() !== transactionSearchQuery) renderHistoryTab(true);
    }, 300)
});

// --- AI assistant chat ---
let aiMessages = [];
let aiStreaming = false;
// The running request; a new chat or a vanished connection cancels it
let aiChatAbort = null;
const MAX_AI_CHAT_INPUT_HEIGHT = 120;

function createEl(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
}

// The AI's sign: a soft orb in the colours of the assistant with a sparkle in it (slowly turning, faster while it thinks)
const aiOrb = (size, extra = '') => `<span class="ai-orb ai-orb-${size}${extra ? ' ' + extra : ''}" aria-hidden="true"><span class="ai-orb-glow"></span><span class="ai-orb-core"></span>${svgIcon('sparkles', size === 'lg' ? 30 : 14, size === 'lg' ? 1.7 : 2.1, 'class="ai-orb-glyph"')}</span>`;

// A new chat: a friendly start with three questions the assistant can answer (members, finances, requests, events)
function clearAiChat() {
    aiMessages = [];
    aiChatAbort?.abort();
    const messagesEl = $('ai-chat-messages');
    if (!messagesEl) return;
    const admin = canViewFinances();
    const ideaIcons = admin ? ['coin', 'calendar', 'clipboard'] : ['coin', 'calendar', 'user'];
    const ideas = [1, 2, 3].map(n => admin
        ? t(`ai_suggest_admin_${n}`, ['Who is behind with their fee?', 'What is coming up this week?', 'Which requests are still open?'][n - 1])
        : t(`ai_suggest_member_${n}`, ['Until when is my fee paid?', 'What is coming up this week?', 'Where am I on duty next?'][n - 1]));
    const first = (currentUser?.firstName || fullName(currentUser) || currentUser?.name || '').trim().split(/\s+/)[0];
    messagesEl.innerHTML = `
        <div class="ai-chat-welcome">
            ${aiOrb('lg')}
            <h2 class="ai-chat-welcome-text">
                ${first ? `<span class="ai-chat-welcome-hi">${escapeHtml(t('ai_chat_hi_name', 'Hi {name},', { name: first }))}</span>` : ''}
                <span class="ai-chat-welcome-ask">${t('ai_chat_hello', 'How can I help?')}</span>
            </h2>
            <p class="ai-chat-welcome-sub">${admin ? t('ai_chat_welcome_sub', 'Ask about members, finances, events or duties.') : t('ai_chat_welcome_sub_member', 'Ask about events, duties, your fee or how the app works.')}</p>
            <div class="ai-chat-ideas">
                ${ideas.map((idea, index) => `<button type="button" class="ai-chat-idea" style="--i: ${index};" onclick="window.askAi(this.querySelector('.ai-chat-idea-text').textContent)">
                    <span class="ai-chat-idea-icon">${svgIcon(ideaIcons[index], 17, 2)}</span>
                    <span class="ai-chat-idea-text">${escapeHtml(idea)}</span>
                    ${svgIcon('arrowUpRight', 16, 2.2, 'class="ai-chat-idea-go"')}
                </button>`).join('')}
            </div>
        </div>`;
}

function askAi(text) {
    const inputEl = $('ai-chat-input');
    if (!inputEl || aiStreaming) return;
    inputEl.value = text;
    sendAiMessage();
}

function adjustAiInputHeight(inputEl) {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.max(24, Math.min(inputEl.scrollHeight, MAX_AI_CHAT_INPUT_HEIGHT))}px`;
}

// Ctrl/Cmd+Enter sends; plain Enter inserts a newline and grows the textarea.
const chatKeyHandler = (send, resize) => e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
    } else if (e.key === 'Enter') {
        setTimeout(() => resize(e.target), 0);
    }
};

// The start page makes room for the first message: it fades upwards while the message comes in
function dismissAiWelcome(messagesEl) {
    const welcome = messagesEl.querySelector('.ai-chat-welcome');
    if (!welcome) return false;
    // Still on its way out: the next message waits for it too
    if (welcome.classList.contains('is-leaving')) return true;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        welcome.remove();
        return false;
    }
    welcome.classList.add('is-leaving');
    welcome.addEventListener('animationend', () => welcome.remove(), { once: true });
    setTimeout(() => welcome.remove(), 600);
    return true;
}

function appendAiMessage(role, content) {
    const messagesEl = $('ai-chat-messages');
    if (!messagesEl) return null;
    const afterWelcome = dismissAiWelcome(messagesEl);
    const bubble = createEl('div', `ai-chat-bubble ai-chat-bubble-${role}`);
    let item = bubble;
    if (role === 'assistant') {
        bubble.appendChild(renderMarkdown(content));
        item = createEl('div', 'ai-chat-row');
        const mark = createEl('span', 'ai-chat-mark');
        mark.innerHTML = aiOrb('sm');
        item.append(mark, bubble);
    } else {
        bubble.textContent = content;
    }
    if (afterWelcome) item.classList.add('is-after-welcome');
    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

// Renders streamed assistant content; <think>/<thought> blocks and reasoning go into a collapsed <details>.
// "Melden" under a finished AI reply: sends reply + question to the admins (Google Play AI content policy)
function addAiReportButton(bubble, answer, prompt) {
    if (!bubble || !answer) return;
    const btn = createEl('button', 'ai-report-btn');
    btn.type = 'button';
    btn.innerHTML = `${svgIcon('flag', 13)}<span>${escapeHtml(t('ai_report', 'Report reply'))}</span>`;
    btn.onclick = async () => {
        const reason = window.prompt(t('ai_report_reason', 'What is wrong with this reply? (optional)'), '');
        if (reason === null) return;
        try {
            await apiJson('/reports', 'POST', { type: 'ai', content: answer, prompt, reason }, t('report_failed', 'Report failed.'));
            btn.disabled = true;
            btn.querySelector('span').textContent = t('report_sent', 'Reported – thank you!');
        } catch (err) {
            showToast(err.message, 'error');
        }
    };
    bubble.appendChild(btn);
}

// Splits a reply into the answer and the thought process: reasoning sent apart, or <think>/<thought> blocks in
// the text (an unclosed block means the model is still thinking)
function splitAiThinking(rawContent, reasoningContent = '') {
    let inline = '';
    let open = false;
    const answer = rawContent.replace(/<(think|thought)>([\s\S]*?)(<\/\1>|$)/gi, (_, tag, inner, close) => {
        inline += inner;
        if (!close) open = true;
        return '';
    }).replace(/<\/?(?:think|thought)?$|<\/?(?:t|th|thi|thin|tho|thou|thoug|though)$/i, '').trim();
    return { answer, thinking: (reasoningContent + inline).trim(), open };
}

// One assistant reply while it streams in: a small "Thinking…" line with the seconds (the thoughts open on a tap)
// until the first words arrive, then the answer. Drawn at most once per frame, so long thoughts stay smooth.
function createAiReply(bubble) {
    const row = bubble.closest('.ai-chat-row');
    const orb = row?.querySelector('.ai-orb');
    const details = createEl('details', 'ai-thinking is-live is-empty');
    const summary = createEl('summary', 'ai-thinking-summary');
    const label = createEl('span', 'ai-thinking-label', t('ai_thinking', 'Thinking'));
    const time = createEl('span', 'ai-thinking-time');
    summary.append(label, time);
    const pre = createEl('pre', 'ai-thinking-content');
    details.append(summary, pre);
    const answerEl = createEl('div', 'ai-answer');
    bubble.replaceChildren(details, answerEl);
    orb?.classList.add('is-thinking');
    // A closed "Thinking" line is not a toggle until there is something to show
    summary.addEventListener('click', event => { if (details.classList.contains('is-empty')) event.preventDefault(); });

    const started = Date.now();
    let thoughtFor = 0;
    let content = '';
    let reasoning = '';
    let shownAnswer = null;
    let frame = 0;
    const seconds = () => Math.max(1, Math.round(((thoughtFor || Date.now()) - started) / 1000));
    const tick = setInterval(() => { if (!thoughtFor) time.textContent = t('ai_thinking_seconds', '{n} s', { n: seconds() }); }, 1000);

    const draw = () => {
        frame = 0;
        const { answer, thinking, open } = splitAiThinking(content, reasoning);
        const stillThinking = !answer || open;
        if (!stillThinking && !thoughtFor) {
            thoughtFor = Date.now();
            details.classList.remove('is-live');
            orb?.classList.remove('is-thinking');
            label.textContent = t('ai_thought', 'Thought');
            time.textContent = t('ai_thinking_seconds', '{n} s', { n: seconds() });
        }
        details.classList.toggle('is-empty', !thinking);
        if (pre.textContent !== thinking) {
            const follow = details.open && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
            pre.textContent = thinking;
            if (follow) pre.scrollTop = pre.scrollHeight;
        }
        if (answer !== shownAnswer) {
            shownAnswer = answer;
            answerEl.replaceChildren(renderMarkdown(answer));
        }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

    return {
        add(part) {
            content += part.content || '';
            reasoning += part.reasoning || '';
            schedule();
        },
        get content() { return content; },
        get reasoning() { return reasoning; },
        // The reply is complete: last drawing, no thinking line when there were no thoughts
        finish() {
            clearInterval(tick);
            if (frame) cancelAnimationFrame(frame);
            draw();
            if (!thoughtFor) {
                thoughtFor = Date.now();
                label.textContent = t('ai_thought', 'Thought');
            }
            details.classList.remove('is-live');
            orb?.classList.remove('is-thinking');
            if (details.classList.contains('is-empty')) details.remove();
        },
        stop() {
            clearInterval(tick);
            if (frame) cancelAnimationFrame(frame);
            orb?.classList.remove('is-thinking');
        }
    };
}

// Normalizes text for AI providers: NFC, no control characters or lone surrogates, LF line endings.
function sanitizeAiText(input) {
    let text = typeof input === 'string' ? input : String(input || '');
    try { text = text.normalize('NFC'); } catch { /* ignore */ }
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    text = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    return text.replace(/\r\n?/g, '\n');
}

function sanitizeAiMessages(rawMessages, maxMessages = 50, maxCharPerMsg = 12000) {
    return rawMessages
        .filter(msg => msg && (msg.role === 'assistant' || msg.role === 'user'))
        .map(msg => ({ role: msg.role, content: sanitizeAiText(msg.content).trim().slice(0, maxCharPerMsg) }))
        .filter(msg => msg.content)
        .slice(-maxMessages);
}

// --- Minimal LaTeX math rendering (DOM only, no innerHTML) ---
function extractBalancedBraces(str, start) {
    if (str[start] !== '{') return null;
    for (let i = start, depth = 0; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}' && --depth === 0) return { content: str.slice(start + 1, i), endIndex: i };
    }
    return null;
}

function buildMathNodes(str) {
    const frag = document.createDocumentFragment();
    const skipSpace = pos => {
        while (pos < str.length && /\s/.test(str[pos])) pos++;
        return pos;
    };
    const wrap = (tag, className, content) => {
        const wrapper = createEl(tag, className);
        wrapper.appendChild(buildMathNodes(content));
        return wrapper;
    };
    let i = 0;
    while (i < (str || '').length) {
        const rest = str.slice(i);
        let m;
        if ((m = rest.match(/^\\(?:frac|dfrac|tfrac)/))) {
            const num = extractBalancedBraces(str, skipSpace(i + m[0].length));
            const den = num && extractBalancedBraces(str, skipSpace(num.endIndex + 1));
            if (den) {
                const frac = createEl('span', 'ai-math-frac');
                frac.append(wrap('span', 'ai-math-num', num.content), wrap('span', 'ai-math-den', den.content));
                frag.appendChild(frac);
                i = den.endIndex + 1;
                continue;
            }
        }
        if ((m = rest.match(/^\\sqrt(?:\[([^\]]+)\])?/))) {
            const radicand = extractBalancedBraces(str, skipSpace(i + m[0].length));
            if (radicand) {
                const sqrt = createEl('span', 'ai-math-sqrt');
                if (m[1]) sqrt.appendChild(createEl('sup', 'ai-math-root-deg', m[1]));
                sqrt.append(createEl('span', 'ai-math-sqrt-rad', '√'), wrap('span', 'ai-math-sqrt-stem', radicand.content));
                frag.appendChild(sqrt);
                i = radicand.endIndex + 1;
                continue;
            }
        }
        if ((m = rest.match(/^\\(?:text|mathrm|mathbf|mathit|operatorname)/))) {
            const block = extractBalancedBraces(str, skipSpace(i + m[0].length));
            if (block) {
                frag.appendChild(createEl('span', 'ai-math-text', block.content));
                i = block.endIndex + 1;
                continue;
            }
        }
        if (str[i] === '^' || str[i] === '_') {
            const isSup = str[i++] === '^';
            const block = str[i] === '{' ? extractBalancedBraces(str, i) : null;
            const content = block ? block.content : (str[i] ?? '');
            i = block ? block.endIndex + 1 : Math.min(i + 1, str.length);
            frag.appendChild(wrap(isSup ? 'sup' : 'sub', isSup ? 'ai-math-sup' : 'ai-math-sub', content));
            continue;
        }
        frag.appendChild(document.createTextNode(str[i++]));
    }
    return frag;
}

const MATH_SYMBOLS = {
    '\\pm': '±', '\\mp': '∓', '\\times': '×', '\\cdot': '·', '\\div': '÷',
    '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\neq': '≠', '\\ne': '≠',
    '\\approx': '≈', '\\equiv': '≡', '\\sim': '∼', '\\propto': '∝',
    '\\sum': '∑', '\\prod': '∏', '\\int': '∫', '\\iint': '∬', '\\iiint': '∭', '\\oint': '∮',
    '\\partial': '∂', '\\nabla': '∇', '\\infty': '∞',
    '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆', '\\cup': '∪', '\\cap': '∩', '\\emptyset': '∅',
    '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
    '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐', '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔',
    '\\dots': '…', '\\ldots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
    '\\circ': '∘', '\\degree': '°', '\\deg': '°',
    '\\quad': ' ', '\\qquad': '  ', '\\,': ' ', '\\;': ' ', '\\:': ' ', '\\ ': ' ',
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε', '\\varepsilon': 'ε',
    '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
    '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\varpi': 'ϖ',
    '\\rho': 'ρ', '\\varrho': 'ϱ', '\\sigma': 'σ', '\\varsigma': 'ς', '\\tau': 'τ', '\\upsilon': 'υ',
    '\\phi': 'φ', '\\varphi': 'ϕ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
    '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ', '\\Xi': 'Ξ', '\\Pi': 'Π',
    '\\Sigma': 'Σ', '\\Upsilon': 'Υ', '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω'
};

function parseMathToFragment(mathStr) {
    if (!mathStr) return document.createDocumentFragment();
    let s = mathStr.replace(/\\left([(\[{|.\\])/g, '$1').replace(/\\right([)\]}|.\\])/g, '$1')
        .replace(/\\(sin|cos|tan|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|lim|min|max|sup|inf|det|gcd|deg)\b/g, '$1');
    for (const [cmd, sym] of Object.entries(MATH_SYMBOLS)) s = s.replace(new RegExp(cmd.replace(/\\/g, '\\\\') + '(?![a-zA-Z])', 'g'), sym);
    return buildMathNodes(s);
}

// --- Lightweight Markdown → DOM renderer (DOM APIs only, no innerHTML) ---
function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;
    const codeBlocks = [];
    const mathBlocks = [];
    const stashMath = (_, math) => `\x00MATH${mathBlocks.push(math.trim()) - 1}\x00`;
    const lines = text
        .replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => `\x00CODE${codeBlocks.push({ lang, code: code.replace(/\n$/, '') }) - 1}\x00`)
        .replace(/\$\$([\s\S]*?)(?:\$\$|$)/g, stashMath)
        .replace(/\\\[([\s\S]*?)(?:\\\]|$)/g, stashMath)
        .split('\n');

    let i = 0;
    // Consumes consecutive lines matching `pattern`, returning them with `strip` removed
    const takeWhile = (pattern, strip) => {
        const taken = [];
        while (i < lines.length && pattern.test(lines[i])) taken.push(strip ? lines[i++].replace(strip, '') : lines[i++]);
        return taken;
    };
    const list = (tag, items) => {
        const listEl = createEl(tag);
        items.forEach(item => appendInlineNodes(listEl.appendChild(createEl('li')), item));
        return listEl;
    };
    while (i < lines.length) {
        const line = lines[i];
        let m;
        if ((m = line.match(/^\x00MATH(\d+)\x00$/))) {
            frag.appendChild(createEl('div', 'ai-math-display')).appendChild(parseMathToFragment(mathBlocks[m[1]]));
            i++;
        } else if ((m = line.match(/^\x00CODE(\d+)\x00$/))) {
            const { lang, code } = codeBlocks[m[1]];
            frag.appendChild(createEl('pre', 'ai-code-block')).appendChild(createEl('code', lang ? `language-${lang}` : '', code));
            i++;
        } else if (/^[ \t]*>/.test(line)) {
            frag.appendChild(createEl('blockquote')).appendChild(renderMarkdown(takeWhile(/^[ \t]*>/, /^[ \t]*>[ \t]?/).join('\n')));
        } else if (/^[ \t]*[-*+] /.test(line)) {
            frag.appendChild(list('ul', takeWhile(/^[ \t]*[-*+] /, /^[ \t]*[-*+] /)));
        } else if (/^[ \t]*\d+\. /.test(line)) {
            frag.appendChild(list('ol', takeWhile(/^[ \t]*\d+\. /, /^[ \t]*\d+\. /)));
        } else if ((m = line.match(/^(#{1,6}) (.+)/))) {
            appendInlineNodes(frag.appendChild(createEl(`h${m[1].length}`)), m[2]);
            i++;
        } else if (/^[ \t]*\|/.test(line)) {
            frag.appendChild(renderMarkdownTable(takeWhile(/^[ \t]*\|/).map(row => row.trim())));
        } else {
            if (/^(?:---+|\*\*\*+|___+)$/.test(line.trim())) frag.appendChild(createEl('hr'));
            else if (line.trim() === '') frag.appendChild(createEl('br'));
            else appendInlineNodes(frag.appendChild(createEl('p')), line);
            i++;
        }
    }
    return frag;
}

function renderMarkdownTable(rows) {
    const wrapper = createEl('div', 'ai-table-wrapper');
    const table = wrapper.appendChild(createEl('table'));
    const thead = createEl('thead');
    const tbody = createEl('tbody');
    let isHeader = true;
    for (const row of rows) {
        // Separator rows like |:---|:---| end the header
        if (/^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/.test(row)) {
            isHeader = false;
            continue;
        }
        const cells = row.split('|');
        if (cells.length > 0 && cells[0].trim() === '') cells.shift();
        if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
        const tr = (isHeader ? thead : tbody).appendChild(createEl('tr'));
        cells.forEach(cell => appendInlineNodes(tr.appendChild(createEl(isHeader ? 'th' : 'td')), cell.trim()));
        isHeader = false;
    }
    if (thead.childNodes.length > 0) table.appendChild(thead);
    if (tbody.childNodes.length > 0) table.appendChild(tbody);
    return wrapper;
}

// Inline markdown: math, code, bold/italic, strikethrough and links — text is only ever set via textContent.
const INLINE_MARKDOWN = /(\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)(?!\d+(?:[.,]\d+)?(?:\s|[.,;!?]|$))([^\$\n]+?)(?<!\s)\$|`[^`]+`|\*\*\*(?:.+?)\*\*\*|\*\*(?:.+?)\*\*|__(?:.+?)__|\*(?:[^*]+)\*|_(?:[^_]+)_|~~(?:.+?)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;

function inlineNode(token, match) {
    const wrapped = (open, close = open) => token.startsWith(open) && token.endsWith(close) && token.length > open.length + close.length;
    const math = content => {
        const span = createEl('span', 'ai-math-inline');
        span.appendChild(parseMathToFragment(content));
        return span;
    };
    if (token.startsWith('\\(') && token.endsWith('\\)')) return math(token.slice(2, -2));
    if (wrapped('$')) return math(token.slice(1, -1));
    if (wrapped('`')) return createEl('code', 'ai-inline-code', token.slice(1, -1));
    if (wrapped('***')) {
        const strong = createEl('strong');
        strong.appendChild(createEl('em', '', token.slice(3, -3)));
        return strong;
    }
    if (wrapped('**') || wrapped('__')) return createEl('strong', '', token.slice(2, -2));
    if (wrapped('*') || wrapped('_')) return createEl('em', '', token.slice(1, -1));
    if (wrapped('~~')) return createEl('del', '', token.slice(2, -2));
    if (match[3] && match[4]) {
        const link = createEl('a', '', match[3]);
        Object.assign(link, { href: match[4], target: '_blank', rel: 'noopener noreferrer' });
        return link;
    }
    return document.createTextNode(token);
}

function appendInlineNodes(parent, text) {
    if (!text) return;
    let lastIndex = 0;
    for (const match of text.matchAll(INLINE_MARKDOWN)) {
        if (match.index > lastIndex) parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        parent.appendChild(inlineNode(match[0], match));
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)));
}

// Without a single byte for this long (the server sends a sign of life every 15 s) the connection is gone
const AI_IDLE_TIMEOUT_MS = 75000;

async function sendAiMessage() {
    if (aiStreaming) return;
    const inputEl = $('ai-chat-input');
    const sendBtn = $('ai-chat-send-btn');
    if (!inputEl) return;
    const text = sanitizeAiText(inputEl.value).trim();
    if (!text) return;
    inputEl.value = '';
    adjustAiInputHeight(inputEl);
    aiMessages.push({ role: 'user', content: text });
    appendAiMessage('user', text);
    aiStreaming = true;
    if (sendBtn) sendBtn.disabled = true;

    const messagesEl = $('ai-chat-messages');
    const nearEnd = () => !messagesEl || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    const scrollToEnd = () => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; };
    // The reply appears right away as "Thinking…" and fills in when the words come
    const bubble = appendAiMessage('assistant', '');
    const reply = createAiReply(bubble);
    const controller = new AbortController();
    aiChatAbort = controller;
    let idleTimer = 0;
    let timedOut = false;
    const keepAlive = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, AI_IDLE_TIMEOUT_MS);
    };
    keepAlive();

    try {
        let token;
        try {
            token = await auth.currentUser.getIdToken();
        } catch {
            throw new Error(t('error_auth_failed_short', 'Authentication failed'));
        }
        const messages = sanitizeAiMessages(aiMessages);
        if (messages.length === 0) throw new Error(t('ai_no_valid_message', 'No valid message to send'));
        const res = await fetch(`${API}/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ messages }),
            signal: controller.signal
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || errData.error || `HTTP ${res.status}`);
        }
        // Server-sent events: "data: {content | reasoning | error}" lines, terminated by "data: [DONE]";
        // ": ping" lines only keep the connection alive
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;
        const handleLine = rawLine => {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) return;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
                finished = true;
                return;
            }
            let parsed;
            try { parsed = JSON.parse(data); } catch { return; }
            if (parsed.error) throw new Error(parsed.error);
            const follow = nearEnd();
            reply.add(parsed);
            if (follow) requestAnimationFrame(scrollToEnd);
        };
        while (!finished) {
            const chunk = await reader.read();
            if (chunk.done) break;
            keepAlive();
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(handleLine);
        }
        if (!finished) handleLine(buffer + decoder.decode());
        if (finished) reader.cancel().catch(() => {});
        reply.finish();
        const clean = sanitizeAiText(splitAiThinking(reply.content).answer).trim();
        // A model that only thought (or the connection ended early) gave no answer: say so instead of an empty row
        if (!clean) throw new Error(reply.reasoning ? t('ai_only_thought', 'The AI thought about it but sent no answer. Please try again.') : t('ai_no_answer', 'No answer came back. Please try again.'));
        addAiReportButton(bubble, clean, [...aiMessages].reverse().find(m => m.role === 'user')?.content || '');
        if (nearEnd()) scrollToEnd();
        aiMessages.push({ role: 'assistant', content: clean });
    } catch (err) {
        reply.stop();
        // A new chat cancelled this reply: nothing to show
        if (controller.signal.aborted && !timedOut) return;
        console.error('KI-Chat Fehler:', err);
        const reason = timedOut ? t('ai_timeout', 'The AI stopped answering. Please try again.') : (err.message || t('error_unknown', 'Unknown error'));
        bubble.replaceChildren(document.createTextNode(t('ai_error', 'Error: {message}', { message: reason })));
        bubble.classList.add('ai-chat-bubble-error');
        // Drop the failed user message so it can be retried
        if (aiMessages[aiMessages.length - 1]?.role === 'user') aiMessages.pop();
    } finally {
        clearTimeout(idleTimer);
        if (aiChatAbort === controller) {
            aiChatAbort = null;
            aiStreaming = false;
            if (sendBtn) sendBtn.disabled = false;
        }
    }
}

Object.assign(window, {
    clearAiChat, sendAiMessage, askAi,
    handleAiChatInput: event => event?.target && adjustAiInputHeight(event.target),
    handleAiChatKey: chatKeyHandler(sendAiMessage, adjustAiInputHeight)
});

// --- Mentoring: anonymous, confidential 1:1 support ---
let mentoringMentors = [];
let mentoringThreads = [];
let activeMentoringThreadId = null;
let activeMentoringMessages = [];
let currentMentoringSubTab = 'chats';
let mentoringChatPollTimer = null;
let myMentorProfile = null;
let openingDirectChat = false;
let mentoringChatHistoryPushed = false;
let mentoringChatReturnHome = false;
// Bumped when the chat is closed, so thread loads still in flight don't reopen it
let mentoringChatGeneration = 0;

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
const findThread = id => (Array.isArray(mentoringThreads) ? mentoringThreads.find(th => th.id === id) : null);
const threadElement = id => document.querySelector(`.mentoring-thread-item[data-thread-id="${id}"]`);

// Count badges are flex boxes (the number is centred by CSS); large counts are capped
const formatBadgeCount = count => (count > 99 ? '99+' : String(count));
function setCountBadge(id, count, display = 'inline-flex') {
    const badge = $(id);
    if (!badge) return;
    badge.textContent = formatBadgeCount(count);
    badge.style.display = count > 0 ? display : 'none';
}

// Mentors see the anonymous alias of the seeker, seekers see their mentor's name.
function threadPartner(thread) {
    const isMentor = !!thread && isCurrentUser(thread.mentor);
    return {
        isMentor,
        name: isMentor ? (thread.mentee_alias || t('mentoring_partner_anonymous', 'Anonymous Seeker')) : (thread?.mentor_name || t('mentoring_partner_mentor', 'Mentor')),
        role: isMentor ? t('mentoring_role_seeker', 'Seeker (anonymous)') : t('mentoring_role_mentor', 'Your Mentor')
    };
}

// The chat pane is on screen: mentoring tab with the "Nachrichten" sub-tab, in a visible browser tab
const isMentoringChatVisible = () => currentActiveTab === 'mentoring' && currentMentoringSubTab === 'chats' && !document.hidden;

// New message, new chat or changed chat status elsewhere: refresh the list and counts, plus what is on screen
async function refreshMentoringFromRemote() {
    if (!canUseMentoring()) return;
    const openThread = isMentoringChatVisible() ? activeMentoringThreadId : null;
    await loadMentoringThreads(false, null, false);
    if (openThread && openThread === activeMentoringThreadId) loadMentoringMessages(openThread, true);
    if (currentActiveTab === 'mentoring' && currentMentoringSubTab === 'find') loadMentorsList();
}

function updateMentoringUnreadBadge() {
    const unread = mentoringThreads.reduce((sum, th) => sum + (th.unread_count > 0 ? th.unread_count : 0), 0);
    // Sub-tab "Nachrichten" plus the mentoring entry of both navigations
    for (const id of ['mentoring-unread-badge', 'mentoring-nav-badge-bottom', 'mentoring-nav-badge-desktop']) setCountBadge(id, unread);
    renderHomeMentoringCard();
}

function markThreadElementRead(item) {
    item.classList.remove('unread');
    item.classList.add('read');
    item.querySelector('.mentoring-badge-count')?.remove();
}

function closeMobileChatPane() {
    $('mentoring-threads-layout')?.classList.remove('in-chat');
    $('mentoring-chat-pane')?.classList.remove('mobile-open');
    document.body.classList.remove('mentoring-mobile-chat-open');
}

const MENTORING_SUBTABS = {
    find: () => loadMentorsList(),
    chats: () => {
        if (!openingDirectChat && !activeMentoringThreadId && isMobile()) closeMobileChatPane();
        loadMentoringThreads(false, activeMentoringThreadId);
    },
    review: () => loadMentoringReviewList()
};

function switchMentoringSubTab(subTab) {
    currentMentoringSubTab = subTab;
    for (const key of Object.keys(MENTORING_SUBTABS)) {
        const btn = $(`mentoring-tab-${key}`);
        btn?.classList.toggle('active', key === subTab);
        btn?.setAttribute('aria-selected', key === subTab ? 'true' : 'false');
        show(`mentoring-subview-${key}`, key === subTab);
    }
    MENTORING_SUBTABS[subTab]?.();
    syncUrl();
}

async function loadMentoringData() {
    if (!canUseMentoring()) return;
    const isManager = canManageMentoring();
    show('mentoring-tab-review', isManager, 'inline-flex');
    show(document.querySelector('.mentoring-nav-bar'), true, 'block');
    try {
        const res = await api('/mentoring/my-profile');
        if (res.ok) {
            myMentorProfile = (await res.json()).mentor || null;
            const applyBtn = $('mentor-apply-btn');
            if (applyBtn) {
                applyBtn.innerHTML = myMentorProfile?.status === 'approved' ? t('mentoring_my_profile_btn', 'My Mentor Profile')
                    : myMentorProfile?.status === 'pending' ? t('mentoring_pending_profile_btn', '⏳ Application in Review')
                    : t('mentoring_apply_btn', 'Apply as Mentor');
            }
        }
    } catch (err) {
        console.warn('Failed to load my mentor profile:', err);
    }
    if (isManager) {
        try {
            const res = await api('/mentoring/mentors?status=pending');
            if (res.ok) {
                const list = await res.json();
                setCountBadge('mentoring-pending-badge', Array.isArray(list) ? list.length : 0);
            }
        } catch (err) {
            console.warn('Failed to load pending mentors count:', err);
        }
    }
    switchMentoringSubTab(currentMentoringSubTab);
}

async function loadMentorsList() {
    const grid = $('mentors-grid');
    if (!grid) return;
    const gridMessage = (color, text) => `<div style="grid-column: 1/-1; text-align:center; padding:30px; color:var(${color});">${text}</div>`;
    try {
        const res = await api('/mentoring/mentors?status=approved');
        if (res.ok) {
            mentoringMentors = await res.json();
            renderMentorsGrid();
        } else {
            grid.innerHTML = gridMessage('--text-secondary', t('mentoring_load_error', 'Mentors could not be loaded.'));
        }
    } catch (err) {
        console.warn('Failed to load mentors:', err);
        grid.innerHTML = gridMessage('--danger', t('mentoring_network_error', 'Network error while loading mentors.'));
    }
}

function mentorCapacity(m) {
    const max = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
    const active = typeof m.active_mentees === 'number' ? m.active_mentees : (typeof m.activeMentees === 'number' ? m.activeMentees : 0);
    return { max, active, isFull: m.isFull === true || (typeof m.active_mentees === 'number' && active >= max) || m.isAccepting === false };
}

function mentorCardAction(m, name, isSelf, isFull) {
    if (isSelf) return `<button type="button" class="btn btn-secondary btn-small" onclick="window.openMentorApplicationModal()">${t('mentoring_btn_edit_profile', 'Edit Profile')}</button>`;
    const mentorUserId = m.user || m.user_id || m.id;
    const existing = mentoringThreads.find(th => (th.mentor === mentorUserId || th.mentor === m.user || th.mentor === m.id) && th.mentee === currentUid());
    if (existing) {
        const closed = existing.status === 'closed';
        return `
            <button type="button" class="btn btn-secondary btn-small" onclick="window.openMentoringChatDirect(${jsArg(existing.id)}, 'find')" title="${closed ? t('mentoring_btn_open_closed_chat_title', 'Show closed conversation') : t('mentoring_btn_open_chat_title', 'Open ongoing conversation')}">
                ${closed ? t('mentoring_btn_open_closed_chat', '📁 Go to chat') : t('mentoring_btn_open_chat', '💬 Go to chat')}
            </button>`;
    }
    return `
        <button type="button" class="btn btn-mentor-primary btn-small" ${isFull ? 'disabled' : ''} onclick="window.openMentorContactModal(${jsArg(mentorUserId)}, ${jsArg(name)})">
            ${isFull ? t('mentoring_btn_full', 'Fully booked') : t('mentoring_btn_contact', 'Contact anonymously')}
        </button>`;
}

function renderMentorsGrid() {
    const grid = $('mentors-grid');
    if (!grid) return;
    const isManager = canManageMentoring();
    const uid = currentUid();
    const isSelfCard = m => uid && (m.user_id === uid || m.user === uid);
    // Regular members don't see fully booked mentors (except their own card)
    const visible = (Array.isArray(mentoringMentors) ? mentoringMentors : []).filter(m => isManager || isSelfCard(m) || !mentorCapacity(m).isFull);
    if (visible.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-secondary);">
                <div style="font-size: 2.5rem; margin-bottom: 10px;">👥</div>
                <div style="font-weight: 600; font-size: 1.1rem; margin-bottom: 6px;">${t('mentoring_no_mentors_title', 'No mentors currently available')}</div>
                <div style="font-size: 0.9rem;">${isManager ? t('mentoring_no_mentors_desc_manager', 'Once applications are approved, mentors will appear here.') : t('mentoring_no_mentors_desc_user', 'All mentors are currently fully booked or no approved profiles are available.')}</div>
            </div>`;
        return;
    }
    grid.innerHTML = visible.map(m => {
        const name = m.name || m.mentorName || t('mentoring_partner_mentor', 'Mentor');
        const avatarUrl = m.avatar_url || profilePictureSrc(m.user_id);
        const isSelf = isSelfCard(m);
        const { max, active, isFull } = mentorCapacity(m);
        return `
            <div class="mentor-card">
                <div class="mentor-card-header">
                    <div class="mentor-card-avatar avatar-ring-mentor">
                        <div class="mentor-card-avatar-inner">
                            <span style="user-select: none;">${escapeHtml(name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase())}</span>
                            ${avatarUrl ? `<img src="${avatarUrl}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">` : ''}
                        </div>
                    </div>
                    <div class="mentor-card-title">
                        <h3>${escapeHtml(name)}</h3>
                        <span class="mentor-role-badge">${t('mentoring_verified_badge', 'Verified Mentor')}</span>
                    </div>
                </div>
                <div class="mentor-card-bio">${escapeHtml(m.bio || t('mentoring_no_bio', 'No description provided.'))}</div>
                <div class="mentor-card-footer">
                    ${isManager || isSelf ? `
                    <div class="mentor-capacity" title="${t('mentoring_capacity_title', 'Capacity: mentoring relationships')}">
                        <span>${t('mentoring_capacity_active', '👥 {active} / {max} active', { active, max })}</span>
                        ${isFull ? `<span class="mentor-badge-full">${t('mentoring_badge_full', 'Fully booked')}</span>` : ''}
                    </div>` : ''}
                    ${mentorCardAction(m, name, isSelf, isFull)}
                </div>
            </div>`;
    }).join('');
}

function openMentorContactModal(userId, mentorName) {
    const existing = mentoringThreads.find(th => th.mentor === userId && th.mentee === currentUid());
    if (existing) {
        showToast(existing.status === 'closed'
            ? t('mentoring_toast_existing_closed', 'You already have a past conversation with this mentor.')
            : t('mentoring_toast_existing_active', 'You already have an active conversation with this mentor.'), 'info');
        openMentoringChatDirect(existing.id);
        return;
    }
    setValue('mentor-contact-user-id', userId);
    const target = $('mentor-contact-target-name');
    if (target) target.innerText = t('mentor_contact_modal_subtitle', 'Request to {name}', { name: mentorName });
    setValue('mentor-contact-message', '');
    openModal('mentor-contact-modal');
    setTimeout(() => $('mentor-contact-message')?.focus(), 150);
}

function submitMentorContact(e) {
    e?.preventDefault?.();
    return once('mentor-contact', () => submitMentorContactNow(e));
}
async function submitMentorContactNow(e) {
    e?.preventDefault?.();
    const mentorId = inputValue('mentor-contact-user-id');
    const message = inputValue('mentor-contact-message').trim();
    if (!mentorId) return showToast(t('mentor_contact_error_no_mentor', 'No mentor selected.'), 'error');
    if (!message) return showToast(t('mentor_contact_error_no_msg', 'Please enter a first message for the mentor.'), 'error');
    try {
        const res = await api('/mentoring/threads', 'POST', { mentor: mentorId, mentorId, message, initialMessage: message });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (data.threadId) {
                closeModal('mentor-contact-modal');
                showToast(data.error || t('mentoring_toast_existing_opened', 'Opened the existing conversation.'), 'info');
                openMentoringChatDirect(data.threadId);
                return;
            }
            throw new Error(data.error || data.message || t('mentoring_req_error', 'Failed to send the request.'));
        }
        closeModal('mentor-contact-modal');
        showToast(t('mentoring_toast_req_sent', 'Confidential request sent successfully!'), 'success');
        const threadId = data.threadId || data.thread?.id;
        if (threadId) {
            await loadMentoringThreads(true, threadId);
            openMentoringChatDirect(threadId);
        } else {
            loadMentoringThreads(true);
        }
    } catch (err) {
        showToast(err.message || t('mentoring_req_error', 'Failed to send the request.'), 'error');
    }
}

function renderThreadItem(thread) {
    const { isMentor, name, role } = threadPartner(thread);
    const isClosed = thread.status === 'closed';
    const unread = thread.unread_count || 0;
    const closedLabel = t('mentoring_sub_closed', 'Conversation ended');
    const lastMsg = thread.last_message || (isClosed ? closedLabel : t('mentoring_no_messages_yet', 'No messages yet'));
    const dateStr = thread.updated ? new Date(thread.updated).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }) : '';
    const avatar = isMentor
        ? `<div class="mentoring-thread-avatar mentee-avatar" title="${escapeHtml(name)}">${svgIcon('shield', 20)}</div>`
        : renderAvatarWrap(thread.mentor, name, { wrapClass: 'mentoring-thread-avatar mentor-avatar', imgClass: 'mentoring-avatar-img', initialsClass: 'mentoring-avatar-initials' });
    return `
        <div class="mentoring-thread-item ${activeMentoringThreadId === thread.id ? 'active' : ''} ${unread > 0 ? 'unread' : 'read'}" data-thread-id="${escapeHtml(thread.id)}" onclick="window.openMentoringThread(${jsArg(thread.id)})">
            <div class="mentoring-thread-avatar-wrap">
                ${avatar}
                <span class="mentoring-thread-status-dot ${isClosed ? 'closed' : 'active'}" title="${isClosed ? closedLabel : t('status_active', 'Active')}"></span>
            </div>
            <div class="mentoring-thread-info">
                <div class="mentoring-thread-top">
                    <div class="mentoring-thread-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                    <div class="mentoring-thread-time">${escapeHtml(dateStr)}</div>
                </div>
                <div class="mentoring-thread-meta">
                    <span class="mentoring-role-pill ${isMentor ? 'seeker' : 'mentor'} ${isClosed ? 'closed' : ''}">
                        ${escapeHtml(isClosed ? closedLabel : role)}
                    </span>
                </div>
                <div class="mentoring-thread-bottom">
                    <div class="mentoring-thread-snippet" title="${escapeHtml(lastMsg)}">${escapeHtml(lastMsg)}</div>
                    ${unread > 0 ? `<span class="mentoring-badge-count">${formatBadgeCount(unread)}</span>` : ''}
                </div>
            </div>
        </div>`;
}

async function loadMentoringThreads(shouldSelect = false, selectThreadId = null, autoSelect = true) {
    const listEl = $('mentoring-threads-list');
    if (!listEl) return;
    const generation = mentoringChatGeneration;
    try {
        const res = await api('/mentoring/threads');
        if (!res.ok) return console.warn('Failed to fetch mentoring threads, status:', res.status);
        const data = await res.json();
        await picturesReady;
        mentoringThreads = Array.isArray(data) ? data : [];
        updateMentoringUnreadBadge();
        setCountBadge('mentoring-threads-count-badge', mentoringThreads.length);
        if (mentoringThreads.length === 0) {
            listEl.innerHTML = `
                <div class="mentoring-threads-empty">
                    <div class="mentoring-empty-icon">💬</div>
                    <div class="mentoring-empty-title">${t('mentoring_no_threads_title', 'No active conversations')}</div>
                    <div class="mentoring-empty-desc">${t('mentoring_no_threads_desc', 'Contact a mentor to start a confidential conversation.')}</div>
                    <button class="btn btn-secondary btn-small" onclick="window.switchMentoringSubTab('find')">${t('mentoring_tab_find', 'Find Mentors')}</button>
                </div>`;
            return;
        }
        listEl.innerHTML = mentoringThreads.map(renderThreadItem).join('');
        const search = inputValue('mentoring-threads-search-input');
        if (search) filterMentoringThreads(search);
        if (generation !== mentoringChatGeneration) return;
        if (selectThreadId) {
            await openMentoringThread(selectThreadId);
        } else if (shouldSelect || (autoSelect && !isMobile() && !activeMentoringThreadId && isMentoringChatVisible())) {
            // Desktop shows list and chat side by side. Only open a chat the user can see: opening marks its
            // messages as read, which used to clear the unread counts right after login
            await openMentoringThread(mentoringThreads[0].id);
        }
    } catch (err) {
        console.warn('Failed to load mentoring threads:', err);
    }
}

function filterMentoringThreads(text) {
    const q = (text || '').toLowerCase().trim();
    document.querySelectorAll('.mentoring-thread-item').forEach(item => {
        const haystack = ['.mentoring-thread-name', '.mentoring-thread-snippet', '.mentoring-role-pill'].map(sel => (item.querySelector(sel)?.innerText || '').toLowerCase());
        item.style.display = !q || haystack.some(value => value.includes(q)) ? 'flex' : 'none';
    });
}

function autoResizeMentoringInput(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.max(24, Math.min(input.scrollHeight, 110)) + 'px';
}

async function openMentoringThread(threadId) {
    if (!threadId) return;
    activeMentoringThreadId = threadId;
    $('mentoring-threads-layout')?.classList.add('in-chat');
    $('mentoring-chat-pane')?.classList.add('mobile-open');
    if (isMobile()) {
        document.body.classList.add('mentoring-mobile-chat-open');
        if (!mentoringChatHistoryPushed) {
            history.pushState({ view: 'mentoring-chat' }, '');
            mentoringChatHistoryPushed = true;
        }
    }
    document.querySelectorAll('.mentoring-thread-item').forEach(item => item.classList.remove('active'));
    syncUrl();
    const activeEl = threadElement(threadId);
    if (activeEl) {
        activeEl.classList.add('active');
        markThreadElementRead(activeEl);
    }

    let thread = findThread(threadId);
    if (!thread) {
        try {
            const res = await api('/mentoring/threads');
            if (res.ok) {
                const data = await res.json();
                mentoringThreads = Array.isArray(data) ? data : [];
                thread = findThread(threadId);
            }
        } catch (err) {
            console.warn('Failed to reload threads in openMentoringThread:', err);
        }
    }
    const { isMentor, name } = threadPartner(thread);
    const isClosed = thread?.status === 'closed';
    const titleEl = $('mentoring-chat-title');
    if (titleEl) titleEl.innerText = name;
    const subEl = $('mentoring-chat-subtitle');
    if (subEl) {
        subEl.innerText = isClosed ? t('mentoring_sub_closed', 'Conversation ended')
            : isMentor ? t('mentoring_sub_active_seeker', 'Confidential & Anonymous') : t('mentoring_sub_active_mentee', 'Your confidential mentor');
    }
    show('mentoring-chat-menu-dropdown', false);
    if ($('mentoring-chat-actions')) {
        show('mentoring-chat-actions', true, 'flex');
        // Like the Android app: "Report" always; "Block" until blocked, "End" while it is open
        show('mentoring-chat-menu-btn', true, 'inline-flex');
        show('mentoring-menu-block', !thread?.blocked, 'flex');
        show('mentoring-menu-end', !isClosed, 'flex');
    }
    show('mentoring-chat-input-container', !isClosed, 'block');
    show('mentoring-chat-closed-bar', isClosed, 'flex');
    const closedText = $('mentoring-chat-closed-text');
    if (closedText) closedText.textContent = thread?.blocked
        ? (thread.blockedByMe ? t('mentoring_chat_blocked_by_me', 'You blocked this conversation.') : t('mentoring_chat_blocked', 'This conversation has been blocked.'))
        : t('mentoring_chat_closed_info', 'This conversation has ended.');
    show('mentoring-reopen-btn', !thread?.blocked || thread.blockedByMe, 'inline-flex');

    await loadMentoringMessages(threadId);
    autoResizeMentoringInput($('mentoring-chat-input'));
    clearInterval(mentoringChatPollTimer);
    mentoringChatPollTimer = setInterval(() => {
        if (activeMentoringThreadId === threadId && isMentoringChatVisible()) loadMentoringMessages(threadId, true);
    }, 3500);
}

// fromHistory: the chat's history entry is already gone (back gesture or tab switch).
// userBack: the user left the chat (button or gesture), so a chat opened from the start page returns there.
function closeMentoringChatMobile(fromHistory = false, userBack = !fromHistory) {
    mentoringChatGeneration++;
    const hadOpenChat = !!activeMentoringThreadId;
    activeMentoringThreadId = null;
    clearInterval(mentoringChatPollTimer);
    mentoringChatPollTimer = null;
    closeMobileChatPane();
    document.querySelectorAll('.mentoring-thread-item').forEach(item => item.classList.remove('active'));
    const returnHome = userBack && mentoringChatReturnHome;
    mentoringChatReturnHome = false;
    // Pop the chat entry (button) and the tab entry (return home) in one step
    const steps = (!fromHistory && mentoringChatHistoryPushed ? 1 : 0) + (returnHome && tabHistoryPushed ? 1 : 0);
    mentoringChatHistoryPushed = false;
    if (returnHome) tabHistoryPushed = false;
    if (steps > 0) programmaticBack(steps);
    syncUrl();
    if (returnHome) switchTab(HOME_TAB, 'history');
    // Only a chat that was open changes the unread counts; never pick a new chat while closing
    else if (hadOpenChat) loadMentoringThreads(false, null, false);
}

async function loadMentoringMessages(threadId, isPoll = false) {
    const messagesEl = $('mentoring-chat-messages');
    if (!messagesEl) return;
    try {
        const res = await api(`/mentoring/threads/${threadId}/messages`);
        if (!res.ok) {
            if (res.status === 403) messagesEl.innerHTML = `<div style="text-align:center; color:var(--danger); margin:auto; padding:20px;">${t('mentoring_access_denied', 'Access denied (Protected connection).')}</div>`;
            return;
        }
        let messages = await res.json();
        if (Array.isArray(messages?.messages)) messages = messages.messages;
        if (!Array.isArray(messages)) return;
        if (threadId === activeMentoringThreadId) activeMentoringMessages = messages;

        // Mark the thread as read locally so badges and the home card update instantly
        const thread = findThread(threadId);
        if (thread && thread.unread_count > 0) {
            thread.unread_count = 0;
            const item = threadElement(threadId);
            if (item) markThreadElementRead(item);
            updateMentoringUnreadBadge();
        }
        const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop <= messagesEl.clientHeight + 120;
        if (messages.length === 0) {
            messagesEl.innerHTML = `
                <div class="mentoring-chat-empty-notice">
                    <div style="font-size:2rem; margin-bottom:8px;">✨</div>
                    <div style="font-weight:600; margin-bottom:4px;">${t('mentoring_no_messages_yet', 'No messages yet')}</div>
                    <div style="font-size:0.85rem; color:var(--text-secondary);">${t('mentoring_start_conversation_desc', 'Start the conversation! Everything you write is strictly confidential.')}</div>
                </div>`;
            return;
        }
        messagesEl.innerHTML = messages.map(m => {
            const isMe = isCurrentUser(m.sender);
            const time = chatTime(m.created);
            return `
                <div class="mentoring-message ${isMe ? 'outgoing msg-mine' : 'incoming msg-other'}">
                    ${!isMe ? `<div class="mentoring-message-sender">${escapeHtml(m.sender_name || t('mentoring_partner_generic', 'Conversation partner'))}</div>` : ''}
                    <div class="mentoring-message-bubble">${escapeHtml(m.message || m.text || '')}</div>
                    <div class="mentoring-message-time">${escapeHtml(time)}</div>
                </div>`;
        }).join('');
        if (!isPoll || wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
        console.warn('Failed to load messages:', err);
    }
}

/** Time of a chat message: "14:05" today, "3 Nov, 14:05" before (only the time made old messages look new). */
function chatTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    const time = d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' })}, ${time}`;
}

async function sendMentoringMessage() {
    const input = $('mentoring-chat-input');
    const text = input?.value.trim();
    if (!activeMentoringThreadId || !text) return;
    // Show the message optimistically until the server round-trip completes
    const messagesEl = $('mentoring-chat-messages');
    messagesEl.querySelector('.mentoring-chat-empty-notice')?.remove();
    const pending = createEl('div', 'mentoring-message outgoing msg-mine');
    pending.innerHTML = `
        <div class="mentoring-message-bubble">${escapeHtml(text)}</div>
        <div class="mentoring-message-time">${escapeHtml(new Date().toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }))} • ${t('mentoring_sending_optimistic', 'Sending…')}</div>`;
    messagesEl.appendChild(pending);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    input.value = '';
    autoResizeMentoringInput(input);
    try {
        await apiJson(`/mentoring/threads/${activeMentoringThreadId}/messages`, 'POST', { message: text, text }, t('mentoring_send_error', 'Failed to send'));
        await loadMentoringMessages(activeMentoringThreadId);
        loadMentoringThreads(false);
    } catch (err) {
        // Like the Android app: the text is not lost - it goes back into the field to try again
        pending.remove();
        if (!input.value.trim()) {
            input.value = text;
            autoResizeMentoringInput(input);
        }
        showToast(err.message || t('mentoring_send_failed', 'The message could not be sent.'), 'error');
    }
}

function toggleMentoringChatMenu(e) {
    e?.stopPropagation();
    e?.preventDefault();
    const dropdown = $('mentoring-chat-menu-dropdown');
    if (dropdown) dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
}

// Menu actions on the open chat: close the menu, run with the thread, show errors
async function withActiveThread(action) {
    const thread = activeMentoringThreadId && mentoringThreads.find(th => th.id === activeMentoringThreadId);
    if (!thread) return;
    show('mentoring-chat-menu-dropdown', false);
    try {
        await action(thread);
    } catch (err) {
        showToast(err.message || t('mentoring_status_error', 'Failed to update.'), 'error');
    }
}

// 'blocked' closes the chat so that only the blocker can reopen it (Google Play UGC policy)
async function setThreadStatus(thread, status, toast) {
    await apiJson(`/mentoring/threads/${thread.id}/status`, 'PATCH', { status }, t('mentoring_status_error', 'Failed to update.'));
    Object.assign(thread, status === 'blocked' ? { status: 'closed', blocked: true, blockedByMe: true } : { status });
    openMentoringThread(thread.id);
    loadMentoringThreads();
    showToast(toast, 'info');
}

// Report the conversation to the admins with the partner's recent messages
const reportCurrentThread = () => withActiveThread(async thread => {
    const reason = window.prompt(t('mentoring_report_reason', 'Why are you reporting this conversation? The latest messages of the other person are sent to the administrators.'), '');
    if (reason === null) return;
    const partnerRole = thread.myRole === 'mentor' ? 'mentee' : 'mentor';
    const content = activeMentoringMessages.filter(m => m.sender_role === partnerRole).slice(-10).map(m => m.text).join('\n---\n') || t('mentoring_report_no_messages', '(no messages)');
    await apiJson('/reports', 'POST', { type: 'chat', threadId: thread.id, content, reason }, t('report_failed', 'Report failed.'));
    showToast(t('report_sent', 'Reported – thank you!'), 'info');
});

const blockCurrentThread = () => withActiveThread(thread => {
    if (confirmAction(t('mentoring_confirm_block', 'Block this person? The conversation is closed and only you can reopen it.'))) {
        return setThreadStatus(thread, 'blocked', t('mentoring_toast_blocked', 'Conversation blocked.'));
    }
});

const toggleCloseCurrentThread = forcedStatus => withActiveThread(thread => {
    const status = forcedStatus || (thread.status === 'closed' ? 'active' : 'closed');
    const closing = status === 'closed';
    if (!confirmAction(closing
        ? t('mentoring_confirm_close', 'Do you really want to end this conversation? Neither party can send new messages until it is reopened.')
        : t('mentoring_confirm_reopen', 'Do you want to reopen this conversation?'))) return;
    return setThreadStatus(thread, status, closing ? t('mentoring_toast_closed', 'Conversation ended.') : t('mentoring_toast_reopened', 'Conversation reopened.'));
});

function openMentorApplicationModal() {
    setValue('mentor-app-bio', myMentorProfile ? myMentorProfile.bio || '' : '');
    setValue('mentor-app-max', myMentorProfile ? myMentorProfile.max_mentees || 3 : 3);
    const submitBtn = $('btn-submit-mentor-app');
    if (submitBtn) submitBtn.innerText = myMentorProfile ? t('mentor_app_btn_update', 'Update profile') : t('mentor_app_btn_submit', 'Submit application');
    openModal('mentor-application-modal');
}

function submitMentorApplication(e) {
    e?.preventDefault?.();
    return once('mentor-application', () => submitMentorApplicationNow(e));
}
async function submitMentorApplicationNow(e) {
    e?.preventDefault?.();
    const bio = inputValue('mentor-app-bio').trim();
    const max_mentees = $('mentor-app-max') ? parseInt(inputValue('mentor-app-max'), 10) : 3;
    if (!bio) return showToast(t('mentor_app_error_no_bio', 'Please enter a short personal introduction.'), 'error');
    const isUpdate = !!myMentorProfile;
    try {
        const data = await apiJson(isUpdate ? '/mentoring/my-profile' : '/mentoring/apply', isUpdate ? 'PUT' : 'POST', { bio, max_mentees }, t('mentor_app_error_generic', 'The application failed.'));
        myMentorProfile = data.mentor || myMentorProfile;
        closeModal('mentor-application-modal');
        showToast(isUpdate ? t('mentor_app_toast_updated', 'Mentor profile updated!') : t('mentor_app_toast_submitted', 'Application submitted successfully! The leadership will review it.'), 'success');
        loadMentoringData();
    } catch (err) {
        showToast(err.message || t('mentor_app_error_generic', 'The application failed.'), 'error');
    }
}

const MENTOR_STATUS_STYLES = {
    pending: ['rgba(234, 179, 8, 0.15)', '#eab308', 'mentoring_filter_pending', 'Pending'],
    approved: ['rgba(16, 185, 129, 0.15)', '#10b981', 'mentoring_filter_approved', 'Approved'],
    rejected: ['rgba(239, 68, 68, 0.15)', '#ef4444', 'mentoring_filter_rejected', 'Rejected']
};

async function loadMentoringReviewList() {
    const listEl = $('mentoring-review-list');
    if (!canManageMentoring() || !listEl) return;
    const statusFilter = $('mentor-review-filter') ? inputValue('mentor-review-filter') : 'pending';
    const notice = (color, text, padding = 20) => `<div style="text-align:center; padding:${padding}px; color:var(${color});">${text}</div>`;
    listEl.innerHTML = notice('--text-secondary', t('mentoring_review_loading', 'Loading applications...'));
    try {
        const res = await api(`/mentoring/mentors?status=${encodeURIComponent(statusFilter)}`);
        if (!res.ok) {
            listEl.innerHTML = notice('--danger', t('mentoring_review_load_error', 'Failed to load applications.'));
            return;
        }
        const mentors = await res.json();
        if (!Array.isArray(mentors) || mentors.length === 0) {
            listEl.innerHTML = notice('--text-secondary', t('mentoring_review_none', 'No applications with status "{status}" found.', { status: t(`mentoring_filter_${statusFilter}`, statusFilter) }), 30);
            return;
        }
        listEl.innerHTML = mentors.map(m => {
            const status = m.status || 'pending';
            const [bg, color, labelKey, labelFallback] = MENTOR_STATUS_STYLES[status] || MENTOR_STATUS_STYLES.pending;
            const email = escapeHtml(m.email || m.userEmail || '');
            const dateStr = m.created ? new Date(m.created).toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            const statusButton = (target, cls, style, key, fallback) => status === target ? '' : `
                <button type="button" class="btn ${cls} btn-small"${style} onclick="window.setMentorStatus(${jsArg(m.id)}, '${target}')">
                    ${t(key, fallback)}
                </button>`;
            return `
                <div class="card" style="margin-bottom:12px; border:1px solid var(--border); padding:16px; border-radius:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
                        <div>
                            <div style="font-weight:700; font-size:1.05rem; display:flex; align-items:center; gap:8px;">
                                <span>${escapeHtml(m.name || m.mentorName || t('mentoring_applicant_fallback', 'Applicant'))}</span>
                                <span style="font-size:0.75rem; padding:2px 8px; border-radius:999px; background:${bg}; color:${color}; font-weight:700;">
                                    ${t(labelKey, labelFallback)}
                                </span>
                            </div>
                            <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
                                ${email ? `${email} • ` : ''}${t('mentoring_review_submitted', 'Submitted: {date} • Capacity: max. {max} mentees', { date: dateStr, max: m.max_mentees || 3 })}
                            </div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            ${statusButton('approved', 'btn-primary', '', 'mentoring_btn_approve', '✓ Approve')}
                            ${statusButton('rejected', 'btn-secondary', ' style="color:var(--danger);"', 'mentoring_btn_reject', '✗ Reject')}
                        </div>
                    </div>
                    <div style="background:var(--surface-alt); padding:12px 14px; border-radius:8px; font-size:0.92rem; line-height:1.5;">
                        <div style="font-weight: 600; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${t('mentoring_review_bio_label', 'About me / Self-description:')}</div>
                        ${escapeHtml(m.bio || t('mentoring_no_bio', 'No description provided.'))}
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        console.warn('Failed to load review list:', err);
        // Not "Loading applications..." forever
        listEl.innerHTML = notice('--danger', t('mentoring_review_load_error', 'Failed to load applications.'));
    }
}

function setMentorStatus(mentorId, status) {
    return once(`mentor:${mentorId}`, () => setMentorStatusNow(mentorId, status));
}
async function setMentorStatusNow(mentorId, status) {
    const action = status === 'approved' ? t('mentoring_action_approve', 'approve') : t('mentoring_action_reject', 'reject');
    if (!confirmAction(t('mentoring_confirm_status', 'Are you sure you want to {action} this application?', { action }))) return;
    try {
        await apiJson(`/mentoring/manage/${mentorId}/status`, 'POST', { status }, t('mentoring_status_error', 'Failed to update.'));
        showToast(status === 'approved' ? t('mentoring_toast_approved', 'Application approved successfully!') : t('mentoring_toast_rejected', 'Application rejected successfully!'), 'success');
        loadMentoringReviewList();
        loadMentoringData();
    } catch (err) {
        showToast(err.message || t('mentoring_status_error', 'Failed to update.'), 'error');
    }
}

// Home screen teaser for the newest unread conversation (hidden when everything is read)
// Start page: unread conversations as one card - header with the total, up to three chats, link to all
const HOME_MENTORING_ROWS = 3;
function renderHomeMentoringCard() {
    const container = $('user-mentoring-home-card');
    if (!container) return;
    const unread = currentUser && canUseMentoring() ? mentoringThreads.filter(th => (th.unread_count || 0) > 0) : [];
    container.style.display = unread.length ? 'block' : 'none';
    if (unread.length === 0) return void (container.innerHTML = '');
    const total = unread.reduce((sum, th) => sum + th.unread_count, 0);
    const today = new Date().toDateString();
    const when = iso => {
        const d = iso ? new Date(iso) : null;
        if (!d || isNaN(d)) return '';
        return d.toDateString() === today ? d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
    };
    const rows = unread.slice(0, HOME_MENTORING_ROWS).map(thread => {
        const { name, role } = threadPartner(thread);
        // Seekers see their mentor's picture; mentors only know the anonymous alias
        const photoId = isCurrentUser(thread.mentor) ? null : thread.mentor;
        return `
            <button type="button" class="home-msg-row" onclick="window.openMentoringChatDirect(${jsArg(thread.id)}, 'home')">
                ${renderAvatarWrap(photoId, name, { wrapClass: 'home-msg-avatar', imgClass: 'home-msg-avatar-img', initialsClass: 'home-msg-initials' })}
                <span class="home-msg-text">
                    <span class="home-msg-name-line">
                        <span class="home-msg-name">${escapeHtml(name)}</span>
                        <span class="home-msg-time">${escapeHtml(when(thread.lastMessage?.created || thread.updated))}</span>
                    </span>
                    <span class="home-msg-role">${escapeHtml(role)}</span>
                    <span class="home-msg-snippet-line">
                        <span class="home-msg-snippet">${escapeHtml(thread.last_message || t('home_mentoring_new_message', 'New confidential message'))}</span>
                        <span class="home-msg-count">${formatBadgeCount(thread.unread_count)}</span>
                    </span>
                </span>
            </button>`;
    }).join('');
    const more = unread.length - HOME_MENTORING_ROWS;
    container.innerHTML = `
        <div class="home-msg-card">
            <div class="home-msg-head">
                <span class="home-msg-icon">${svgIcon('chat', 18)}</span>
                <span class="home-msg-title">${t('home_messages_title', 'New messages')}</span>
                <span class="home-msg-total">${formatBadgeCount(total)}</span>
                <button type="button" class="home-msg-all" onclick="window.switchTab('mentoring')">${t('home_messages_all', 'All')}${svgIcon('chevronRight', 14, 2.5)}</button>
            </div>
            <div class="home-msg-list">${rows}</div>
            ${more > 0 ? `<div class="home-msg-more">+${more} ${t('home_mentoring_more_unread', 'more unread conversations')}</div>` : ''}
        </div>`;
}

async function openMentoringChatDirect(threadId, source) {
    openingDirectChat = true;
    // Opened from the start page: going back from the chat leads there again (like the Android app)
    mentoringChatReturnHome = source === 'home' && isMobile();
    currentMentoringSubTab = 'chats';
    switchTab('mentoring');
    switchMentoringSubTab('chats');
    await loadMentoringThreads(true, threadId || null);
    // Keep the flag long enough for tab transitions and pending loads
    setTimeout(() => { openingDirectChat = false; }, 400);
}

Object.assign(window, {
    switchMentoringSubTab, openMentorContactModal, submitMentorContact, filterMentoringThreads, autoResizeMentoringInput, openMentoringThread,
    sendMentoringMessage, toggleMentoringChatMenu, toggleCloseCurrentThread, reportCurrentThread, blockCurrentThread, openMentorApplicationModal, submitMentorApplication,
    loadMentoringReviewList, setMentorStatus, openMentoringChatDirect,
    backToMentoringThreadList: closeMentoringChatMobile,
    handleMentoringChatKey: chatKeyHandler(sendMentoringMessage, autoResizeMentoringInput)
});

// --- Events & duty roster ---
let appEvents = [];
let currentEventsSubTab = 'termine';
let eventsSearchQuery = '';
let currentDetailEvent = null;
let myDutyRequests = [];
let eventCandidatesCache = null;
let eventGroupsCache = null;
let showPastEvents = false;
// "Termine" on desktop: month shown in the calendar next to the list, days with entries and the chosen day
let termineCalMonth = null;
let termineCalDays = new Map();
let termineCalSelected = null;

const WEEKDAY_SHORT_BY_LANG = {
    de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
};
const weekdayShort = index => (WEEKDAY_SHORT_BY_LANG[uiLang] || WEEKDAY_SHORT_BY_LANG.de)[index] || '';
const splitDate = dateStr => dateStr.split('-').map(Number);

function isEventPast(ev, todayStr = getTodayStr()) {
    const compareDate = ev.endDate?.trim() || ev.date?.trim() || '';
    return !!compareDate && compareDate < todayStr;
}

function userInGroup(user, groupId) {
    return (Array.isArray(user?.groups) ? user.groups : []).some(g => {
        const isObj = typeof g === 'object' && g;
        return (isObj ? g.id || g.name : String(g)) === groupId || (isObj ? g.name : String(g)) === groupId;
    });
}

// A duty is "mine" when it is assigned/confirmed to me or assigned to one of my groups.
const isMyDuty = d => ((d.assignedUser === currentUid() || d.assignedUser === currentUser?.id) && (d.status === 'confirmed' || d.status === 'assigned'))
    || (d.status === 'assigned' && d.assignedGroup && userInGroup(currentUser, d.assignedGroup));
const hasDutyAssignee = d => Boolean(d.assignedUser || d.requestedUser || d.assignedGroup || d.assignedGroupName);

function getEventCardStatusInfo(ev) {
    const duties = ev.canAccessDutyPlan && Array.isArray(ev.duties) ? ev.duties : null;
    return {
        myDuty: duties ? duties.find(isMyDuty) : null,
        myRequestedDuty: duties ? duties.find(d => (d.requestedUser === currentUid() || d.requestedUser === currentUser?.id) && d.status === 'requested') : null,
        isRegistered: ev.myRegistration?.status === 'registered',
        isWaitlist: ev.myRegistration?.status === 'waitlist',
        openDutiesCount: duties ? duties.filter(d => d.status === 'open' || (!d.assignedUser && !d.assignedGroup && !d.requestedUser)).length : 0
    };
}

const MONTH_SHORT_BY_LANG = {
    de: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
};
const monthShort = index => (MONTH_SHORT_BY_LANG[uiLang] || MONTH_SHORT_BY_LANG.de)[index] || '';

function eventDateParts(dateStr) {
    if (!dateStr) return { dayNum: '--', weekdayStr: '', monthStr: '' };
    const [y, m, d] = splitDate(dateStr);
    return { dayNum: String(d), weekdayStr: weekdayShort(new Date(y, m - 1, d).getDay()), monthStr: monthShort(m - 1) };
}

// "17.–19. Okt." / "30. Sep. – 2. Okt." for list cards (the year is in the month header)
function formatEventDateSpanShort(startDate, endDate) {
    const [, m1, d1] = splitDate(startDate);
    const [, m2, d2] = splitDate(endDate);
    if (uiLang === 'en') return m1 === m2 ? `${d1}–${d2} ${monthShort(m1 - 1)}` : `${d1} ${monthShort(m1 - 1)} – ${d2} ${monthShort(m2 - 1)}`;
    const month = m => `${monthShort(m - 1)}.`;
    return m1 === m2 ? `${d1}.–${d2}. ${month(m1)}` : `${d1}. ${month(m1)} – ${d2}. ${month(m2)}`;
}

// Tear-off calendar leaf: month strip in the category colour, big day number, weekday
function eventCalendarLeaf(dateStr, cls = '') {
    const { dayNum, weekdayStr, monthStr } = eventDateParts(dateStr);
    return `
        <div class="event-cal ${cls}" aria-hidden="true">
            <span class="event-cal-month">${escapeHtml(monthStr)}</span>
            <span class="event-cal-day">${escapeHtml(dayNum)}</span>
            <span class="event-cal-weekday">${escapeHtml(weekdayStr)}</span>
        </div>`;
}

function formatEventDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = splitDate(dateStr);
    return intlFormatter(Intl.DateTimeFormat, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
}

function formatEventDateSpanCompact(startDate, endDate) {
    if (!startDate) return '--';
    const months = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
    const [y1, m1, d1] = splitDate(startDate);
    if (uiLang === 'en') {
        if (!endDate || endDate === startDate) return `${weekdayShort(new Date(y1, m1 - 1, d1).getDay())}, ${d1} ${monthShort(m1 - 1)} ${y1}`;
        const [y2, m2, d2] = splitDate(endDate);
        if (y1 === y2 && m1 === m2) return `${d1} – ${d2} ${monthShort(m1 - 1)} ${y1}`;
        if (y1 === y2) return `${d1} ${monthShort(m1 - 1)} – ${d2} ${monthShort(m2 - 1)} ${y1}`;
        return `${d1} ${monthShort(m1 - 1)} ${y1} – ${d2} ${monthShort(m2 - 1)} ${y2}`;
    }
    if (!endDate || endDate === startDate) return `${weekdayShort(new Date(y1, m1 - 1, d1).getDay())}., ${d1}. ${months[m1 - 1]} ${y1}`;
    const [y2, m2, d2] = splitDate(endDate);
    if (y1 === y2 && m1 === m2) return `${d1}. – ${d2}. ${months[m1 - 1]} ${y1}`;
    if (y1 === y2) return `${d1}. ${months[m1 - 1]} – ${d2}. ${months[m2 - 1]} ${y1}`;
    return `${d1}.${m1}.${y1} – ${d2}.${m2}.${y2}`;
}

const eventTimeRange = (ev, withUhr = true) => ev.startTime ? (ev.endTime
    ? (withUhr ? t('events_time_range', '{start} – {end}', { start: ev.startTime, end: ev.endTime }) : `${ev.startTime} – ${ev.endTime}`)
    : (withUhr ? t('events_time_from', 'from {start}', { start: ev.startTime }) : ev.startTime)) : '';
const eventImage = ev => {
    const raw = ev ? (ev.imageUrl || ev.image || ev.coverUrl || ev.photo || '') : '';
    return typeof raw === 'string' ? raw.trim() : '';
};
const cardIcon = name => svgIcon(name, 12, name === 'chevronRight' ? 2.5 : 2);

// Until the first answer: a spinner, after a failed first load an error with "Try again" (an empty list said
// "nothing coming up"); a later failed refresh keeps what is shown
let eventsLoaded = false;
let eventsLoadError = '';

async function loadEventsData() {
    if (!currentUser) return;
    try {
        // Groups rarely change: a live update of the events reuses them for a few minutes
        // (each refresh used to reload them and redraw the whole account list)
        const [eventsRes, requestsRes] = await Promise.all([
            api('/events'),
            api('/events/my-requests').catch(() => null),
            loadSystemGroups(5 * 60 * 1000)
        ]);
        await picturesReady;
        if (eventsRes.ok) {
            appEvents = await eventsRes.json();
            eventsLoaded = true;
            eventsLoadError = '';
        } else if (!eventsLoaded) {
            eventsLoadError = t('events_load_failed', 'Events could not be loaded');
        }
        myDutyRequests = requestsRes?.ok ? await requestsRes.json() : [];
        renderMyDutyRequests();
        renderEvents();
        renderHomeDutiesCard();
    } catch (err) {
        console.warn('Failed to load events:', err);
        if (!eventsLoaded) {
            eventsLoadError = t('error_connection', 'Connection error');
            renderEvents();
            renderHomeDutiesCard();
        }
    }
}

function switchEventsSubTab(tabName) {
    currentEventsSubTab = tabName === 'events' ? 'events' : 'termine';
    ['termine', 'events'].forEach(key => {
        const btn = $(`events-tab-btn-${key}`);
        btn?.classList.toggle('is-active', currentEventsSubTab === key);
        btn?.classList.toggle('active', currentEventsSubTab === key);
    });
    renderEvents();
}

function dutyRequestBanner(list, onHome) {
    const stop = onHome ? 'event.stopPropagation(); ' : '';
    return `
        <div class="events-requests-banner-content">
            <div class="events-requests-banner-header">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="events-requests-bell">📬</span>
                    <strong style="font-size:0.95rem; color:var(--text);">${t('duty_requests_title', 'Open duty requests for you ({count})', { count: list.length })}</strong>
                </div>
                <span class="events-requests-badge">${t('duty_requests_badge', 'Response requested')}</span>
            </div>
            <div class="events-requests-list">
                ${list.map(req => {
                    const id = escapeHtml(req.id);
                    return `
                    <div class="events-request-card" id="${onHome ? 'home-' : ''}duty-request-${id}">
                        <div class="events-request-info"${onHome ? ` onclick="window.openEventDetailModal(${jsArg(req.eventId)})" role="button" tabindex="0" style="cursor:pointer;" title="${t('duty_requests_show_details', 'Show appointment details')}"` : ''}>
                            <div class="events-request-event-title">📅 ${escapeHtml(req.eventTitle || t('detail_groups_event', 'Event'))}</div>
                            <div class="events-request-event-sub">
                                <span>${escapeHtml(formatEventDate(req.eventDate))}${req.eventStartTime ? ` ${t('duty_requests_at_time', 'at {time}', { time: escapeHtml(req.eventStartTime) })}` : ''}</span>
                            </div>
                            <div class="events-request-role">
                                🛠️ <strong>${escapeHtml(req.roleName)}</strong>
                                <span style="color:var(--text-secondary); font-size:0.8rem;">(${req.section ? `${t('duty_requests_section', 'Area: {section}', { section: escapeHtml(req.section) })} • ` : ''}${t('duty_requests_requested_by', 'Requested by {name}', { name: escapeHtml(req.requestedByName || t('duty_requests_team', 'Team')) })})</span>
                            </div>
                        </div>
                        <div class="events-request-actions">
                            <button type="button" class="btn btn-primary btn-small" onclick="${stop}window.respondToDutyRequest(${jsArg(id)}, 'accept')">
                                ✅ ${t('duty_btn_accept', 'Accept')}
                            </button>
                            <button type="button" class="btn btn-danger btn-small" onclick="${stop}window.respondToDutyRequest(${jsArg(id)}, 'decline')">
                                ❌ ${t('request_btn_reject', 'Reject')}
                            </button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
}

function renderMyDutyRequests() {
    const banner = $('events-my-requests-banner');
    if (!banner) return;
    const list = Array.isArray(myDutyRequests) ? myDutyRequests : [];
    banner.style.display = list.length ? 'block' : 'none';
    banner.innerHTML = list.length ? dutyRequestBanner(list, false) : '';
}

// Home screen: open duty requests plus upcoming events where I have a duty
function renderHomeDutiesCard() {
    const container = $('user-duties-home-card');
    if (!container) return;
    const todayStr = getTodayStr();
    const openRequests = currentUser && Array.isArray(myDutyRequests) ? myDutyRequests.filter(req => req && !(req.eventDate && req.eventDate < todayStr)) : [];
    const dutyEvents = currentUser ? appEvents.filter(ev => ev && ev.status !== 'cancelled' && !isEventPast(ev, todayStr) && Array.isArray(ev.duties) && ev.duties.some(d => d && isMyDuty(d))) : [];
    dutyEvents.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
    const requests = $('home-duty-requests');
    if (requests) {
        requests.style.display = openRequests.length ? 'block' : 'none';
        requests.innerHTML = openRequests.length ? `<div class="events-requests-banner">${dutyRequestBanner(openRequests, true)}</div>` : '';
    }
    renderHomeUpcoming();
    // Own duties get their own section below the "next" row (commitments, not offers)
    container.style.display = dutyEvents.length ? 'block' : 'none';
    container.innerHTML = dutyEvents.length ? `
        <div class="home-section-head"><h2>${t('home_your_duties', 'Your duties')}</h2></div>
        <div class="events-feed-list">
            ${dutyEvents.map(ev => renderEventCard(ev, 'home-duty-card-')).join('')}
        </div>` : '';
}

// --- Start page: greeting, "Als Nächstes" row, compact payment state ---
function renderHomeGreeting() {
    const hour = new Date().getHours();
    const hello = hour < 11 ? t('home_greeting_morning', 'Good morning') : hour < 18 ? t('home_greeting_day', 'Hello') : t('home_greeting_evening', 'Good evening');
    const first = (currentUser?.firstName || fullName(currentUser) || currentUser?.name || '').trim().split(/\s+/)[0];
    setText('home-greeting-title', first ? `${hello}, ${first} 👋` : `${hello} 👋`);
    setText('home-greeting-date', new Date().toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long' }));
    fitHomeGreeting();
}

// The greeting stays on one line: a long name makes the text smaller instead of wrapping
// (watches the width of the box around it: its own height changes with the font size)
let greetingObserver = null;
let greetingWidth = 0;
function fitHomeGreeting(force = true) {
    const el = $('home-greeting-title');
    if (!el) return;
    if (!greetingObserver && 'ResizeObserver' in window && el.parentElement) {
        greetingObserver = new ResizeObserver(() => fitHomeGreeting(false));
        greetingObserver.observe(el.parentElement);
    }
    const width = el.clientWidth;
    if (!width || (!force && width === greetingWidth)) return;
    greetingWidth = width;
    el.style.fontSize = '';
    if (el.scrollWidth <= width) return;
    const base = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(14, Math.floor(base * width / el.scrollWidth * 2) / 2)}px`;
}

const HOME_UPCOMING_COUNT = 5;

// "Heute", "Morgen", the weekday within a week, else "17. Okt."
function homeDayLabel(dateStr, todayStr) {
    if (dateStr <= todayStr) return t('home_today', 'Today');
    const [y, m, d] = splitDate(dateStr);
    const date = new Date(y, m - 1, d);
    const [ty, tm, td] = splitDate(todayStr);
    const days = Math.round((date - new Date(ty, tm - 1, td)) / 86400000);
    if (days === 1) return t('home_tomorrow', 'Tomorrow');
    if (days < 7) return date.toLocaleDateString(uiLocale(), { weekday: 'long' });
    return date.toLocaleDateString(uiLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

// Next appointments and events (also invitations to register) as swipeable cards; returns the shown events
function renderHomeUpcoming() {
    const container = $('home-upcoming');
    if (!container) return [];
    const todayStr = getTodayStr();
    const startOf = ev => (ev.date < todayStr ? todayStr : ev.date);
    const upcoming = currentUser ? appEvents
        .filter(ev => ev && ev.date && ev.status !== 'cancelled' && !isEventPast(ev, todayStr))
        .sort((a, b) => startOf(a).localeCompare(startOf(b)) || (a.startTime || '').localeCompare(b.startTime || ''))
        .slice(0, HOME_UPCOMING_COUNT) : [];
    container.style.display = currentUser ? 'block' : 'none';
    if (!eventsLoaded) {
        container.innerHTML = `<div class="home-section-head"><h2>${t('home_next', 'Up next')}</h2></div>${eventsNotLoaded()}`;
        return [];
    }
    if (!upcoming.length) {
        container.innerHTML = `
            <div class="home-section-head"><h2>${t('home_next', 'Up next')}</h2></div>
            <div class="home-next-empty">${t('home_next_empty', 'Nothing coming up right now – enjoy the free time! 🌿')}</div>`;
        return [];
    }
    const cards = upcoming.map(ev => {
        const id = escapeHtml(ev.id);
        const isMultiDay = ev.endDate && ev.endDate !== ev.date;
        const isEvent = ev.eventType ? ev.eventType === 'event' : !ev.isOfficialTermin;
        const cat = ev.isPinned && isEvent ? 'cat-pinned' : isEvent ? 'cat-event' : 'cat-termin';
        const image = eventImage(ev);
        const day = homeDayLabel(startOf(ev), todayStr);
        const time = isMultiDay ? formatEventDateSpanShort(ev.date, ev.endDate) : (ev.startTime ? ev.startTime : t('home_all_day', 'All day'));
        const { myDuty, isRegistered, isWaitlist } = getEventCardStatusInfo(ev);
        const chip = myDuty ? `<span class="home-next-chip chip-duty">${cardIcon('user')}${escapeHtml(myDuty.roleName || t('events_duty', 'Duty'))}</span>`
            : isRegistered ? `<span class="home-next-chip chip-registered">${cardIcon('check')}${t('home_registered', 'Registered')}</span>`
            : isWaitlist ? `<span class="home-next-chip chip-waitlist">${t('home_waitlist', 'Waiting list')}</span>`
            : ev.requiresRegistration && !ev.isFull ? `<span class="home-next-chip chip-open">${t('home_register_open', 'Registration open')}</span>`
            : '';
        return `
            <div class="home-next-card ${cat}" role="button" tabindex="0" onclick="window.openEventDetailModal(${jsArg(id)})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openEventDetailModal('${id}');}">
                <div class="home-next-cover">
                    ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : `<div class="home-next-fallback">${svgIcon(isEvent ? 'calendar' : 'clock', 22)}</div>`}
                    <span class="home-next-day${day === t('home_today', 'Today') ? ' is-today' : ''}">${escapeHtml(day)}</span>
                </div>
                <div class="home-next-body">
                    <div class="home-next-when">${cardIcon(isMultiDay ? 'calendar' : 'clock')}<span>${escapeHtml(time)}</span></div>
                    <div class="home-next-title">${escapeHtml(ev.title)}</div>
                    ${ev.location ? `<div class="home-next-where">${cardIcon('location')}<span>${escapeHtml(ev.location)}</span></div>` : ''}
                    ${chip}
                </div>
            </div>`;
    }).join('');
    container.innerHTML = `
        <div class="home-section-head">
            <h2>${t('home_next', 'Coming up')}</h2>
            <button type="button" class="home-section-link" onclick="window.switchTab('events'); window.switchEventsSubTab('termine')">${t('home_messages_all', 'All')}${svgIcon('chevronRight', 14, 2.5)}</button>
        </div>
        <div class="home-next-scroller">${cards}</div>`;
    return upcoming;
}

// Nothing when all is paid; a slim amber line when a payment is due soon; a clear red card with the open amount
// when a payment is overdue (moved up)
function renderHomePaymentStatus(container, p, meta, statusText) {
    const state = meta.isOverdue ? 'overdue' : meta.isSoonDue ? 'soon' : 'ok';
    if (state === 'ok') {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }
    const title = state === 'overdue' ? statusText
        : standingOrderCovers(meta) ? t('user_standing_order_active', 'Standing order active')
        : `${t('user_paid_until', 'Paid until')} ${escapeHtml(paidUntilText(personPaidUntil(p)))}`;
    const sub = state === 'overdue' ? `${euro(p._overdueAmount || 0)} ${t('home_fee_open', 'open')}`
        : state === 'soon' ? statusText : t('home_fee_ok', 'Membership fee');
    container.style.display = 'block';
    container.innerHTML = `
        <div class="home-pay home-pay-${state}" role="button" tabindex="0" onclick="window.switchTab('user-finances')"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.switchTab('user-finances');}">
            <span class="home-pay-icon">${svgIcon(state === 'ok' ? 'check' : 'alert', 18, 2.5)}</span>
            <span class="home-pay-text">
                <span class="home-pay-title">${title}</span>
                <span class="home-pay-sub">${sub}</span>
            </span>
            ${state === 'overdue' ? `<span class="home-pay-action">${t('home_fee_details', 'View')}</span>` : svgIcon('chevronRight', 16, 2.5)}
        </div>`;
    // Overdue comes first after the greeting, otherwise it closes the page
    const home = $('user-overview');
    if (!home) return;
    if (state === 'overdue') home.insertBefore(container, $('home-duty-requests'));
    else home.appendChild(container);
}

function refreshDetailEvent(openDuties) {
    // Only while the event is open: answering a duty request on the home page used to reopen the last event viewed
    if (!currentDetailEvent || !shownModal('event-detail-modal')) return;
    openEventDetailModal(currentDetailEvent.id);
    const details = $('detail-modal-duties-details');
    if (openDuties && details) details.open = true;
}

// Runs an event API call, reports the outcome as toast, reloads events and refreshes the open detail modal.
// The same call twice (a double tap) runs once, see once()
function eventAction(path, method, body, options) {
    return once(`${method} ${path}`, () => runEventAction(path, method, body, options));
}
async function runEventAction(path, method, body, { success, successType = 'success', error, useServerError = true, networkError = t('error_connection', 'Connection error'), before, after = () => refreshDetailEvent(true) }) {
    try {
        const res = await api(path, method, body);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast((useServerError && data.error) || error, 'error');
        await before?.();
        showToast(typeof success === 'function' ? success(data) : success, typeof successType === 'function' ? successType(data) : successType);
        await loadEventsData();
        await after();
    } catch {
        showToast(networkError, 'error');
    }
}

const respondToDutyRequest = (dutyId, action) => eventAction(`/events/duties/${dutyId}/respond`, 'POST', { action }, {
    success: action === 'accept' ? t('duty_toast_accepted', 'Duty accepted! You are now assigned to this event.') : t('duty_toast_declined', 'Duty request declined.'),
    successType: action === 'accept' ? 'success' : 'info',
    error: t('duty_respond_error', 'Failed to respond to the duty request'),
    after: () => refreshDetailEvent(false)
});

async function loadEventCandidates() {
    if (eventCandidatesCache) return eventCandidatesCache;
    try {
        const res = await api('/events/candidates');
        if (res.ok) {
            const data = await res.json();
            eventCandidatesCache = Array.isArray(data) ? data : data.candidates || [];
            eventGroupsCache = Array.isArray(data) ? [] : data.groups || [];
            return eventCandidatesCache;
        }
    } catch (err) {
        console.warn('Failed to fetch event candidates:', err);
    }
    return [];
}

function setEventsSearch(value) {
    eventsSearchQuery = (value || '').toLowerCase().trim();
    show('events-search-clear', !!eventsSearchQuery, 'block');
    renderEvents();
}

function getFilteredEvents(todayStr) {
    const matches = text => (text || '').toLowerCase().includes(eventsSearchQuery);
    return appEvents.filter(ev => {
        const duties = Array.isArray(ev.duties) ? ev.duties : [];
        if (currentEventsSubTab === 'termine') {
            if (isEventPast(ev, todayStr)) return false;
            const isRegistered = ev.myRegistration?.status === 'registered' || ev.myRegistration?.status === 'waitlist';
            // Mine like on the home page: my duties, my group's, and open requests to me (not declined ones)
            const hasDuty = duties.some(d => isMyDuty(d) || (isCurrentUser(d.requestedUser) && d.status === 'requested'));
            // Registration events only show up in "Termine" for participants; pinned highlights live on the events tab
            if (ev.requiresRegistration ? !isRegistered && !hasDuty : ev.isPinned && ev.eventType !== 'termin' && !hasDuty) return false;
        } else if (ev.eventType === 'termin' && !ev.isPinned) {
            return false;
        }
        return !eventsSearchQuery || matches(ev.title) || matches(ev.location) || matches(ev.description)
            || duties.some(d => matches(d.roleName) || matches(d.assignedGroupName) || matches(d.assignedUserName));
    });
}

// "Termine": a multi-day event gets one entry per remaining day (from today on), each with its own day
function expandEventDays(list, todayStr) {
    return list.flatMap(ev => {
        if (!ev.date || !ev.endDate || ev.endDate <= ev.date) return [ev];
        const days = [];
        const [y, m, d] = splitDate(ev.date > todayStr ? ev.date : todayStr);
        for (let date = new Date(y, m - 1, d); toDateStr(date) <= ev.endDate && days.length < 366; date.setDate(date.getDate() + 1)) {
            days.push({ ...ev, _day: toDateStr(date) });
        }
        return days;
    });
}

const eventsNotLoaded = () => (eventsLoadError ? `
    <div class="polls-empty">
        <span class="polls-empty-icon">${svgIcon('calendar', 26, 1.8)}</span>
        <span class="polls-empty-title">${escapeHtml(eventsLoadError)}</span>
        <button type="button" class="btn btn-secondary" onclick="window.loadEventsData()">${t('btn_retry', 'Try again')}</button>
    </div>` : '<div class="polls-loading"><span class="spinner"></span></div>');

function renderEvents() {
    const container = $('events-list-container');
    if (!container) return;
    if (!eventsLoaded) {
        container.innerHTML = eventsNotLoaded();
        return;
    }
    const todayStr = getTodayStr();
    const isEventsTab = currentEventsSubTab === 'events';
    const filtered = getFilteredEvents(todayStr);
    const upcoming = isEventsTab ? filtered.filter(ev => !isEventPast(ev, todayStr)) : expandEventDays(filtered, todayStr);
    const past = isEventsTab ? filtered.filter(ev => isEventPast(ev, todayStr)) : [];
    const listClass = isEventsTab ? 'events-cards-grid' : 'events-feed-list';

    past.sort((a, b) => (b.endDate || b.date || '').localeCompare(a.endDate || a.date || '') || (b.startTime || '').localeCompare(a.startTime || ''));
    const pastSection = past.length === 0 ? '' : `
        <div class="events-past-toggle-wrap">
            <button type="button" class="events-past-toggle-btn" onclick="window.toggleShowPastEvents()">
                <span style="font-size: 0.72rem;">${showPastEvents ? '▲' : '▼'}</span>
                <span>${showPastEvents ? t('events_past_hide', 'Hide past events ({count})', { count: past.length }) : t('events_past_show', 'Show past events ({count})', { count: past.length })}</span>
            </button>
            ${showPastEvents ? `
                <div style="width: 100%; margin-top: 22px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 0 4px;">
                        <span style="font-size: 0.84rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">
                            ${t('events_past_title', 'Past events ({count})', { count: past.length })}
                        </span>
                        <span style="font-size: 0.76rem; color: var(--text-secondary);">${t('events_past_hint', 'Hidden until deleted manually')}</span>
                    </div>
                    <div class="events-cards-grid">
                        ${past.map(ev => renderChurchtoolsEventCard(ev, true)).join('')}
                    </div>
                </div>` : ''}
        </div>`;

    if (upcoming.length === 0) {
        container.innerHTML = `
            <div class="card" style="padding: 48px 20px; text-align: center; color: var(--text-secondary); border-radius: 16px;">
                <div style="font-size: 2.2rem; margin-bottom: 8px;">📅</div>
                <div style="font-weight: 700; font-size: 1.05rem; color: var(--text); margin-bottom: 4px;">${isEventsTab ? t('events_empty_events', 'No upcoming events found') : t('events_empty_termine', 'No matching appointments found')}</div>
                ${eventsSearchQuery ? `<div style="font-size: 0.88rem; margin-bottom: 14px;">${t('events_empty_search', 'Try a different search.')}</div>` : ''}
                ${currentUser ? `<div${eventsSearchQuery ? '' : ' style="margin-top: 14px;"'}>
                    <button type="button" class="btn btn-primary btn-small" onclick="window.openNewEventDetailModal('${isEventsTab || !canManageEvents() ? 'event' : 'termin'}')">+ ${isEventsTab || !canManageEvents() ? t('events_btn_new', 'New Event') : t('events_new_termin', 'New Appointment')}</button>
                </div>` : ''}
            </div>
            ${pastSection}`;
        return;
    }

    // Events tab: pinned highlights first; Termine: purely by day
    upcoming.sort((a, b) => (isEventsTab ? Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)) : 0) || (a._day || a.date || '').localeCompare(b._day || b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
    const group = (title, items, render, extraClass = '') => `
        <div class="events-month-group${extraClass}">
            <div class="events-month-header">
                <span>${title}</span>
                <span class="events-month-count">(${items.length})</span>
            </div>
            <div class="${listClass}">
                ${items.map(render).join('')}
            </div>
        </div>`;
    const byMonth = (list, render) => [...groupBy(list, ev => ((ev._day || ev.date) ? (ev._day || ev.date).substring(0, 7) : t('events_no_date', 'No date')))].map(([key, items]) => {
        const [y, m] = key.split('-').map(Number);
        return group(escapeHtml(key.includes('-') ? monthYearFormatter.format(new Date(y, m - 1, 1)) : key), items, render);
    }).join('');
    const ctCard = ev => renderChurchtoolsEventCard(ev, false);
    const pinned = upcoming.filter(ev => ev.isPinned);
    if (isEventsTab) {
        container.innerHTML = (pinned.length ? group(t('events_tab_pinned', 'Highlights'), pinned, ctCard, ' events-highlights-group') : '')
            + byMonth(upcoming.filter(ev => !ev.isPinned), ctCard) + pastSection;
        return;
    }
    // Termine: one list below each other; on desktop a month calendar on the left jumps to a day
    termineCalDays = new Map();
    upcoming.forEach(ev => {
        const day = ev._day || ev.date;
        if (!day) return;
        if (!termineCalDays.has(day)) termineCalDays.set(day, new Set());
        termineCalDays.get(day).add(eventCategory(ev));
    });
    container.innerHTML = `
        <div class="termine-layout">
            <aside class="termine-cal" id="termine-cal" aria-label="${t('events_calendar', 'Calendar')}"></aside>
            <div class="termine-list">${byMonth(upcoming, ev => renderEventCard(ev, undefined, ev._day))}</div>
        </div>`;
    renderTermineCalendar();
}

// Month calendar next to the appointment list (desktop): one dot per category on days with entries
function renderTermineCalendar() {
    const target = $('termine-cal');
    if (!target) return;
    const todayStr = getTodayStr();
    const [ty, tm] = splitDate(todayStr);
    if (!termineCalMonth) termineCalMonth = new Date(ty, tm - 1, 1);
    const year = termineCalMonth.getFullYear();
    const month = termineCalMonth.getMonth();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = Array.from({ length: lead }, () => '<span class="termine-cal-day is-empty"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
        const day = toDateStr(new Date(year, month, d));
        const cats = termineCalDays.get(day);
        const isPast = day < todayStr;
        const classes = ['termine-cal-day', cats ? 'has-entries' : '', day === todayStr ? 'is-today' : '', isPast ? 'is-past' : '', day === termineCalSelected ? 'is-selected' : ''].filter(Boolean).join(' ');
        const dots = cats ? `<span class="termine-cal-dots">${['cat-pinned', 'cat-event', 'cat-termin'].filter(c => cats.has(c)).map(c => `<span class="termine-cal-dot ${c}"></span>`).join('')}</span>` : '';
        cells.push(`<button type="button" class="${classes}" data-day="${day}" onclick="window.jumpToTermineDay(this.dataset.day)"${isPast ? ' disabled' : ''}><span class="termine-cal-num">${d}</span>${dots}</button>`);
    }
    const atCurrentMonth = year === ty && month === tm - 1;
    const legend = [['cat-termin', t('detail_groups_termin', 'Appointment')], ['cat-event', t('detail_groups_event', 'Event')], ['cat-pinned', t('events_major_event', 'Major event')]]
        .map(([c, label]) => `<span class="termine-cal-legend-item"><span class="termine-cal-dot ${c}"></span>${label}</span>`).join('');
    target.innerHTML = `
        <div class="termine-cal-head">
            <button type="button" class="termine-cal-nav" onclick="window.shiftTermineMonth(-1)"${atCurrentMonth ? ' disabled' : ''} aria-label="${t('events_calendar_prev', 'Previous month')}">${svgIcon('chevronLeft', 18, 2.5)}</button>
            <span class="termine-cal-title">${escapeHtml(monthYearFormatter.format(termineCalMonth))}</span>
            <button type="button" class="termine-cal-nav" onclick="window.shiftTermineMonth(1)" aria-label="${t('events_calendar_next', 'Next month')}">${svgIcon('chevronRight', 18, 2.5)}</button>
        </div>
        <div class="termine-cal-grid">
            ${[1, 2, 3, 4, 5, 6, 0].map(i => `<span class="termine-cal-wd">${weekdayShort(i)}</span>`).join('')}
            ${cells.join('')}
        </div>
        <div class="termine-cal-legend">${legend}</div>`;
}

function shiftTermineMonth(delta) {
    termineCalMonth = new Date(termineCalMonth.getFullYear(), termineCalMonth.getMonth() + delta, 1);
    renderTermineCalendar();
}

// Scrolls the list to the first appointment on (or after) the chosen day and highlights that day's cards briefly
function jumpToTermineDay(day) {
    termineCalSelected = day;
    renderTermineCalendar();
    const cards = [...document.querySelectorAll('#events .termine-list .event-card[data-day]')];
    const first = cards.find(card => card.dataset.day === day) || cards.find(card => card.dataset.day > day);
    if (!first) return;
    // Scrolling down hides the header, scrolling up brings it back: keep the card clear of it
    const scroller = document.querySelector('.container');
    if (!scroller) return;
    const distance = first.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const header = document.querySelector('.header');
    const offset = distance < 0 ? (header?.offsetHeight || 0) + 20 : 20;
    scroller.scrollTo({ top: scroller.scrollTop + distance - offset, behavior: 'smooth' });
    cards.filter(card => card.dataset.day === first.dataset.day).forEach(card => {
        card.classList.remove('is-jump-target');
        void card.offsetWidth;
        card.classList.add('is-jump-target');
    });
}

const statusBadge = (cls, content, title = '') => `<span class="event-card-status ${cls}"${title ? ` title="${title}"` : ''}>${content}</span>`;

// Large cover card used on the events tab
function renderChurchtoolsEventCard(ev, forcePast = false) {
    const isPast = forcePast || isEventPast(ev);
    const isPinned = Boolean(ev.isPinned);
    const isMultiDay = ev.endDate && ev.endDate !== ev.date;
    const timeDisplay = !isMultiDay ? eventTimeRange(ev) : '';
    const { myDuty, myRequestedDuty, isRegistered, isWaitlist } = getEventCardStatusInfo(ev);
    const status = isPast ? statusBadge('status-past', `⌛ ${t('events_status_past', 'Over')}`)
        : myDuty ? statusBadge('status-duty', `${cardIcon('user')}<span>${escapeHtml(myDuty.roleName || t('events_duty', 'Duty'))}</span>`)
        : myRequestedDuty ? statusBadge('status-requested', `${cardIcon('clock')}<span>${t('events_status_request_open', 'Request pending')}</span>`)
        : isWaitlist ? statusBadge('status-waitlist', `<span>${t('home_waitlist', 'Waiting list')}</span>`)
        : ev.requiresRegistration && ev.isFull && !ev.myRegistration ? statusBadge('status-full', `<span>${t('events_status_full', 'Fully booked')}</span>`) : '';
    // Own registration sits next to the title (below the picture), independent of the picture's status label
    const registeredBadge = isRegistered && !isPast ? statusBadge('status-registered', `${cardIcon('check')}<span>${t('home_registered', 'Registered')}</span>`, t('events_reg_you_are_registered', 'You are registered')) : '';
    const regCount = ev.registeredCount || 0;
    const max = ev.maxParticipants || 0;
    const footerBadges = !ev.requiresRegistration ? `<span class="ct-footer-pill-muted">${t('events_no_registration', 'No registration')}</span>`
        : max > 0 ? `
            <div class="ct-capacity-wrap" title="${t('events_capacity_taken', '{count} of {max} places taken', { count: regCount, max })}">
                <span class="ct-capacity-text">${t('events_capacity_short', '{count}/{max} places', { count: regCount, max })}</span>
                <div class="ct-capacity-track"><div class="ct-capacity-bar" style="width:${Math.min(100, Math.round((regCount / max) * 100))}%;"></div></div>
            </div>` : `<span class="ct-footer-pill">${t('events_registered_count', '{count} registered', { count: regCount })}</span>`;
    const metaRow = (icon, text, extra = '') => `<div class="ct-event-card-meta-row${extra}">${cardIcon(icon)}<span>${escapeHtml(text)}</span></div>`;
    return `
        <div class="churchtools-event-card ${isPinned ? 'is-pinned' : ''} ${isPast ? 'is-past' : ''}" id="event-card-${escapeHtml(ev.id)}" onclick="window.openEventDetailModal(${jsArg(ev.id)})" role="button" tabindex="0" onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();this.click();}">
            <div class="ct-event-card-cover-wrap">
                ${ev.imageUrl
                    ? `<img class="ct-event-card-cover-img" src="${escapeHtml(ev.imageUrl)}" alt="${escapeHtml(ev.title)}" loading="lazy">`
                    : `<div class="ct-event-card-fallback-cover"><div class="ct-fallback-icon-wrap">${cardIcon('calendar')}</div></div>`}
                ${eventCalendarLeaf(ev.date, `ct-event-card-date-badge ${isPinned ? 'cat-pinned' : 'cat-event'}`)}
                <div class="ct-event-card-badges-floating"><span class="event-card-top-label ${isPinned ? 'label-pinned' : 'label-event'}">${isPinned ? t('events_major_event', 'Major event') : t('detail_groups_event', 'Event')}</span>${status}</div>
            </div>
            <div class="ct-event-card-body">
                <div class="ct-event-card-title-row">
                    <div class="ct-event-card-title">${escapeHtml(ev.title)}</div>
                    ${registeredBadge}
                </div>
                <div class="ct-event-card-meta">
                    ${isMultiDay ? metaRow('calendar', formatEventDateSpanShort(ev.date, ev.endDate), ' multiday-row') : ''}
                    ${timeDisplay ? metaRow('clock', timeDisplay) : ''}
                    ${ev.location ? metaRow('location', ev.location) : ''}
                </div>
                <div class="ct-event-card-footer">
                    <div>${footerBadges}</div>
                    <div class="ct-details-btn" title="${t('modal_details_title', 'Details')}" aria-hidden="true">${svgIcon('chevronRight', 18, 2.5)}</div>
                </div>
            </div>
        </div>`;
}

// Category of an event card: pinned highlight, event or plain appointment (colour of stripe, leaf and calendar dot)
function eventCategory(ev) {
    const isEvent = ev.eventType ? ev.eventType === 'event' : !ev.isOfficialTermin;
    return isEvent && ev.isPinned ? 'cat-pinned' : isEvent ? 'cat-event' : 'cat-termin';
}

// Compact list card used for appointments and on the home screen: calendar leaf, title, one "when" line,
// location and at most one status badge; the category colour shows as leaf strip and left accent
// day: the calendar day this card stands for (multi-day events get one card per day in "Termine")
function renderEventCard(ev, idPrefix = 'event-card-', day = ev.date) {
    const timeDisplay = eventTimeRange(ev);
    const todayStr = getTodayStr();
    const isToday = day === todayStr;
    const isPast = isEventPast(ev, todayStr);
    const isMultiDay = ev.endDate && ev.endDate !== ev.date;
    const category = eventCategory(ev);
    const isEvent = category !== 'cat-termin';
    const isPinned = category === 'cat-pinned';
    const { myDuty, myRequestedDuty, isRegistered, isWaitlist, openDutiesCount } = getEventCardStatusInfo(ev);
    let status = '';
    if (myDuty) {
        const viaGroup = myDuty.assignedGroup && userInGroup(currentUser, myDuty.assignedGroup) && !isCurrentUser(myDuty.assignedUser);
        const label = viaGroup ? (myDuty.assignedGroupName || myDuty.assignedGroup || myDuty.roleName || t('events_duty', 'Duty')) : (myDuty.roleName || t('events_duty', 'Duty'));
        status = statusBadge('status-duty', `${cardIcon('user')}<span>${escapeHtml(label)}</span>`, t('events_status_assigned_duty', 'Assigned duty'));
    } else if (myRequestedDuty) {
        status = statusBadge('status-requested', `${cardIcon('clock')}<span>${t('events_status_request_open', 'Request pending')}</span>`, t('events_status_duty_request_open', 'Duty request pending'));
    } else if (isWaitlist) {
        status = statusBadge('status-waitlist', `${cardIcon('alert')}<span>${t('home_waitlist', 'Waiting list')}</span>`, t('events_status_on_waitlist', 'On the waiting list'));
    } else if (!isRegistered && openDutiesCount > 0 && ev.canAccessDutyPlan) {
        status = statusBadge('status-open-duties', `<span>${openDutiesCount === 1 ? t('events_duty_free_one', '1 duty open') : t('events_duty_free_many', '{count} duties open', { count: openDutiesCount })}</span>`, t('events_duties_open_title', '{count} open duties', { count: openDutiesCount }));
    } else if (!isRegistered && ev.requiresRegistration && ev.isFull) {
        status = statusBadge('status-full', `<span>${t('events_status_full', 'Fully booked')}</span>`);
    }
    const when = isMultiDay ? formatEventDateSpanShort(ev.date, ev.endDate) : (timeDisplay || t('home_all_day', 'All day'));
    const categoryLabel = isPinned ? t('events_major_event', 'Major event') : isEvent ? t('detail_groups_event', 'Event') : t('detail_groups_termin', 'Appointment');
    return `
        <div class="event-card ${category} ${isPast ? 'is-past' : ''} ${isToday ? 'is-today' : ''}" id="${idPrefix}${escapeHtml(ev.id)}${day !== ev.date ? '-' + escapeHtml(day) : ''}" data-day="${escapeHtml(day || '')}" title="${categoryLabel}" onclick="window.openEventDetailModal(${jsArg(ev.id)})" role="button" tabindex="0" onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();this.click();}">
            ${eventCalendarLeaf(day)}
            <div class="event-card-body">
                <div class="event-card-title">${escapeHtml(ev.title)}</div>
                <div class="event-card-when">
                    ${isToday ? `<span class="event-card-today">${t('home_today', 'Today')}</span>` : ''}
                    ${cardIcon(isMultiDay ? 'calendar' : 'clock')}<span class="event-card-when-text">${escapeHtml(when)}</span>
                    ${status ? `<span class="event-card-when-sep" aria-hidden="true">·</span>${status}` : ''}
                </div>
                ${ev.location ? `<div class="event-card-where">${cardIcon('location')}<span>${escapeHtml(ev.location)}</span></div>` : ''}
            </div>
            <div class="event-card-right">
                <div class="event-card-arrow">${cardIcon('chevronRight')}</div>
            </div>
        </div>`;
}

// --- Event detail modal ---
const detailCard = () => document.querySelector('.event-detail-modal-card');

function setCoverVisible(visible) {
    show('detail-modal-cover-wrap', visible, 'block');
    detailCard()?.classList.toggle('has-hero-image', visible);
}

function showDetailCover(src, watchLoading = false) {
    const img = $('detail-modal-cover-img');
    if (img) {
        img.src = src;
        if (src && watchLoading) {
            img.onload = () => setCoverVisible(true);
            img.onerror = () => setCoverVisible(false);
        }
    }
    setCoverVisible(!!src);
}

function hideTypeSelector() {
    const wrap = $('detail-edit-type-container');
    if (!wrap) return;
    wrap.style.display = 'none';
    wrap.classList.add('is-hidden');
}

function syncTypeSelector(canManage) {
    const wrap = $('detail-edit-type-container');
    if (!wrap) return;
    wrap.classList.toggle('can-manage-events', canManage);
    wrap.classList.toggle('is-hidden', !canManage);
    wrap.style.removeProperty('display');
}

function setTextWithTitle(id, text) {
    const target = $(id);
    if (!target) return;
    target.textContent = text;
    target.title = text;
}

// The place stays on one line like the date: a long address makes the text smaller instead of
// wrapping, ellipsis below the smallest size (watches the width of the box around it, as the greeting)
let detailWhereObserver = null;
let detailWhereWidth = 0;
function fitDetailWhere(force = true) {
    const el = $('detail-modal-info-where');
    if (!el) return;
    if (!detailWhereObserver && 'ResizeObserver' in window && el.parentElement) {
        detailWhereObserver = new ResizeObserver(() => fitDetailWhere(false));
        detailWhereObserver.observe(el.parentElement);
    }
    const width = el.clientWidth;
    if (!width || (!force && width === detailWhereWidth)) return;
    detailWhereWidth = width;
    el.style.fontSize = '';
    if (el.scrollWidth <= width) return;
    const base = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(11, Math.floor(base * width / el.scrollWidth * 2) / 2)}px`;
}

function setDescriptionToggle(expanded) {
    setText('detail-desc-toggle-text', expanded ? t('events_show_less', 'Show less') : t('events_show_more', 'Show more'));
    const icon = $('detail-desc-toggle-icon');
    if (icon) icon.style.transform = `rotate(${expanded ? 180 : 0}deg)`;
}

function toggleDetailDescription() {
    const wrap = $('detail-modal-desc-wrap');
    if (!wrap) return;
    const expand = wrap.classList.contains('is-clamped');
    wrap.classList.toggle('is-clamped', !expand);
    wrap.classList.toggle('is-expanded', expand);
    setDescriptionToggle(expand);
}

// Registration card head: "1 von 2 Plätzen belegt · 1 frei" and the capacity bar (members and guests)
function renderCapacity(ev) {
    const max = ev.maxParticipants || 0;
    const count = ev.registeredCount || 0;
    const min = ev.minParticipants || 0;
    const free = Math.max(0, max - count);
    const meta = [
        max > 0 ? t('events_capacity_taken', '{count} of {max} places taken', { count, max }) : t('events_registered_count', '{count} registered', { count }),
        max > 0 ? (free > 0 ? t('events_capacity_free', '{count} free', { count: free }) : t('events_capacity_full', 'fully booked')) : '',
        min > 0 ? t('events_capacity_min', 'min. {count}', { count: min }) : ''
    ].filter(Boolean).join(' · ');
    setText('detail-modal-reg-meta', meta);
    const capacity = $('detail-modal-capacity-info');
    if (capacity) {
        capacity.style.display = max > 0 ? 'block' : 'none';
        capacity.classList.toggle('is-full', max > 0 && free === 0);
        capacity.querySelector('.event-progress-bar').style.width = `${max > 0 ? Math.min(100, Math.round((count / max) * 100)) : 0}%`;
    }
}

// A status band of the registration card (texts already escaped by the caller)
const regBanner = (cls, icon, title, sub, action = '') => `
        <div class="event-reg-status ${cls}">
            <span class="event-reg-status-icon">${svgIcon(icon, 16, 2.5)}</span>
            <div class="event-reg-status-text"><strong>${title}</strong>${sub ? `<span>${sub}</span>` : ''}</div>
            ${action}
        </div>`;

// Registration card: capacity, then my status or the register button, then the attendees
function renderRegistrationSection(ev) {
    const status = ev.myRegistration?.status;
    renderCapacity(ev);
    const toggle = current => `window.toggleEventRegistration('${ev.id}', '${current}')`;
    const leave = (current, label) => `<button type="button" class="event-reg-status-action" onclick="${toggle(current)}">${label}</button>`;
    $('detail-modal-reg-action-wrap').innerHTML = isEventPast(ev)
        ? regBanner('is-past', status === 'registered' ? 'check' : 'clock', status === 'registered' ? t('events_reg_was_registered', 'You were registered') : t('events_reg_closed', 'Registration has closed'), t('events_reg_event_over', 'The event is over.'))
        : status === 'registered' ? regBanner('is-registered', 'check', t('events_reg_you_are_registered', 'You are registered'), t('events_reg_looking_forward', 'We look forward to seeing you!'), leave('registered', t('events_reg_unregister', 'Unregister')))
        : status === 'waitlist' ? regBanner('is-waitlist', 'clock', t('events_reg_on_waitlist', 'You are on the waiting list'), t('events_reg_waitlist_hint', 'You will move up as soon as a place becomes free.'), leave('waitlist', t('events_reg_leave', 'Leave')))
        : ev.isFull ? `<button type="button" class="btn btn-secondary btn-block" onclick="${toggle('none')}">${svgIcon('clock', 15, 2)}<span>${t('events_reg_join_waitlist', 'Join the waiting list')}</span></button>`
        : `<button type="button" class="btn btn-primary btn-block" onclick="${toggle('none')}">${svgIcon('check', 15, 2.5)}<span>${t('events_reg_register', 'Register')}</span></button>`;
    const attendees = $('detail-modal-attendees-details');
    if (attendees) attendees.open = false;
    loadEventAttendees(ev.id);
}

// --- One plan per event: duty roster and order of service merged. One "+" adds an entry (what: a task or a song, who:
// people or groups to ask, when: during the event or in the order of service); entries in the order get their time from the start and the
// durations, the others follow as "during the whole event". People are always asked through the duty roster, so
// requests, answers, reminders and the apps keep working. Songs open in the band's key.
let programEvent = null;
let programItems = [];
let programCanEdit = false;
let programLoad = 0;

function addMinutes(hhmm, minutes) {
    const [h, m] = hhmm.split(':').map(Number);
    const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function programTimes(items, start) {
    if (!/^\d{1,2}:\d{2}$/.test(start || '')) return items.map(() => '');
    let offset = 0;
    return items.map(item => {
        const time = addMinutes(start, offset);
        offset += Number(item.minutes) || 0;
        return time;
    });
}
const programTotal = items => items.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
const programSong = item => (item.songId ? songs.find(song => song.id === item.songId) : null);
const programItemTitle = item => item.title || programSong(item)?.title || (item.songId ? t('program_song_missing', 'Song (no longer in the songbook)') : '');
const programMinutes = minutes => t('program_minutes', '{minutes} min', { minutes });

// "2 von 3 besetzt": confirmed people and assigned groups count as filled
const filledDuties = duties => duties.filter(d => d.status === 'confirmed' || (d.status === 'assigned' && (d.assignedGroup || d.assignedGroupName))).length;
function dutySummary(duties) {
    if (!duties.length) return '';
    const tasks = new Set(duties.map(d => (d.roleName || t('duty_task_fallback', 'Task')).trim())).size;
    return `${t('duty_filled_count', '{filled} of {total} filled', { filled: filledDuties(duties), total: duties.length })} · ${tasks === 1 ? t('duty_task_count_one', '1 task') : t('duty_task_count_many', '{count} tasks', { count: tasks })}`;
}

/** Loads the order of service of the opened event and merges it into the duty roster. */
async function renderProgramBox(ev) {
    const load = ++programLoad;
    // Another event: forget the old order at once; the same event keeps it until the fresh one is there (no flicker)
    if (programEvent?.id !== ev?.id) {
        programItems = [];
        programCanEdit = false;
    }
    programEvent = ev;
    updateDutyPlanHeader();
    if (!ev?.canAccessDutyPlan) return;
    try {
        const data = await apiJson(`/events/${encodeURIComponent(ev.id)}/program`);
        if (load !== programLoad) return;
        programItems = Array.isArray(data.items) ? data.items : [];
        programCanEdit = data.canEdit === true;
        if (programItems.some(item => item.songId) && !songbookLoaded) await loadSongs();
    } catch {
        return;
    }
    if (load !== programLoad) return;
    renderGroupedDuties(ev.duties || [], ev);
    updateDutyPlanHeader();
}

/** Title, summary ("2 of 3 filled · 6 items · 10:00 – 11:25") and the plan button of the roster card. */
function updateDutyPlanHeader() {
    const has = programItems.length > 0;
    const meta = $('detail-modal-duties-count');
    if (meta) {
        const base = dutySummary(programEvent?.duties || []);
        const total = programTotal(programItems);
        const start = programEvent?.startTime || '';
        const span = total ? (programTimes(programItems, start)[0] ? `${start} – ${addMinutes(start, total)}` : programMinutes(total)) : '';
        const count = programItems.length === 1 ? t('program_count_one', '1 item') : t('program_count_many', '{count} items', { count: programItems.length });
        const duties = programEvent?.duties || [];
        const filled = duties.length ? t('duty_filled_count', '{filled} of {total} filled', { filled: filledDuties(duties), total: duties.length }) : '';
        meta.textContent = has ? ([filled, span].filter(Boolean).join(' · ') || count) : (base || t('duty_no_tasks', 'No tasks yet'));
    }
    setText('detail-modal-duties-title', has ? t('duty_roster_and_program', 'Duty roster & order of service') : t('events_duty_roster', 'Duty roster'));
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
/** The roster task of an item: the one named under "who", else the one with the item's title. */
function itemTask(item, roles) {
    return roles.find(role => sameName(role, item.who)) || roles.find(role => sameName(role, programItemTitle(item))) || null;
}

function updateDutyProgress(duties) {
    const progress = $('detail-modal-duties-progress');
    if (!progress) return;
    const filled = filledDuties(duties);
    progress.style.display = duties.length ? 'block' : 'none';
    progress.classList.toggle('is-complete', duties.length > 0 && filled === duties.length);
    progress.querySelector('.event-progress-bar').style.width = `${duties.length ? Math.round((filled / duties.length) * 100) : 0}%`;
}

/** The people of a task as one quiet line: names (with "requested" / "declined"), or "still open". */
function planPeople(roleDuties) {
    const people = (roleDuties || []).filter(hasDutyAssignee);
    if (!people.length) return `<span class="plan-open">${t('plan_open', 'still open')}</span>`;
    return people.map(d => {
        const group = d.status === 'assigned' && (d.assignedGroupName || d.assignedGroup);
        const uid = d.status === 'requested' || d.status === 'declined' ? d.requestedUser : d.assignedUser;
        const name = group ? (d.assignedGroupName || d.assignedGroup)
            : isCurrentUser(uid) ? t('duty_you', 'You') : ((d.status === 'requested' || d.status === 'declined' ? d.requestedUserName : d.assignedUserName) || t('details_person', 'Person'));
        const state = d.status === 'requested' ? t('duty_state_requested', 'requested') : d.status === 'declined' ? t('duty_state_declined', 'declined') : '';
        return `<span class="plan-person${state ? ` is-${d.status}` : ''}">${group ? `<span class="plan-person-icon">${svgIcon('users', 11, 2.5)}</span>` : renderAvatarWrap(uid, name, { wrapClass: 'plan-person-avatar', imgClass: 'plan-person-img', initialsClass: 'plan-person-initials' })}<span>${escapeHtml(name)}</span>${state ? `<em>${state}</em>` : ''}</span>`;
    }).join('');
}

/** The people of a row, right under its title: small picture, first name and "requested" / "declined" if so, or "open". */
function planPeopleShort(roleDuties) {
    const people = (roleDuties || []).filter(hasDutyAssignee);
    if (!people.length) return `<span class="plan-open">${t('plan_open_short', 'open')}</span>`;
    const names = people.map(d => {
        const group = d.status === 'assigned' && (d.assignedGroupName || d.assignedGroup);
        const uid = d.status === 'requested' || d.status === 'declined' ? d.requestedUser : d.assignedUser;
        const full = group ? (d.assignedGroupName || d.assignedGroup)
            : isCurrentUser(uid) ? t('duty_you', 'You') : ((d.status === 'requested' || d.status === 'declined' ? d.requestedUserName : d.assignedUserName) || t('details_person', 'Person'));
        const state = group ? 'group' : d.status === 'requested' ? 'requested' : d.status === 'declined' ? 'declined' : 'confirmed';
        const label = state === 'requested' ? t('duty_state_requested', 'requested') : state === 'declined' ? t('duty_state_declined', 'declined') : '';
        const short = group ? full : String(full).split(/\s+/)[0];
        const picture = group ? `<span class="plan-person-icon">${svgIcon('users', 11, 2.5)}</span>` : renderAvatarWrap(uid, full, { wrapClass: 'plan-person-avatar', imgClass: 'plan-person-img', initialsClass: 'plan-person-initials' });
        return `<span class="plan-name is-${state}" title="${escapeHtml(label ? `${full} · ${label}` : full)}">${picture}<span>${escapeHtml(short)}</span>${label ? `<em>${escapeHtml(label)}</em>` : ''}</span>`;
    });
    return names.length > 3 ? names.slice(0, 2).join('') + `<span class="plan-name is-more">+${names.length - 2}</span>` : names.join('');
}

/** A request to the viewer: the answer stays right in the row. */
function planAnswer(roleDuties) {
    const mine = (roleDuties || []).find(d => d.status === 'requested' && isCurrentUser(d.requestedUser));
    return mine ? `
        <span class="plan-answer">
            <span>${t('duty_you_were_requested', 'You have been requested')}</span>
            <span class="plan-answer-buttons">
                <button type="button" class="btn btn-primary btn-tiny" onclick="event.stopPropagation(); window.respondToDutyRequest(${jsArg(mine.id)}, 'accept')">${svgIcon('check', 13, 2.5)}<span>${t('duty_btn_accept', 'Accept')}</span></button>
                <button type="button" class="btn btn-secondary btn-tiny" onclick="event.stopPropagation(); window.respondToDutyRequest(${jsArg(mine.id)}, 'decline')">${t('request_btn_reject', 'Reject')}</button>
            </span>
        </span>` : '';
}

/** Two clearly separate lists: the order of service as a timeline (time, title, people), then the tasks without a
 * time in their own box (no heading: the box itself sets them apart). Editors tap a row to open its entry. */
function renderDutyPlan(duties, items, ev) {
    const grouped = groupBy(duties, d => (d.roleName || t('duty_task_fallback', 'Task')).trim());
    const roles = [...grouped.keys()];
    const editable = !!ev.canEdit;
    const used = new Set();
    const times = programTimes(items, ev.startTime);
    const row = ({ onOpen, inOrder, time, minutes, title, people, note, answer }) => `
        <div class="plan-row${inOrder ? '' : ' is-task'}${editable ? ' is-editable' : ''}"${editable ? ` role="button" tabindex="0" onclick="${onOpen}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}"` : ''}>
            ${inOrder ? `<span class="plan-row-time${/:/.test(time) ? '' : ' is-place'}">${time}${minutes ? `<small>${escapeHtml(programMinutes(minutes))}</small>` : ''}</span>` : ''}
            <span class="plan-row-main">
                <span class="plan-row-title">${title}</span>
                <span class="plan-row-people">${people}</span>
                ${note ? `<span class="plan-row-note">${escapeHtml(note)}</span>` : ''}
                ${answer}
            </span>
        </div>`;
    const itemRows = items.map((item, i) => {
        const role = itemTask(item, roles);
        if (role) used.add(role);
        const song = programSong(item);
        const key = item.songKey || song?.key || '';
        const name = escapeHtml(programItemTitle(item));
        const title = song
            ? `<button type="button" class="plan-song" onclick="event.stopPropagation(); window.openProgramSong(${jsArg(item.id)})"><span>${name}</span>${key ? `<span class="program-key">${escapeHtml(key)}</span>` : ''}</button>`
            : name;
        const who = !role && item.who && !sameName(item.who, programItemTitle(item)) ? `<span class="plan-name is-text">${escapeHtml(item.who)}</span>` : '';
        return row({
            onOpen: `window.openPlanEntryForItem(${jsArg(item.id)})`, inOrder: true, time: (item.minutes && times[i]) || `${i + 1}.`, minutes: item.minutes, title,
            people: role ? planPeopleShort(grouped.get(role)) : (who || `<span class="plan-open">${t('plan_open_short', 'open')}</span>`), note: item.note, answer: role ? planAnswer(grouped.get(role)) : ''
        });
    }).join('');
    const tasks = [...grouped].filter(([role]) => !used.has(role)).map(([role, roleDuties]) => row({
        onOpen: `window.openPlanEntryForRole(${jsArg(encodeURIComponent(role))})`, title: escapeHtml(role),
        people: planPeopleShort(roleDuties), note: roleDuties.find(d => d.notes)?.notes || '', answer: planAnswer(roleDuties)
    })).join('');
    if (!itemRows && !tasks) {
        return `<div class="duty-rows-empty">${editable ? t('plan_empty_manager', 'Add what happens and who helps - with "+" below.') : t('duty_empty_member', 'No duties have been set up for this event.')}</div>`;
    }
    const total = programTotal(items);
    const span = total && times[0] ? `${times[0]} – ${addMinutes(ev.startTime, total)}` : '';
    const both = itemRows && tasks;
    const head = (icon, title, meta) => `<div class="plan-group-head">${svgIcon(icon, 15, 2.2)}<span>${title}</span>${meta ? `<em>${escapeHtml(meta)}</em>` : ''}</div>`;
    return `<div class="plan-list">
        ${itemRows ? `<div class="plan-group is-timeline">${both ? head('clock', t('plan_group_program', 'Order of service'), '') : ''}${itemRows}</div>` : ''}
        ${tasks ? `<div class="plan-group is-tasks${both ? ' is-boxed' : ''}">${tasks}</div>` : ''}
    </div>`;
}

/** After a live update: the open card shows the saved order again (not while it is being edited). */
async function refreshProgram() {
    if (!programEvent || !shownModal('event-detail-modal') || shownModal('plan-entry-modal')) return;
    const ev = appEvents.find(e => e.id === programEvent.id);
    if (ev) await renderProgramBox(ev);
}

function openProgramSong(itemId) {
    const item = programItems.find(i => i.id === itemId);
    const song = item && programSong(item);
    if (!song) return;
    openSong(song.id, { steps: keySteps(song.key, item.songKey) || 0 });
}

// --- One entry of the plan: what (a task, or a song found while typing), who (people and groups picked right in the
// dialog) and when (during the event, or a place in the order of service). Everyone chosen is asked when saving; an
// existing entry also shows its people with "remove".
let planEntry = null;
let planWhoOptions = new Map();
let planWhoToken = 0;
const PLAN_DURATIONS = [2, 5, 10, 15, 30];

const planRoles = () => [...new Set((currentDetailEvent?.duties || []).map(d => (d.roleName || '').trim()).filter(Boolean))];
/** The people of the edited entry's task. */
const planDuties = () => (currentDetailEvent?.duties || []).filter(d => planEntry?.role && sameName(d.roleName, planEntry.role) && hasDutyAssignee(d));
const planAssigneeKey = data => (data.targetGroupId ? `g:${data.targetGroupId}` : `u:${data.targetUserId}`);

function openPlanEntry(entry = { mode: 'new' }) {
    if (!currentDetailEvent?.canEdit) return;
    if (programEvent?.id !== currentDetailEvent.id) programItems = [];
    const item = entry.itemId ? programItems.find(i => i.id === entry.itemId) : (entry.role ? programItems.find(i => itemTask(i, [entry.role])) : null);
    const editing = entry.mode === 'edit';
    const index = item ? programItems.indexOf(item) : -1;
    planEntry = {
        mode: entry.mode, role: entry.role || (item ? itemTask(item, planRoles()) : null), itemId: item?.id || null, songId: item?.songId || '',
        assignees: [], inProgram: !!item, place: index > -1 ? index : programItems.length,
        // Without minutes an entry only sets the order; a duration gives it a time
        customMinutes: !!item?.minutes && !PLAN_DURATIONS.includes(item.minutes), taskText: ''
    };
    const existingName = editing ? (entry.role || (item ? programItemTitle(item) : '')) : '';
    setText('plan-entry-title', editing ? existingName || t('plan_edit_entry', 'Edit entry') : t('plan_new_entry', 'Add to the roster'));
    setText('plan-entry-sub', [currentDetailEvent.title, formatEventDateSpanCompact(currentDetailEvent.date, currentDetailEvent.endDate), currentDetailEvent.startTime].filter(Boolean).join(' · '));
    document.querySelector('#plan-entry-modal .plan-sheet')?.classList.toggle('is-edit', editing);
    const what = $('plan-what-section');
    if (what) what.hidden = editing;
    setValue('plan-entry-name', '');
    setValue('plan-entry-minutes', item?.minutes || '');
    setValue('plan-entry-key', item?.songKey || '');
    setValue('plan-entry-note', item?.note || '');
    setValue('plan-who-search', '');
    const picker = $('plan-who-picker');
    if (picker) picker.hidden = true;
    renderPlanSong();
    renderPlanSuggestions();
    renderPlanPerson();
    setPlanWhen(planEntry.inProgram);
    const del = $('plan-entry-delete');
    if (del) del.hidden = !editing;
    if (!songbookLoaded) loadSongs().then(() => { renderPlanSong(); renderPlanSuggestions(); });
    loadEventCandidates();
    openModal('plan-entry-modal');
    if (!editing) setTimeout(() => $('plan-entry-name')?.focus(), 150);
}

function openPlanEntryForItem(itemId) {
    openPlanEntry({ mode: 'edit', itemId });
}
function openPlanEntryForRole(encodedRole) {
    openPlanEntry({ mode: 'edit', role: decodeURIComponent(encodedRole) });
}

/** The name the entry gets: the edited one's, else the chosen song or the typed task. */
function planEntryName() {
    if (!planEntry) return '';
    if (planEntry.mode === 'edit') return planEntry.role || programItemTitle(programItems.find(i => i.id === planEntry.itemId) || {});
    return (planEntry.songId && songs.find(s => s.id === planEntry.songId)?.title) || inputValue('plan-entry-name').trim();
}

/** A chosen song takes the place of the name field (a new entry can take it back with "x"). */
function renderPlanSong() {
    const song = planEntry?.songId ? songs.find(s => s.id === planEntry.songId) : null;
    const chosen = $('plan-entry-song-chosen');
    if (chosen) {
        chosen.hidden = !song;
        chosen.innerHTML = song ? `${svgIcon('music', 15)}<span>${escapeHtml(song.title)}</span>${song.key ? `<span class="program-key">${escapeHtml(song.key)}</span>` : ''}
            <button type="button" class="plan-entry-remove" onclick="window.clearPlanSong()" aria-label="${escapeHtml(t('btn_remove', 'Remove'))}" title="${escapeHtml(t('btn_remove', 'Remove'))}">${svgIcon('x', 14, 2.5)}</button>` : '';
    }
    show('plan-entry-name', !song);
    const keyField = $('plan-entry-key-field');
    if (keyField) keyField.hidden = !planEntry?.songId;
}

/** While typing: the matching songs of the songbook, and the typed text as a task of its own. */
function renderPlanSuggestions() {
    const box = $('plan-entry-suggest');
    if (!box || !planEntry) return;
    const text = inputValue('plan-entry-name').trim();
    const query = normalizeSearch(text);
    const found = query && songbookLoaded && !planEntry.songId && text !== planEntry.taskText ? songs.filter(s => normalizeSearch(`${s.title} ${s.artist || ''}`).includes(query)).slice(0, 4) : [];
    box.hidden = !found.length;
    box.innerHTML = found.length ? found.map(s => `
        <button type="button" class="plan-suggest-option" onclick="window.choosePlanSong(${jsArg(s.id)})">
            <span class="plan-suggest-icon is-song">${svgIcon('music', 15)}</span>
            <span class="plan-suggest-text"><span class="plan-suggest-title"><span>${escapeHtml(s.title)}</span>${s.key ? `<span class="program-key">${escapeHtml(s.key)}</span>` : ''}</span><span class="plan-suggest-sub">${escapeHtml([t('plan_kind_song', 'Song'), s.artist].filter(Boolean).join(' · '))}</span></span>
        </button>`).join('') + `
        <button type="button" class="plan-suggest-option" onclick="window.keepPlanTask()">
            <span class="plan-suggest-icon">${svgIcon('plus', 15, 2.5)}</span>
            <span class="plan-suggest-text"><span class="plan-suggest-title"><span>${escapeHtml(t('plan_as_task', '"{name}" as a task', { name: text }))}</span></span></span>
        </button>` : '';
    updatePlanOrder();
}

function choosePlanSong(songId) {
    if (!planEntry) return;
    planEntry.songId = songId;
    const song = songs.find(s => s.id === songId);
    if (song && !inputValue('plan-entry-key')) setValue('plan-entry-key', song.key || '');
    setValue('plan-entry-name', '');
    renderPlanSong();
    renderPlanSuggestions();
    // Songs are sung at a moment of the event: they go into the order right away
    setPlanWhen(true);
}

function clearPlanSong() {
    if (!planEntry) return;
    planEntry.songId = '';
    setValue('plan-entry-key', '');
    renderPlanSong();
    renderPlanSuggestions();
    $('plan-entry-name')?.focus();
}

function keepPlanTask() {
    if (!planEntry) return;
    planEntry.taskText = inputValue('plan-entry-name').trim();
    renderPlanSuggestions();
    $('plan-entry-name')?.focus();
}

/** After a change from the entry dialog: fresh data in the list behind it, the dialog stays open. */
async function reloadPlanEvent() {
    await loadEventsData();
    const ev = appEvents.find(e => e.id === currentDetailEvent?.id);
    if (!ev) return;
    currentDetailEvent = ev;
    programEvent = ev;
    updateDutyProgress(ev.duties || []);
    renderGroupedDuties(ev.duties || [], ev);
    updateDutyPlanHeader();
}

async function removePlanPerson(dutyId) {
    const ev = currentDetailEvent;
    const duty = ev?.duties?.find(d => d.id === dutyId);
    if (!duty || !confirmAction(t('duty_remove_entry_confirm', 'Really remove this entry?'))) return;
    try {
        const res = await api(`/events/duties/${dutyId}`, 'DELETE');
        if (!res.ok) throw new Error(t('duty_remove_error', 'Failed to remove'));
        // The task stays (empty) when its last person goes
        if ((ev.duties || []).filter(d => sameName(d.roleName, duty.roleName)).length === 1) await api(`/events/${ev.id}/duties`, 'POST', { roleName: duty.roleName });
        await reloadPlanEvent();
        renderPlanPerson();
        if (!$('plan-who-picker')?.hidden) renderPlanWhoList();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

const planAssigneeBadge = data => (data.targetGroupId
    ? `<span class="plan-person-icon">${svgIcon('users', 11, 2.5)}</span>`
    : renderAvatarWrap(data.targetUserId, planWhoOptions.get(planAssigneeKey(data))?.label, { wrapClass: 'plan-person-avatar', imgClass: 'plan-person-img', initialsClass: 'plan-person-initials' }));

/** Who: the people already on the entry (with "remove"), the ones chosen to be asked when saving, and "+ Ask …". */
function renderPlanPerson() {
    const box = $('plan-entry-person');
    if (!box || !planEntry) return;
    const existing = planEntry.mode === 'edit' ? planDuties() : [];
    const remove = (onclick, label) => `<button type="button" class="plan-chip-remove" onclick="${onclick}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${svgIcon('x', 12, 2.6)}</button>`;
    const chips = existing.map(d => `<span class="plan-chip">${planPeople([d])}${remove(`window.removePlanPerson(${jsArg(d.id)})`, t('duty_remove_entry', 'Remove entry'))}</span>`)
        .concat(planEntry.assignees.map((a, index) => `<span class="plan-chip is-new"><span class="plan-person">${planAssigneeBadge(a.data)}<span>${escapeHtml(a.label)}</span></span>${remove(`window.clearPlanPerson(${index})`, t('btn_remove', 'Remove'))}</span>`));
    if ($('plan-who-picker')?.hidden !== false) {
        const label = chips.length ? t('plan_ask_more', 'Ask someone else') : t('plan_ask_person', 'Ask a person or group');
        chips.push(`<button type="button" class="plan-chip is-add" onclick="window.pickPlanPerson()">${svgIcon('plus', 13, 2.6)}<span>${escapeHtml(label)}</span></button>`);
    }
    box.innerHTML = chips.join('');
    box.hidden = !chips.length;
    updatePlanSaveLabel();
}

/** Opens the list of people and groups right in the dialog (no second pop-up). */
function pickPlanPerson() {
    const picker = $('plan-who-picker');
    if (!picker || !planEntry) return;
    picker.hidden = false;
    renderPlanPerson();
    renderPlanWhoList();
    $('plan-who-search')?.focus();
}

/** People and groups in one list: tapping one chooses it (or takes it back); people get a request, groups are set. */
async function renderPlanWhoList() {
    const list = $('plan-who-list');
    if (!list || !planEntry) return;
    const token = ++planWhoToken;
    if (!eventCandidatesCache) {
        list.innerHTML = `<div class="plan-who-empty">${t('loading_short', 'Loading...')}</div>`;
        await loadEventCandidates();
        if (token !== planWhoToken || !planEntry) return;
    }
    const term = normalizeSearch(inputValue('plan-who-search').trim());
    const matches = (...texts) => !term || texts.some(text => normalizeSearch(text || '').includes(term));
    const taken = new Set((planEntry.mode === 'edit' ? planDuties() : []).filter(d => d.status !== 'declined')
        .map(d => (d.status === 'assigned' && d.assignedGroup ? `g:${d.assignedGroup}` : `u:${d.requestedUser || d.assignedUser}`)));
    const people = (Array.isArray(eventCandidatesCache) ? eventCandidatesCache : []).map(c => {
        const label = c.name || c.email || t('events_member_fallback', 'Member');
        return { key: `u:${c.id}`, data: { targetUserId: c.id, sendEmail: true }, label, search: [label, term ? c.email : ''], sub: t('plan_who_person', 'Gets a request') };
    });
    const groups = (Array.isArray(eventGroupsCache) && eventGroupsCache.length ? eventGroupsCache : groupList()).map(g => {
        const label = g.name || g.id;
        return { key: `g:${g.id || g.name}`, data: { targetGroupId: g.id || g.name }, label, search: [label], sub: t('plan_who_group', 'Group · assigned directly'), group: true };
    });
    planWhoOptions = new Map([...people, ...groups].map(o => [o.key, o]));
    const shown = [...people, ...groups].filter(o => matches(...o.search));
    list.innerHTML = shown.map(o => {
        const done = taken.has(o.key);
        const chosen = done || planEntry.assignees.some(a => planAssigneeKey(a.data) === o.key);
        const badge = o.group ? `<span class="plan-who-avatar is-group">${svgIcon('users', 15, 2.2)}</span>`
            : renderAvatarWrap(o.data.targetUserId, o.label, { wrapClass: 'plan-who-avatar', imgClass: 'plan-person-img', initialsClass: 'plan-who-initials' });
        return `<button type="button" class="plan-who-option${chosen ? ' is-chosen' : ''}" role="checkbox" aria-checked="${chosen}"${done ? ' disabled' : ` onclick="window.togglePlanWho(${jsArg(o.key)})"`}>
            ${badge}<span class="plan-who-text"><span class="plan-who-name">${escapeHtml(o.label)}</span><span class="plan-who-sub">${escapeHtml(done ? t('plan_who_already', 'Already on this entry') : o.sub)}</span></span>
            <span class="plan-who-check">${svgIcon('check', 13, 3)}</span>
        </button>`;
    }).join('') || `<div class="plan-who-empty">${t('plan_who_none', 'Nobody found')}</div>`;
}

function togglePlanWho(key) {
    const option = planWhoOptions.get(key);
    if (!planEntry || !option) return;
    const index = planEntry.assignees.findIndex(a => planAssigneeKey(a.data) === key);
    if (index > -1) planEntry.assignees.splice(index, 1);
    else planEntry.assignees.push({ data: option.data, label: option.label });
    renderPlanPerson();
    renderPlanWhoList();
}

function clearPlanPerson(index) {
    if (!planEntry) return;
    planEntry.assignees.splice(index, 1);
    renderPlanPerson();
    if (!$('plan-who-picker')?.hidden) renderPlanWhoList();
}

/** The button says what happens: "Add", "Add & ask Clara", "Save & ask 3 people". */
function updatePlanSaveLabel() {
    const btn = $('plan-entry-save');
    if (!btn || !planEntry) return;
    const asked = planEntry.assignees;
    const who = asked.length > 1 ? t('plan_ask_count', '{count} people', { count: asked.length })
        : asked[0]?.data.targetGroupId ? asked[0].label : String(asked[0]?.label || '').split(/\s+/)[0];
    btn.textContent = planEntry.mode === 'edit'
        ? (asked.length ? t('plan_save_ask', 'Save & ask {who}', { who }) : t('btn_save', 'Save'))
        : (asked.length ? t('plan_add_ask', 'Add & ask {who}', { who }) : t('plan_add', 'Add'));
}

/** When: during the whole event, or at a place in the order of service. */
function setPlanWhen(inProgram) {
    if (!planEntry) return;
    planEntry.inProgram = !!inProgram;
    $('plan-entry-when')?.querySelectorAll('.segmented-tab').forEach(tab => {
        const on = (tab.dataset.when === 'order') === planEntry.inProgram;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-checked', String(on));
    });
    const fields = $('plan-entry-program-fields');
    if (fields) fields.hidden = !planEntry.inProgram;
    updatePlanOrder();
}

function setPlanPlace(place) {
    if (!planEntry) return;
    planEntry.place = place;
    updatePlanOrder();
}

/** A duration pill: again on the chosen one takes it back (the entry then only sets the order); "Other" types it. */
function setPlanMinutes(minutes) {
    if (!planEntry) return;
    planEntry.customMinutes = minutes === 'other';
    if (planEntry.customMinutes) {
        updatePlanOrder();
        $('plan-entry-minutes')?.focus();
        return;
    }
    setValue('plan-entry-minutes', (parseInt(inputValue('plan-entry-minutes'), 10) || 0) === minutes ? '' : String(minutes));
    updatePlanOrder();
}

/** The order with this entry as a highlighted slot between the others (tap a gap to move it), the duration pills and
 * the times that follow from them (only when the event has a start time). */
function updatePlanOrder() {
    if (!planEntry) return;
    const others = programItems.filter(i => i.id !== planEntry.itemId);
    const place = Math.min(Math.max(0, planEntry.place), others.length);
    planEntry.place = place;
    const minutes = Math.max(0, parseInt(inputValue('plan-entry-minutes'), 10) || 0);
    const start = currentDetailEvent?.startTime || '';
    const timed = /^\d{1,2}:\d{2}$/.test(start);
    const list = [...others];
    list.splice(place, 0, { minutes });
    const times = programTimes(list, start);
    const when = i => escapeHtml(times[i] || `${i + 1}.`);
    const order = $('plan-entry-order');
    if (order) {
        const parts = [];
        for (let p = 0; p <= others.length; p++) {
            if (p === place) {
                parts.push(`<div class="plan-order-slot"><span class="plan-order-time">${when(place)}</span><span class="plan-order-title">${escapeHtml(planEntryName() || t('plan_this_entry', 'This entry'))}</span><span class="plan-order-here">${t('plan_here', 'here')}</span></div>`);
            } else {
                const label = p === 0 ? t('plan_at_start', 'At the start') : t('plan_after', 'After "{name}"', { name: programItemTitle(others[p - 1]) });
                parts.push(`<button type="button" class="plan-order-gap" onclick="window.setPlanPlace(${p})" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span>${svgIcon('plus', 11, 3)}</span></button>`);
            }
            if (p < others.length) parts.push(`<div class="plan-order-row"><span class="plan-order-time">${when(p < place ? p : p + 1)}</span><span class="plan-order-title">${escapeHtml(programItemTitle(others[p]))}</span></div>`);
        }
        order.innerHTML = parts.join('');
        const slot = order.querySelector('.plan-order-slot');
        if (slot && order.scrollHeight > order.clientHeight) order.scrollTop = slot.offsetTop - (order.clientHeight - slot.offsetHeight) / 2;
    }
    const custom = planEntry.customMinutes || (minutes > 0 && !PLAN_DURATIONS.includes(minutes));
    const pills = $('plan-entry-durations');
    if (pills) {
        const pill = (arg, label, on) => `<button type="button" class="plan-duration${on ? ' is-active' : ''}" aria-pressed="${on}" onclick="window.setPlanMinutes(${arg})">${escapeHtml(label)}</button>`;
        pills.innerHTML = PLAN_DURATIONS.map(m => pill(m, String(m), !custom && m === minutes)).join('') + pill(jsArg('other'), t('plan_minutes_other', 'Other'), custom);
    }
    const input = $('plan-entry-minutes');
    if (input) input.hidden = !custom;
    const hint = $('plan-entry-start');
    if (hint) {
        hint.textContent = !timed ? ''
            : minutes ? t('plan_starts_hint', 'Starts at {time}, until {end}', { time: times[place], end: addMinutes(times[place], minutes) })
                : t('plan_order_only', 'Without a duration it only sets the order.');
    }
}

/** Asks everyone chosen for the task: an open place of it is filled first, then new places are added. */
async function askPlanPeople(eventId, roleName) {
    const open = (currentDetailEvent?.duties || []).filter(d => sameName(d.roleName, roleName) && d.status === 'open');
    for (const a of planEntry.assignees) {
        const slot = open.shift();
        await apiJson(slot ? `/events/duties/${slot.id}/assign` : `/events/${encodeURIComponent(eventId)}/duties`, 'POST',
            slot ? { ...a.data, sendEmail: true } : { roleName, ...a.data, sendEmail: true }, t('duty_assign_error', 'Failed to assign'));
    }
}

async function savePlanEntry() {
    const ev = currentDetailEvent;
    if (!planEntry || !ev) return;
    const song = planEntry.songId ? songs.find(s => s.id === planEntry.songId) : null;
    const existingItem = planEntry.itemId ? programItems.find(i => i.id === planEntry.itemId) : null;
    const name = planEntryName();
    if (!name) {
        showToast(t('plan_name_missing', 'Please enter a name.'), 'error');
        $('plan-entry-name')?.focus();
        return;
    }
    const inProgram = planEntry.inProgram;
    const minutesValue = inputValue('plan-entry-minutes');
    const minutes = minutesValue === '' ? null : Math.max(0, Math.min(600, parseInt(minutesValue, 10) || 0));
    const fields = { minutes, note: inputValue('plan-entry-note').trim(), songKey: song || existingItem?.songId ? inputValue('plan-entry-key').trim() : '' };
    const btn = $('plan-entry-save');
    if (btn) btn.disabled = true;
    try {
        const roles = planRoles();
        const roleName = planEntry.role || roles.find(r => sameName(r, name)) || name;
        const hasTask = roles.some(r => sameName(r, roleName));
        const asking = planEntry.assignees.length > 0;
        // People are asked through the duty roster (requests, reminders, apps)
        if (asking) {
            await askPlanPeople(ev.id, roleName);
        } else if (!hasTask && (!inProgram || planEntry.mode === 'edit')) {
            // A task without a moment always stays on the roster (also when it leaves the order)
            await apiJson(`/events/${encodeURIComponent(ev.id)}/duties`, 'POST', { roleName }, t('duty_task_add_error', 'Failed to create the task'));
        }
        let items = programItems.map(i => ({ ...i }));
        const linked = existingItem || items.find(i => itemTask(i, [roleName]));
        if (inProgram) {
            // An item that gets its first people points to their task
            const entry = linked
                ? { ...linked, ...fields, ...(asking && !itemTask(linked, roles) && !sameName(linked.who, roleName) ? { who: roleName } : {}) }
                : { id: '', title: song ? '' : name, who: asking || hasTask || planEntry.mode === 'edit' ? roleName : '', songId: song?.id || '', ...fields };
            items = items.filter(i => i !== linked && i.id !== linked?.id);
            items.splice(Math.min(planEntry.place, items.length), 0, entry);
        } else if (linked) {
            items = items.filter(i => i.id !== linked.id);
        }
        if (JSON.stringify(items) !== JSON.stringify(programItems)) {
            const data = await apiJson(`/events/${encodeURIComponent(ev.id)}/program`, 'PUT', { items }, t('program_save_failed', 'The order of service could not be saved'));
            programItems = data.items || items;
        }
        closeModal('plan-entry-modal', false, true);
        showToast(planEntry.assignees.some(a => a.data.targetUserId) ? t('duty_request_sent', 'Duty request sent & email delivered!') : t('plan_saved', 'Saved'));
        await loadEventsData();
        refreshDetailEvent(true);
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deletePlanEntry() {
    const ev = currentDetailEvent;
    if (!planEntry || !ev) return;
    const item = planEntry.itemId ? programItems.find(i => i.id === planEntry.itemId) : null;
    const name = planEntry.role || programItemTitle(item || {});
    if (!confirmAction(t('plan_delete_confirm', 'Delete "{name}" with everyone asked for it?', { name }))) return;
    try {
        const duties = (ev.duties || []).filter(d => planEntry.role && sameName(d.roleName, planEntry.role));
        await Promise.all(duties.map(d => api(`/events/duties/${d.id}`, 'DELETE')));
        const items = programItems.filter(i => i.id !== item?.id && !(planEntry.role && itemTask(i, [planEntry.role])));
        if (items.length !== programItems.length) {
            const data = await apiJson(`/events/${encodeURIComponent(ev.id)}/program`, 'PUT', { items }, t('program_save_failed', 'The order of service could not be saved'));
            programItems = data.items || items;
        }
        closeModal('plan-entry-modal', false, true);
        showToast(t('plan_deleted', 'Entry deleted'), 'info');
        await loadEventsData();
        refreshDetailEvent(true);
    } catch (err) {
        showToast(err.message, 'error');
    }
}


async function openEventDetailModal(eventId) {
    let ev = appEvents.find(e => e.id === eventId);
    if (!ev) {
        await loadEventsData();
        ev = appEvents.find(e => e.id === eventId);
    }
    // Deleted (or not visible) in the meantime - a notification or an old link: say so instead of doing nothing
    if (!ev) return showToast(t('events_link_missing', 'This event no longer exists.'), 'error');
    currentDetailEvent = ev;
    leaveGuestView();
    renderDetailBasics(ev);

    const creator = ev.createdByName?.trim() || '';
    const creatorEl = $('detail-creator-name');
    if (creatorEl) {
        creatorEl.textContent = ev.createdByName || t('events_member_fallback', 'Member');
        creatorEl.title = creator || t('events_member_fallback', 'Member');
    }
    show('detail-modal-organizer-pill', !!creator, 'inline-flex');

    // Target groups: a text line under the organizer instead of tags on the picture
    const groupNames = (Array.isArray(ev.targetGroups) ? ev.targetGroups : []).map(g => findGroup(g)?.name || g).filter(Boolean);
    const groupsText = $('detail-modal-groups-text');
    if (groupsText) {
        const quoted = groupNames.map(name => `<strong>${t('detail_groups_quoted', '“{name}”', { name: escapeHtml(name) })}</strong>`);
        const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} ${t('detail_groups_and', 'and')} ${quoted[quoted.length - 1]}` : quoted.join('');
        const isEventType = ev.eventType ? ev.eventType === 'event' : !ev.isOfficialTermin;
        const kind = isEventType ? t('detail_groups_event', 'Event') : t('detail_groups_termin', 'Appointment');
        groupsText.innerHTML = quoted.length === 1 ? `${kind} ${t('detail_groups_for_one', 'for the group')} ${list}`
            : `${kind} ${t('detail_groups_for_many', 'for the groups')} ${list}`;
    }
    show('detail-modal-groups-line', groupNames.length > 0, 'flex');

    show('detail-modal-reg-box', !!ev.requiresRegistration, 'block');
    if (ev.requiresRegistration) renderRegistrationSection(ev);

    const dutiesBox = $('detail-modal-duties-box');
    show(dutiesBox, !!ev.canAccessDutyPlan, 'block');
    if (ev.canAccessDutyPlan && dutiesBox) {
        const dutiesDetails = $('detail-modal-duties-details');
        if (dutiesDetails) dutiesDetails.open = false;
        show('detail-modal-add-duty-wrap', !!ev.canEdit, 'block');
        const duties = Array.isArray(ev.duties) ? ev.duties : [];
        setText('detail-modal-duties-count', dutySummary(duties) || t('duty_no_tasks', 'No tasks yet'));
        updateDutyProgress(duties);
        renderGroupedDuties(duties, ev);
    }
    renderProgramBox(ev);

    show('detail-btn-edit', !!ev.canEdit, 'inline-flex');
    show('detail-btn-delete', !!ev.canEdit, 'inline-flex');
    show('detail-modal-action-bar', !!ev.canEdit, 'flex');
    openModal('event-detail-modal');
    fitDetailWhere();
    clampDetailDescription();
}

// What, when and where, the picture and the description: the same page for members and for guests of a shared event
function renderDetailBasics(ev) {
    const modalBody = document.querySelector('.event-detail-body');
    if (modalBody) modalBody.scrollTop = 0;
    detailCard()?.classList.remove('detail-is-editing', 'detail-is-new');
    show('detail-edit-cover-placeholder', false);
    hideTypeSelector();
    showDetailCover(eventImage(ev), true);

    const typeIndicator = $('detail-modal-type-indicator');
    if (typeIndicator) {
        typeIndicator.innerHTML = ev.isPinned ? `${svgIcon('star', 13)}<span>${t('events_major_event_highlight', 'Major event & highlight')}</span>` : '';
        // Keep detail-view-only so the badge hides while editing or creating an event
        typeIndicator.className = `event-detail-type-badge detail-view-only${ev.isPinned ? ' type-pinned' : ''}`;
        typeIndicator.style.display = ev.isPinned ? 'inline-flex' : 'none';
    }
    setText('detail-modal-title', ev.title);

    // Multi-day events show only the date span, no times
    const isMultiDay = Boolean(ev.endDate && ev.endDate !== ev.date);
    setTextWithTitle('detail-modal-info-date', formatEventDateSpanCompact(ev.date, ev.endDate));
    const infoTime = $('detail-modal-info-time');
    if (infoTime) {
        if (isMultiDay) infoTime.textContent = '';
        else setTextWithTitle('detail-modal-info-time', eventTimeRange(ev) || t('home_all_day', 'All day'));
        infoTime.style.display = isMultiDay ? 'none' : 'inline';
    }
    show('detail-modal-when-sep', !isMultiDay, 'inline');

    const location = typeof ev.location === 'string' ? ev.location.trim() : '';
    setTextWithTitle('detail-modal-info-where', location || t('events_no_location', 'Not specified'));
    const mapLink = $('detail-modal-map-link');
    if (mapLink) {
        // Online meetings and links get no map (like the Android app): "Zoom-Meeting", "https://meet.google.com/…"
        const isPlace = location && !/\b(online|zoom|teams|skype|jitsi|discord)\b|meet\.google|https?:\/\/|^meet$|keine angabe/i.test(location);
        mapLink.href = isPlace ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}` : '#';
        mapLink.style.display = isPlace ? 'inline-flex' : 'none';
    }

    const tags = $('detail-modal-tags');
    if (tags) {
        tags.innerHTML = '';
        tags.style.display = 'none';
    }

    const description = ev.description?.trim();
    const descCard = $('detail-modal-desc-card');
    if (description) {
        $('detail-modal-description')?.replaceChildren(renderMarkdown(description));
        $('detail-modal-desc-wrap')?.classList.remove('is-clamped', 'is-expanded');
        show('detail-desc-toggle-btn', false);
        setDescriptionToggle(false);
    }
    if (descCard) descCard.style.display = description ? 'block' : 'none';
}

// Long descriptions are clamped behind a "Mehr anzeigen" toggle (measured once the page is shown)
function clampDetailDescription() {
    const descCard = $('detail-modal-desc-card');
    requestAnimationFrame(() => {
        const wrap = $('detail-modal-desc-wrap');
        if (wrap && descCard && descCard.style.display !== 'none' && wrap.scrollHeight > 120) {
            wrap.classList.add('is-clamped');
            show('detail-desc-toggle-btn', true, 'inline-flex');
        }
    });
}

async function loadEventAttendees(eventId) {
    try {
        const res = await api(`/events/${eventId}/attendees`);
        if (!res.ok) return;
        const data = await res.json();
        const registered = data.registered || [];
        const waitlist = data.waitlist || [];
        setText('detail-attendees-count', registered.length);
        setText('detail-attendees-label-text', registered.length ? t('events_attendees', 'Participants') : t('events_attendees_none', 'Nobody registered yet'));
        show('detail-attendees-count', registered.length > 0, 'inline-flex');
        // Overlapping avatar stack of the first attendees
        const stack = $('detail-attendees-stack');
        if (stack) {
            const shown = registered.slice(0, 5);
            stack.innerHTML = shown.map(att => renderAvatarWrap(att.guest ? '' : att.userId, att.name, { wrapClass: 'avatar-stack-item' })).join('')
                + (registered.length > shown.length ? `<span class="avatar-stack-more">+${registered.length - shown.length}</span>` : '');
            stack.style.display = shown.length ? 'flex' : 'none';
        }
        const itemsEl = $('detail-attendees-items');
        if (!itemsEl) return;
        const canManage = currentDetailEvent && currentDetailEvent.canEdit;
        // Guests signed up without an account (shared link): marked; the e-mail address and age only reach editors
        const guestInfo = att => `
                <span class="event-attendee-info">
                    <span class="event-attendee-name">${escapeHtml(att.name)} <span class="event-attendee-guest">${t('events_attendee_guest', 'Guest')}</span></span>
                    ${att.email ? `<span class="event-attendee-contact"><a href="mailto:${escapeHtml(att.email)}">${escapeHtml(att.email)}</a>${Number.isFinite(att.age) ? ` · ${t('events_attendee_age', 'Age {age}', { age: att.age })}` : ''}</span>` : ''}
                </span>`;
        const row = (att, isWaitlist) => `
            <div class="event-attendee-row ${isWaitlist ? 'is-waitlist' : ''}">
                ${renderAvatarWrap(att.guest ? '' : att.userId, att.name, { wrapClass: 'event-attendee-avatar' })}
                ${att.guest ? guestInfo(att) : `<span class="event-attendee-name">${escapeHtml(att.name)}</span>`}
                ${canManage ? `
                <button type="button" class="event-attendee-remove" onclick="window.removeEventAttendee(${jsArg(eventId)}, ${jsArg(att.userId)})" title="${isWaitlist ? t('events_attendee_remove_waitlist', 'Remove from waiting list') : t('events_attendee_remove', 'Remove participant')}" aria-label="${t('btn_remove', 'Remove')}">
                    ${svgIcon('x', 13, 2.5)}
                </button>` : ''}
            </div>`;
        itemsEl.innerHTML = registered.map(att => row(att, false)).join('')
            + (waitlist.length ? `<div class="event-attendees-sub">${t('home_waitlist', 'Waiting list')} · ${waitlist.length}</div>${waitlist.map(att => row(att, true)).join('')}` : '')
            || `<div class="event-attendees-empty">${t('events_attendees_empty', 'As soon as someone registers, they will appear here.')}</div>`;
    } catch (err) {
        console.warn('Failed to load event attendees:', err);
    }
}

async function removeEventAttendee(eventId, userId) {
    if (!confirmAction(t('events_attendee_remove_confirm', 'Do you really want to remove this participant from the list?'))) return;
    await eventAction(`/events/${eventId}/attendees/${userId}`, 'DELETE', undefined, {
        success: t('events_attendee_removed', 'Participant removed'), successType: 'info', error: t('events_attendee_remove_error', 'Failed to remove the participant'), useServerError: false,
        after: () => loadEventAttendees(eventId)
    });
}

// --- Sharing an event: the share button opens the link to copy or to hand to the system share sheet. Whoever may
// edit the event decides with a switch whether people without an account can open it: they see the event and sign
// up as guests (full name, e-mail address, age). The link then carries the event's share key (?share=). ---
const GUEST_KEYS_STORAGE = 'agora_guest_keys';
// Same as the server (backend/eventGuests.js): a guest's details are deleted this many days after the event
const GUEST_RETENTION_DAYS = 30;
const linkParam = name => new URLSearchParams(window.location.search).get(name) || '';
// A shared event's link, or the link in a guest's e-mails (?guest= their own key)
const hasGuestLink = () => !!(linkParam('share') || linkParam('guest'));
// While the page shows a shared event to a visitor: { anon (nobody signed in), token, event, mine, formOpen }
let guestView = null;

/** The link of an event: the members' address, with the share key while people without an account may open it. */
function eventShareUrl(ev) {
    const base = `${window.location.origin}/events/${encodeURIComponent(eventSlug(ev))}`;
    return ev.isPublic && ev.publicToken ? `${base}?share=${encodeURIComponent(ev.publicToken)}` : base;
}

// A guest knows the event's title only: the address gets the same readable name, the share key finds the event
const guestShareUrl = (ev, token) => `${window.location.origin}/events/${encodeURIComponent(slugify(ev.title) || 'event')}?share=${encodeURIComponent(token)}`;

/** What the share sheet offers: the event a member has open, or the shared event a guest is looking at. */
function shareTarget() {
    if (guestView) return guestView.event && guestView.token ? { ev: guestView.event, url: guestShareUrl(guestView.event, guestView.token), isPublic: true, canEdit: false } : null;
    const ev = currentDetailEvent;
    return ev ? { ev, url: eventShareUrl(ev), isPublic: ev.isPublic === true, canEdit: ev.canEdit === true } : null;
}

const canShareNatively = url => typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare({ url }));

function renderEventShare() {
    const target = shareTarget();
    if (!target) return;
    const { ev, url, isPublic, canEdit } = target;
    setText('event-share-sub', [ev.title, formatEventDateSpanCompact(ev.date, ev.endDate)].filter(Boolean).join(' · '));
    show('event-share-public-section', canEdit, 'flex');
    const toggle = $('event-share-public');
    if (toggle) toggle.checked = isPublic;
    setText('event-share-public-desc', ev.requiresRegistration
        ? t('events_share_public_desc_reg', 'Anyone with the link sees the event and can sign up – no account needed.')
        : t('events_share_public_desc', 'Anyone with the link sees the event – no account needed.'));
    setValue('event-share-link', url);
    const hint = $('event-share-hint');
    if (hint) {
        hint.classList.toggle('is-public', isPublic);
        hint.innerHTML = `${svgIcon(isPublic ? 'eye' : 'lock', 14, 2)}<span>${isPublic
            ? t('events_share_hint_public', 'Anyone with this link can see the event.')
            : t('events_share_hint_members', 'Only members can open this link.')}</span>`;
    }
    show('event-share-send', canShareNatively(url), 'inline-flex');
}

function openEventShare() {
    if (!shareTarget()) return;
    renderEventShare();
    openModal('event-share-modal');
}

// The switch (only for those who may edit the event; the server checks it again). Off and on again keeps the link.
async function toggleEventPublic(isPublic) {
    const ev = currentDetailEvent;
    const toggle = $('event-share-public');
    if (!ev?.canEdit || !toggle) return;
    toggle.disabled = true;
    try {
        const data = await apiJson(`/events/${encodeURIComponent(ev.id)}`, 'PATCH', { isPublic }, t('events_share_switch_failed', 'The setting could not be saved.'));
        ev.isPublic = data.event?.isPublic === true;
        ev.publicToken = ev.isPublic ? data.event?.publicToken || '' : '';
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        toggle.disabled = false;
        renderEventShare();
    }
}

// The clipboard API needs https: installations on plain http copy the selected field instead (without a field on
// the page: a hidden one just for copying)
async function copyText(text, field) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* the selected field below */ }
    const helper = field ? null : Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    try {
        if (helper) {
            helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            document.body.appendChild(helper);
        }
        const target = field || helper;
        target.focus();
        target.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        helper?.remove();
    }
}

async function copyEventShareLink() {
    const field = $('event-share-link');
    if (!field) return;
    if (await copyText(field.value, field)) showToast(t('events_share_copied', 'Link copied'));
    else showToast(t('events_share_copy_failed', 'The link could not be copied. It is selected, copy it by hand.'), 'error');
}

async function sendEventShareLink() {
    const target = shareTarget();
    if (!target) return;
    try {
        await navigator.share({ title: target.ev.title, url: target.url });
    } catch (err) {
        if (err?.name !== 'AbortError') showToast(t('events_share_failed', 'The link could not be shared.'), 'error');
    }
}

// --- Visitors without an account: the page of a shared event, signing up as a guest, their own places ---
function storedGuestKeys() {
    try {
        const keys = JSON.parse(localStorage.getItem(GUEST_KEYS_STORAGE) || '[]');
        return Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
    } catch {
        return [];
    }
}

function storeGuestKeys(keys) {
    try {
        localStorage.setItem(GUEST_KEYS_STORAGE, JSON.stringify([...new Set(keys)].slice(0, 20)));
    } catch { /* private mode: the link in the e-mail still leads to the registration */ }
}

// The API without an account (no token); answers come in the page's language
async function publicApi(path, method = 'GET', body) {
    const res = await fetch(API + path, {
        method,
        headers: { 'Accept-Language': uiLang, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('error_connection', 'Connection error')), { status: res.status });
    return data;
}

// A failed fetch (offline) has no text for people
const guestError = err => (err instanceof TypeError ? t('error_connection', 'Connection error') : err.message);

/**
 * What a visitor may see: the event of the share link, or of their own registration (the link in their e-mails),
 * and their places on this device. Registrations that are gone (cancelled, removed, over) leave the device.
 */
async function loadGuestView(anon) {
    const token = linkParam('share');
    const ownKey = linkParam('guest');
    const keys = [...new Set([ownKey, ...storedGuestKeys()].filter(Boolean))];
    const found = keys.length ? (await publicApi('/public/guests/lookup', 'POST', { keys })).registrations || [] : [];
    const own = ownKey ? found.find(reg => reg.key === ownKey) || null : null;
    storeGuestKeys(found.map(reg => reg.key));
    const view = { anon, token: '', event: null, mine: [], formOpen: false, ownKeyGone: !!ownKey && !own };
    if (token) {
        try {
            view.event = await publicApi(`/public/events/${encodeURIComponent(token)}`);
            view.token = token;
        } catch (err) {
            if (err.status !== 404) throw err;
        }
    }
    if (!view.event && own) {
        view.event = own.event;
        view.token = own.shareToken || '';
    }
    view.mine = view.token ? found.filter(reg => reg.shareToken === view.token) : own ? [own] : [];
    return view;
}

async function openGuestEvent(anon) {
    await languageReady;
    try {
        guestView = await loadGuestView(anon);
    } catch (err) {
        console.warn('Shared event could not be loaded:', err);
        guestView = { anon, token: '', event: null, mine: [], formOpen: false, failed: true };
    }
    if (!anon) {
        // A member closes it like any page and is back in the app: the link's keys leave the address first (the
        // page's own history entry comes after it)
        history.replaceState(history.state, '', window.location.pathname);
        const modal = $('event-detail-modal');
        if (modal) modal._customOnClose = leaveGuestView;
    }
    renderGuestView();
}

function renderGuestView() {
    const view = guestView;
    const card = detailCard();
    if (!view || !card) return;
    currentDetailEvent = null;
    card.classList.add('is-guest-view');
    card.classList.toggle('is-guest-anon', view.anon);
    card.classList.toggle('is-guest-missing', !view.event);
    setText('guest-event-app-name', APP_NAME);
    show('guest-sign-in-btn', view.anon, '');
    show('detail-share-btn', !!(view.event && view.token), '');
    if (view.event) {
        renderDetailBasics(view.event);
        show('detail-modal-reg-box', !!view.event.requiresRegistration, 'block');
        if (view.event.requiresRegistration) {
            renderCapacity(view.event);
            renderGuestRegistration();
        }
        document.title = `${view.event.title} · ${APP_NAME}`;
        // Once the share link is known the address shows it, not the guest's own key: copied from the address bar
        // it shares the event, never the registration
        if (view.token && linkParam('guest')) history.replaceState(history.state, '', guestShareUrl(view.event, view.token).slice(window.location.origin.length));
    } else {
        // The link does not work (any more): switched off or the event deleted; or the registration is gone
        renderDetailBasics({ title: '' });
        const [title, text] = view.failed
            ? [t('guest_load_failed', 'The event could not be loaded'), t('guest_load_failed_text', 'Please check the connection and try again.')]
            : view.ownKeyGone
                ? [t('guest_reg_gone', 'This registration no longer exists'), t('guest_reg_gone_text', 'It was cancelled, or the event is over.')]
                : [t('guest_link_inactive', 'This link is not active'), t('guest_link_inactive_text', 'Only members can see this event. Ask whoever sent you the link.')];
        setText('guest-event-message-title', title);
        setText('guest-event-message-text', text);
        document.title = APP_NAME;
    }
    if (!$('event-detail-modal')?.classList.contains('show')) openModal('event-detail-modal');
    fitDetailWhere();
    clampDetailDescription();
}

// The registration card of a guest: their places on this device (cancel), then the form or why it is closed
function renderGuestRegistration() {
    const view = guestView;
    const ev = view?.event;
    const wrap = $('detail-modal-reg-action-wrap');
    if (!ev || !wrap) return;
    const places = view.mine.map(reg => {
        const waiting = reg.status === 'waitlist';
        const title = waiting ? t('guest_reg_waitlist', '{name} is on the waiting list', { name: reg.name }) : t('guest_reg_registered', '{name} is registered', { name: reg.name });
        const sub = waiting ? t('events_reg_waitlist_hint', 'You will move up as soon as a place becomes free.') : t('events_reg_looking_forward', 'We look forward to seeing you!');
        const cancel = ev.isPast ? '' : `<button type="button" class="event-reg-status-action" onclick="window.cancelGuestRegistration(${jsArg(reg.key)})">${t('events_reg_unregister', 'Unregister')}</button>`;
        return regBanner(waiting ? 'is-waitlist' : 'is-registered', waiting ? 'clock' : 'check', escapeHtml(title), sub, cancel);
    });
    const action = ev.status === 'cancelled' ? regBanner('is-past', 'x', t('guest_event_cancelled', 'This event was cancelled.'), '')
        : ev.isPast ? regBanner('is-past', 'clock', t('events_reg_closed', 'Registration has closed'), t('events_reg_event_over', 'The event is over.'))
        // The link was switched off: own places only, nobody new
        : !view.token ? ''
        : view.mine.length && !view.formOpen ? `<button type="button" class="guest-link-btn guest-reg-another" onclick="window.openGuestForm()">${svgIcon('plus', 15, 2.5)}<span>${t('guest_reg_another', 'Sign up another person')}</span></button>`
        : guestFormHtml(ev);
    wrap.innerHTML = `<div class="guest-reg">${places.join('')}${action}</div>`;
}

const guestFormHtml = ev => `
    <form class="guest-reg-form" onsubmit="event.preventDefault(); window.submitGuestRegistration()">
        ${ev.isFull ? `<p class="guest-reg-full">${svgIcon('clock', 14, 2)}<span>${t('guest_reg_full', 'Fully booked: you can join the waiting list.')}</span></p>` : ''}
        <label class="guest-reg-field"><span>${t('guest_reg_name', 'Full name')}</span>
            <input type="text" id="guest-reg-name" class="form-input" autocomplete="name" maxlength="100" required placeholder="${escapeHtml(t('guest_reg_name_ph', 'First and last name'))}"></label>
        <div class="guest-reg-row">
            <label class="guest-reg-field"><span>${t('guest_reg_email', 'E-mail address')}</span>
                <input type="email" id="guest-reg-email" class="form-input" autocomplete="email" maxlength="254" required></label>
            <label class="guest-reg-field"><span>${t('guest_reg_age', 'Age')}</span>
                <input type="number" id="guest-reg-age" class="form-input" inputmode="numeric" min="0" max="120" step="1" required></label>
        </div>
        <input type="text" id="guest-reg-hp" class="guest-reg-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <p id="guest-reg-error" class="guest-reg-error" role="alert" hidden></p>
        <p class="guest-reg-note">${t('guest_reg_note', 'Your details are only used for this event and deleted {days} days after it.', { days: GUEST_RETENTION_DAYS })} <a href="/privacy" target="_blank" rel="noopener">${t('guest_privacy', 'Privacy')}</a></p>
        <button type="submit" id="guest-reg-submit" class="btn ${ev.isFull ? 'btn-secondary' : 'btn-primary'} btn-block">${svgIcon(ev.isFull ? 'clock' : 'check', 15, 2.5)}<span>${ev.isFull ? t('events_reg_join_waitlist', 'Join the waiting list') : t('events_reg_register', 'Register')}</span></button>
    </form>`;

function openGuestForm() {
    if (!guestView) return;
    guestView.formOpen = true;
    renderGuestRegistration();
    $('guest-reg-name')?.focus();
}

async function submitGuestRegistration() {
    const view = guestView;
    if (!view?.token) return;
    const button = $('guest-reg-submit');
    const error = $('guest-reg-error');
    if (error) error.hidden = true;
    if (button) button.disabled = true;
    try {
        const data = await publicApi(`/public/events/${encodeURIComponent(view.token)}/register`, 'POST', {
            name: inputValue('guest-reg-name'), email: inputValue('guest-reg-email'), age: inputValue('guest-reg-age'), website: inputValue('guest-reg-hp')
        });
        storeGuestKeys([data.key, ...storedGuestKeys()]);
        view.mine = [...view.mine, { key: data.key, name: data.name, status: data.status, shareToken: view.token }];
        if (data.event) view.event = data.event;
        view.formOpen = false;
        renderCapacity(view.event);
        renderGuestRegistration();
        const done = data.status === 'waitlist' ? t('guest_reg_waitlist_done', 'You are on the waiting list.') : t('guest_reg_done', 'You are registered.');
        showToast(data.emailed ? `${done} ${t('guest_reg_emailed', 'A confirmation is on its way by e-mail.')}` : done);
    } catch (err) {
        if (error) {
            error.textContent = guestError(err);
            error.hidden = false;
        }
    } finally {
        if (button) button.disabled = false;
    }
}

async function cancelGuestRegistration(key) {
    const view = guestView;
    const reg = view?.mine.find(entry => entry.key === key);
    if (!reg || !confirmAction(t('guest_reg_cancel_confirm', 'Do you really want to cancel the registration of {name}?', { name: reg.name }))) return;
    try {
        await publicApi('/public/guests/cancel', 'POST', { key });
        storeGuestKeys(storedGuestKeys().filter(stored => stored !== key));
        view.mine = view.mine.filter(entry => entry.key !== key);
        // Fresh places (someone may have moved up); without the share link only the own places change
        if (view.token) view.event = await publicApi(`/public/events/${encodeURIComponent(view.token)}`).catch(() => view.event);
        renderCapacity(view.event);
        renderGuestRegistration();
        showToast(t('guest_reg_cancelled', 'The registration is cancelled.'));
    } catch (err) {
        showToast(guestError(err), 'error');
    }
}

// Members who open the link signed out (another browser, the phone) sign in; the app then opens the event
function showGuestSignIn() {
    const login = $('login-modal');
    if (!login) return;
    login.style.zIndex = '2600';
    show('login-back-to-event', true, 'inline-flex');
    showAuthForm(true);
    login.classList.add('show');
}

function closeGuestSignIn() {
    const login = $('login-modal');
    if (login) {
        login.classList.remove('show');
        login.style.zIndex = '2000';
    }
    show('login-back-to-event', false);
}

// Back to the members' page: an event opened the normal way, or signed in
function leaveGuestView() {
    if (!guestView) return;
    guestView = null;
    detailCard()?.classList.remove('is-guest-view', 'is-guest-anon', 'is-guest-missing');
    show('detail-share-btn', true, '');
    document.title = APP_NAME;
}

// Signed out there is no app behind the shared event: the page stays (back gesture, Escape)
// Leaving an event being edited (Escape, back gesture, close) asks first when something changed - like the song and
// prayer editors; saving and "Cancel" end the edit mode before closing
modalCloseGuards['event-detail-modal'] = () => !guestView?.anon
    && (!detailCard()?.classList.contains('detail-is-editing') || eventEditState() === eventEditSnapshot
        || confirmAction(t('songbook_discard', 'Discard your changes?')));

// --- Duty planner (tasks grouped by role) ---
function renderGroupedDuties(duties, ev) {
    const container = $('detail-modal-duties-sections');
    if (!container) return;
    container.innerHTML = renderDutyPlan(duties || [], programEvent?.id === ev.id ? programItems : [], ev);
}

async function toggleEventRegistration(eventId, currentStatus) {
    if (!currentUser) return;
    const cancel = currentStatus === 'registered' || currentStatus === 'waitlist';
    await eventAction(`/events/${eventId}/register`, 'POST', { action: cancel ? 'cancel' : 'register' }, {
        success: data => cancel ? t('events_unregistered_success', 'Unregistered successfully') : data.isWaitlist ? t('events_waitlist_success', 'Added to the waiting list') : t('events_registered_success', 'Registered successfully!'),
        successType: data => cancel ? 'info' : data.isWaitlist ? 'warning' : 'success',
        error: t('error_action_failed', 'Action failed'),
        after: () => { if (currentDetailEvent?.id === eventId && shownModal('event-detail-modal')) openEventDetailModal(eventId); }
    });
}

async function deleteEvent(eventId) {
    if (!confirmAction(t('events_delete_confirm', 'Do you really want to delete this event?'))) return;
    await eventAction(`/events/${eventId}`, 'DELETE', undefined, {
        success: t('events_deleted_success', 'Event deleted'), error: t('toast_delete_failed_short', 'Deletion failed'), networkError: t('events_delete_error', 'Failed to delete the event'), after: () => {}
    });
}

// --- Event cover image cropping (16:9) ---
let eventCropper = null;

async function openEventCrop(file) {
    const viewport = $('eventCropViewport');
    const img = $('eventCropImage');
    const overlay = $('eventCropOverlay');
    if (!viewport || !img || !overlay) return;
    eventCropper = await initCropper({
        viewport, img, overlay,
        zoomSlider: $('eventCropZoom'),
        src: await readAsDataUrl(await convertHeic(file, 0.85, file.name || 'image')),
        fallbackSize: [800, 600],
        layout: (width, nw, nh) => {
            const vw = width || 480;
            const cropW = Math.round(vw * 0.94);
            const cropH = Math.round(cropW * (9 / 16));
            return { vw, vh: Math.max(260, Math.round(vw * (9 / 16))), cropW, cropH, scale: Math.max(cropW / nw, cropH / nh) };
        }
    });
    openModal('event-crop-modal');
}

async function confirmEventCrop() {
    if (!eventCropper) return;
    const { x, y, scaleX, scaleY } = eventCropper.region();
    const blob = await cropToJpeg(eventCropper.img, [x, y, Math.round(eventCropper.cropW * scaleX), Math.round(eventCropper.cropH * scaleY)], 1280, 720, 0.82);
    if (!blob) return showToast(t('crop_error', 'Failed to crop the image.'), 'error');
    setButtonLoading('btn-confirm-event-crop', true, t('saving_short', 'Saving...'));
    try {
        const token = await getToken();
        const res = await fetch(`${API}/events/upload-image`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: toFormData({ image: new File([blob], 'event-cover-16-9.jpg', { type: 'image/jpeg' }) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || t('toast_upload_failed_short', 'Upload failed'), 'error');
        setValue('detail-edit-image-url', data.url);
        showDetailCover(data.url);
        show('detail-edit-cover-placeholder', false);
        closeModal('event-crop-modal');
        showToast(t('events_cover_applied', 'Event image applied in 16:9 format!'), 'success');
    } catch (e) {
        console.error('Crop upload error:', e);
        showToast(t('events_cover_save_error', 'Failed to save the event image'), 'error');
    } finally {
        setButtonLoading('btn-confirm-event-crop', false, null);
    }
}

// --- Calendar subscription (WebCal feed) ---
let cachedCalendarFeed = null;

async function fetchPersonalCalendarFeed(force = false) {
    if (cachedCalendarFeed && !force) return cachedCalendarFeed;
    try {
        const res = await api('/user/calendar-feed');
        if (res.ok) return (cachedCalendarFeed = await res.json());
    } catch (err) {
        console.warn('Failed to load personal calendar feed:', err);
    }
    // Without the server's personal link there is no working URL (it needs the calendar token)
    return { feedUrl: '', webcalUrl: '', calendarToken: '' };
}

// The personal feed URL, or '' with an error toast when it could not be loaded
async function personalFeedUrl() {
    const url = (await fetchPersonalCalendarFeed())?.feedUrl || cachedCalendarFeed?.feedUrl || '';
    if (!url) showToast(t('calendar_feed_unavailable', 'The calendar link could not be loaded. Please try again later.'), 'error');
    return url;
}

async function loadPersonalCalendarFeedSettings(force = false) {
    const feed = await fetchPersonalCalendarFeed(force);
    ['user-cal-feed-url', 'admin-cal-feed-url'].forEach(id => setValue(id, feed.feedUrl));
}

async function copyPersonalCalendarFeedUrl() {
    const url = await personalFeedUrl();
    if (!url) return;
    const field = ['user-cal-feed-url', 'admin-cal-feed-url'].map($).find(el => el?.offsetParent);
    if (await copyText(url, field)) showToast(t('calendar_sub_copied', 'Calendar URL copied to clipboard!'), 'success');
    else showToast(t('calendar_sub_copy_error', 'Failed to copy the calendar URL'), 'error');
}

async function resetCalendarFeedToken() {
    if (!confirmAction(t('calendar_sub_reset_confirm', 'Do you really want to generate a new calendar link? Your previous calendar link will stop working and you will have to subscribe to the calendar again in your apps.'))) return;
    try {
        const res = await api('/user/calendar-feed/reset', 'POST');
        if (!res.ok) return showToast(t('calendar_sub_reset_error', 'Failed to reset the link'), 'error');
        cachedCalendarFeed = await res.json();
        await loadPersonalCalendarFeedSettings(true);
        showToast(t('calendar_sub_reset_success', 'New calendar link successfully generated!'), 'success');
    } catch {
        showToast(t('calendar_sub_reset_network_error', 'Connection error while resetting'), 'error');
    }
}

// --- Detail modal: inline edit mode (create & edit) ---
/** Everything typed or chosen in the event editor, to notice changes. */
let eventEditSnapshot = '';
const eventEditState = () => JSON.stringify([...(detailCard()?.querySelectorAll('[id^="detail-edit-"], .detail-edit-group-check, input[type="checkbox"]') || [])]
    .filter(el => 'value' in el).map(el => (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value)));

function enterDetailEditMode() {
    const ev = currentDetailEvent;
    const card = detailCard();
    if (!card) return;
    card.classList.add('detail-is-editing');
    setValue('detail-edit-title', ev ? ev.title || '' : '');

    // Only event managers may choose between appointment ("Termin") and event
    const canManage = canManageEvents();
    card.classList.toggle('can-manage-events', canManage);
    syncTypeSelector(canManage);
    setDetailEditType(canManage ? (ev ? ev.eventType || (ev.isOfficialTermin ? 'termin' : 'event') : 'termin') : 'event');
    const isPinned = ev?.isPinned === true;
    const pinnedCheck = $('detail-edit-pinned');
    if (pinnedCheck) pinnedCheck.checked = isPinned;
    $('detail-edit-pinned-wrap')?.classList.toggle('is-active', isPinned);

    const isMultiDay = Boolean(ev && ev.endDate && ev.endDate !== ev.date);
    const multiDayCheck = $('detail-edit-is-multiday');
    if (multiDayCheck) multiDayCheck.checked = isMultiDay;
    toggleDetailMultiDay(isMultiDay);
    const timeFields = { 'detail-edit-end-date': 'endDate', 'detail-edit-start-time': 'startTime', 'detail-edit-end-time': 'endTime' };
    if (ev) {
        setValue('detail-edit-date', ev.date || '');
    } else if ($('detail-edit-date') && !inputValue('detail-edit-date')) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        setValue('detail-edit-date', toDateStr(tomorrow));
    }
    for (const [id, key] of Object.entries(timeFields)) setValue(id, ev ? ev[key] || '' : '');

    const recurringCheck = $('detail-edit-is-recurring');
    if (recurringCheck) recurringCheck.checked = false;
    show('detail-recurring-options-panel', false);
    setValue('detail-edit-location', ev ? ev.location || '' : '');
    const descInput = $('detail-edit-description');
    if (descInput) {
        descInput.value = ev ? ev.description || '' : '';
        autoResizeDetailTextarea(descInput);
    }

    const requiresReg = ev?.requiresRegistration === true;
    const regCheck = $('detail-edit-requires-reg');
    if (regCheck) regCheck.checked = requiresReg;
    setValue('detail-edit-min-participants', ev?.minParticipants || '');
    setValue('detail-edit-max-participants', ev?.maxParticipants || '');
    toggleDetailRegFields(requiresReg);

    const image = eventImage(ev);
    setValue('detail-edit-image-url', image);
    showDetailCover(image);
    show('detail-edit-cover-placeholder', !image, 'flex');

    const selectedGroups = ev ? ev.targetGroups || [] : [];
    populateDetailEditTargetGroups(selectedGroups);
    eventEditSnapshot = eventEditState();
    if (groupList().length === 0) loadSystemGroups().then(() => {
        const untouched = eventEditState() === eventEditSnapshot;
        populateDetailEditTargetGroups(selectedGroups);
        if (untouched) eventEditSnapshot = eventEditState();
    });
    show('detail-modal-action-bar', true, 'flex');
    setText('detail-btn-save-text', ev ? t('btn_save', 'Save') : t('events_btn_publish_short', 'Publish'));
}

function cancelDetailEditMode() {
    detailCard()?.classList.remove('detail-is-editing', 'detail-is-new', 'can-manage-events');
    hideTypeSelector();
    if (!currentDetailEvent) return closeModal('event-detail-modal');
    show('detail-edit-cover-placeholder', false);
    setCoverVisible(!!eventImage(currentDetailEvent));
}

async function saveDetailEditMode() {
    const title = inputValue('detail-edit-title').trim();
    const date = inputValue('detail-edit-date').trim();
    const isMultiDay = isChecked('detail-edit-is-multiday');
    const canManage = canManageEvents();
    const eventType = canManage ? inputValue('detail-edit-type') || 'event' : 'event';
    // Recurring series only for new appointments created by event managers
    const isRecurring = canManage && !currentDetailEvent && eventType === 'termin' && isChecked('detail-edit-is-recurring');
    const recurringCount = isRecurring ? Math.min(52, Math.max(2, parseInt(inputValue('detail-edit-recurring-count'), 10) || 10)) : 1;
    const payload = {
        title,
        date,
        // Multi-day events have an end date but no times
        endDate: isMultiDay ? inputValue('detail-edit-end-date').trim() : '',
        startTime: isMultiDay ? '' : inputValue('detail-edit-start-time').trim(),
        endTime: isMultiDay ? '' : inputValue('detail-edit-end-time').trim(),
        location: inputValue('detail-edit-location').trim(),
        description: inputValue('detail-edit-description').trim(),
        imageUrl: inputValue('detail-edit-image-url').trim(),
        eventType,
        isPinned: canManage && eventType === 'event' && isChecked('detail-edit-pinned'),
        requiresRegistration: isChecked('detail-edit-requires-reg'),
        minParticipants: parseInt(inputValue('detail-edit-min-participants'), 10) || 0,
        maxParticipants: parseInt(inputValue('detail-edit-max-participants'), 10) || 0,
        targetGroups: [...document.querySelectorAll('#detail-edit-target-groups-container .detail-group-chip.is-selected')].map(chip => chip.dataset.group).filter(Boolean),
        isRecurring,
        recurringRule: inputValue('detail-edit-recurring-rule') || 'weekly',
        recurringCount
    };
    if (!title) {
        showToast(t('events_title_required', 'Please enter a title'), 'warning');
        return $('detail-edit-title')?.focus();
    }
    if (!date) {
        showToast(t('events_date_required', 'Please enter a date'), 'warning');
        return $('detail-edit-date')?.focus();
    }
    if (isMultiDay && payload.endDate && payload.endDate < date) return showToast(t('events_end_before_start', 'The end date must not be before the start date'), 'warning');

    const saveBtn = $('detail-btn-save');
    if (saveBtn) saveBtn.disabled = true;
    setText('detail-btn-save-text', t('saving_short', 'Saving...'));
    try {
        const eventId = currentDetailEvent ? currentDetailEvent.id : null;
        const res = await api(eventId ? `/events/${eventId}` : '/events', eventId ? 'PATCH' : 'POST', payload);
        const saved = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(saved.error || t('alert_save_error', 'Error while saving.'), 'error');
        showToast(eventId ? t('events_updated_success', 'Updated successfully!') : (isRecurring ? t('events_series_created', '{count} appointments created successfully!', { count: recurringCount }) : t('events_published_success', 'Published successfully!')), 'success');
        detailCard()?.classList.remove('detail-is-editing', 'detail-is-new');
        hideTypeSelector();
        await loadEventsData();
        const reopenId = eventId || saved.id || saved._id || saved.event?.id || saved.event?._id;
        if (reopenId) openEventDetailModal(reopenId);
        else closeModal('event-detail-modal');
    } catch (err) {
        console.error('saveDetailEditMode error:', err);
        showToast(t('events_save_network_error', 'Connection error while saving'), 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
        setText('detail-btn-save-text', currentDetailEvent ? t('btn_save', 'Save') : t('events_btn_publish_short', 'Publish'));
    }
}

function openNewEventDetailModal(defaultType) {
    currentDetailEvent = null;
    const canManage = canManageEvents();
    const type = canManage ? defaultType || 'termin' : 'event';
    const card = detailCard();
    card?.classList.remove('detail-is-editing', 'detail-is-new', 'has-hero-image');
    card?.classList.toggle('can-manage-events', canManage);
    syncTypeSelector(canManage);
    show('detail-modal-cover-wrap', false);
    const coverImg = $('detail-modal-cover-img');
    if (coverImg) coverImg.src = '';
    setText('detail-modal-title', type === 'event' ? t('events_btn_new', 'New Event') : t('events_new_termin', 'New Appointment'));
    show('detail-modal-organizer-pill', false);
    show('detail-modal-groups-line', false);
    const tags = $('detail-modal-tags');
    if (tags) {
        tags.innerHTML = '';
        tags.style.display = 'none';
    }
    ['detail-modal-reg-box', 'detail-modal-duties-box', 'detail-modal-desc-card'].forEach(id => show(id, true, 'block'));
    show('detail-modal-action-bar', true, 'flex');
    show('detail-btn-edit', false);
    show('detail-btn-delete', false);
    openModal('event-detail-modal');
    card?.classList.add('detail-is-editing', 'detail-is-new');
    enterDetailEditMode();
    setDetailEditType(type);
    eventEditSnapshot = eventEditState();
}

function setDetailEditType(type) {
    const canManage = canManageEvents();
    const isTermin = canManage && type === 'termin';
    setValue('detail-edit-type', isTermin ? 'termin' : 'event');
    syncTypeSelector(canManage);
    $('detail-type-card-termin')?.classList.toggle('is-active', isTermin);
    $('detail-type-card-event')?.classList.toggle('is-active', !isTermin);
    setText('detail-type-desc-text', isTermin
        ? t('events_type_termin_desc', 'Regular appointment (e.g. bistro, prayer meeting, rehearsal) – appears in the appointment calendar.')
        : t('events_type_event_desc', 'Special event (e.g. youth night, concert, festival) – with cover image & program.'));
    show('detail-edit-pinned-wrap', canManage && !isTermin, 'flex');
    show('detail-edit-recurring-toggle-wrap', canManage && isTermin && !currentDetailEvent, 'inline-flex');
    setText('detail-edit-heading', currentDetailEvent
        ? (isTermin ? t('events_edit_termin', 'Edit appointment') : t('events_edit_event', 'Edit event'))
        : (isTermin ? t('events_new_termin', 'New Appointment') : t('events_btn_new', 'New Event')));
}

function toggleDetailMultiDay(isMultiDay) {
    show('detail-field-end-date', isMultiDay, 'flex');
    show('detail-when-time-row', !isMultiDay, 'grid');
    show('detail-multiday-hint', isMultiDay, 'flex');
    const dateLabel = document.querySelector('label[for="detail-edit-date"]');
    if (dateLabel) dateLabel.textContent = isMultiDay ? t('modal_date_start', 'Start Date') : t('modal_date', 'Date');
    if (isMultiDay && !inputValue('detail-edit-end-date') && inputValue('detail-edit-date')) setValue('detail-edit-end-date', inputValue('detail-edit-date'));
}

function toggleDetailRegFields(enabled) {
    show('detail-edit-reg-options', enabled, 'block');
    document.querySelector('.detail-reg-card')?.classList.toggle('is-active', enabled);
}

function populateDetailEditTargetGroups(selectedGroups = []) {
    const container = $('detail-edit-target-groups-container');
    if (!container) return;
    container.innerHTML = groupList().length === 0
        ? `<span style="font-size:0.78rem; color:var(--text-secondary);">${t('events_public_all_members', 'Public for all members')}</span>`
        : groupList().map(g => {
            const name = g.name || g.id;
            return `
                <button type="button" class="detail-group-chip ${selectedGroups.includes(name) || selectedGroups.includes(g.id) ? 'is-selected' : ''}" data-group="${escapeHtml(name)}" onclick="this.classList.toggle('is-selected')">
                    <svg class="detail-group-chip-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span>${escapeHtml(name)}</span>
                </button>`;
        }).join('');
}

function autoResizeDetailTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(300, Math.max(85, textarea.scrollHeight)) + 'px';
}

Object.assign(window, {
    openEventShare, loadEventsData, toggleEventPublic, copyEventShareLink, sendEventShareLink, openGuestForm, submitGuestRegistration, cancelGuestRegistration,
    showGuestSignIn, closeGuestSignIn,
    switchEventsSubTab, shiftTermineMonth, jumpToTermineDay, respondToDutyRequest, openEventDetailModal, toggleDetailDescription, removeEventAttendee, 
     toggleEventRegistration, confirmEventCrop, copyPersonalCalendarFeedUrl, resetCalendarFeedToken,
    enterDetailEditMode, cancelDetailEditMode, saveDetailEditMode, openNewEventDetailModal, setDetailEditType, toggleDetailMultiDay,
    toggleDetailRegFields, autoResizeDetailTextarea,
    handleEventsSearchInput: setEventsSearch,
    clearEventsSearch: () => {
        setValue('events-search-input', '');
        setEventsSearch('');
    },
    toggleShowPastEvents: () => {
        showPastEvents = !showPastEvents;
        renderEvents();
    },
    deleteCurrentEventFromDetail: () => {
        if (!currentDetailEvent) return;
        const eventId = currentDetailEvent.id;
        closeModal('event-detail-modal');
        deleteEvent(eventId);
    },
    resetEventCropZoom: () => eventCropper?.setZoom(1),
    cancelEventCrop: () => closeModal('event-crop-modal'),
    openWebCalDirectly: async () => {
        const url = await personalFeedUrl();
        if (url) window.location.href = url.replace(/^https?:/, 'webcal:');
    },
    openGoogleCalendarSubscription: async () => {
        const url = await personalFeedUrl();
        if (url) window.open(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
    },
    downloadIcsFile: async () => {
        const url = await personalFeedUrl();
        if (url) window.open(url, '_blank', 'noopener');
    },
    toggleDetailPinnedState: pinned => $('detail-edit-pinned-wrap')?.classList.toggle('is-active', pinned),
    toggleDetailRecurring: recurring => show('detail-recurring-options-panel', recurring, 'block'),
    detailEditSelectImage: () => {
        const fileInput = $('detail-edit-file-input');
        if (!fileInput) return;
        fileInput.value = '';
        fileInput.click();
    },
    detailEditRemoveImage: () => {
        setValue('detail-edit-image-url', '');
        showDetailCover('');
        show('detail-edit-cover-placeholder', true, 'flex');
    },
    detailEditImageFileSelected: async files => {
        if (!files || !files[0]) return;
        await openEventCrop(files[0]);
        setValue('detail-edit-file-input', '');
    }
});
