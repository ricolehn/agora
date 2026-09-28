import { initializeApp, getDatabase, ref, set, get, child, update, query, orderByChild, equalTo, runTransaction, getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, apiGet } from "./pocketbase-compat.js";
import { config } from "./config.js";

const db = getDatabase(initializeApp(config));
const auth = getAuth();
const API = config.apiBaseUrl;
const APP_NAME = config.appName || 'Agora';

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
function escapeHtml(text) {
    return text ? String(text).replace(/[&<>"']/g, m => HTML_ESCAPES[m]) : '';
}

const numberFormatter = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthYearFormatter = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function formatCurrency(amount) {
    const num = parseFloat(amount);
    return isNaN(num) ? '0,00' : numberFormatter.format(num);
}
const euro = amount => `${formatCurrency(amount)} €`;

function formatDateFast(dateInput) {
    if (!dateInput) return '';
    const str = String(dateInput);
    if (str.length === 10 && str[4] === '-' && str[7] === '-') return `${str.slice(8, 10)}.${str.slice(5, 7)}.${str.slice(0, 4)}`;
    const d = new Date(dateInput);
    return Number.isNaN(d.getTime()) ? 'Kein Datum' : dateFormatter.format(d);
}

const pad2 = n => String(n).padStart(2, '0');
const toDateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const getTodayStr = () => toDateStr(new Date());
const normalizeAmount = raw => String(raw ?? '').replace(/\.(?=.*,)/g, '').replace(',', '.').trim();
const parseAmount = raw => parseFloat(normalizeAmount(raw));

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

function setButtonLoading(btnId, isLoading, loadingText = 'Laden...') {
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

const isHeic = (name = '', type = '') => /\.hei[cf]$/i.test(name) || type === 'image/heic' || type === 'image/heif';

// Converts HEIC/HEIF files/blobs to JPEG via heic2any; returns the input unchanged when not HEIC or on failure.
async function convertHeic(file, quality, name = file.name) {
    if (!isHeic(name, file.type) || typeof heic2any !== 'function') return file;
    try {
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
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
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
            ? `<img src="${file.previewUrl}" style="${STYLE.thumb}" alt="Beleg">`
            : `<div style="width:40px; height:40px; background:var(--surface); border-radius:8px; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; color:var(--text-secondary);">${svgIcon('file', 20)}</div>`;
        return fileRow(preview, file.name, iconButton(`${remove}(${index})`, 'Entfernen'));
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
let currentLang = localStorage.getItem('app_lang') || 'system';
localStorage.setItem('app_lang', currentLang);
let translations = {};

async function loadLanguage(lang) {
    try {
        const browserLang = (navigator.language || navigator.userLanguage || 'de').toLowerCase();
        const fetchLang = lang === 'system' ? (browserLang.startsWith('de') ? 'de' : 'en') : lang;
        translations = await (await fetch(`./assets/locales/${fetchLang}.json`)).json();
        currentLang = lang;
        localStorage.setItem('app_lang', lang);
        applyTranslations();
    } catch (e) {
        console.error('Failed to load translation:', e);
    }
}

function t(key, fallback = '', params = null) {
    let str = translations[key] !== undefined ? translations[key] : fallback;
    for (const [k, v] of Object.entries(params || {})) str = str.replaceAll(`{${k}}`, v);
    return str;
}

const STATUS_TEXT_KEYS = {
    'Dauerauftrag läuft': ['status_standing_order_active', 'Dauerauftrag läuft'],
    'Dauerauftrag läuft für den Beitrag': ['status_standing_order_active', 'Dauerauftrag läuft'],
    'Dauerauftrag aktiv': ['status_standing_order_active', 'Dauerauftrag läuft'],
    'Alles in Ordnung': ['status_all_ok', 'Alles in Ordnung'],
    'Zahlung überfällig': ['status_payment_overdue', 'Zahlung überfällig'],
    'Keine Zahlungen': ['status_no_payments', 'Keine Zahlungen'],
    'läuft diesen Monat ab': ['status_expires_this_month', 'läuft diesen Monat ab'],
    'läuft nächsten Monat ab': ['status_expires_next_month', 'läuft nächsten Monat ab']
};
function translateStatusText(text) {
    if (!text) return '';
    const clean = text.trim();
    if (STATUS_TEXT_KEYS[clean]) return t(...STATUS_TEXT_KEYS[clean]);
    const overdue = clean.match(/(\d+)\s+Monat[e]?\s+überfällig/);
    if (overdue) return overdue[1] === '1' ? t('status_one_month_overdue', '1 Monat überfällig') : t('status_months_overdue', '{months} Monate überfällig', { months: overdue[1] });
    const left = clean.match(/noch\s+(\d+)\s+Monat[e]?/);
    if (left) return left[1] === '1' ? t('status_one_month_left', 'noch 1 Monat') : t('status_months_left', 'noch {months} Monate', { months: left[1] });
    return text;
}

function getStatusLabels(withEmoji = false) {
    const labels = {
        vollverdiener: t('member_status_full', '💼 Vollverdiener'),
        geringverdiener: t('member_status_low', '📉 Geringverdiener'),
        keinverdiener: t('member_status_none', '🎓 Keinverdiener'),
        pausiert: t('member_status_paused', '⏸️ Pausiert')
    };
    if (!withEmoji) for (const k in labels) labels[k] = labels[k].replace(/^[💼📉🎓⏸️\s]+/u, '').trim();
    return labels;
}

function applyTranslations() {
    const setters = {
        'data-i18n': (el, text) => { if (text.includes('<')) el.innerHTML = text; else el.textContent = text; },
        'data-i18n-placeholder': (el, text) => el.setAttribute('placeholder', text),
        'data-i18n-aria-label': (el, text) => el.setAttribute('aria-label', text),
        'data-i18n-title': (el, text) => el.setAttribute('title', text)
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

loadLanguage(currentLang);

// --- Toasts & dialogs (with automatic translation of legacy German messages) ---
const TOAST_KEYS = {
    'Zahlung aktualisiert': 'toast_updated', 'Spende aktualisiert': 'toast_updated', 'Ausgabe aktualisiert': 'toast_updated', 'Status geändert': 'toast_updated',
    'Zahlung erfolgreich gesendet': 'toast_saved', 'Anfrage erfolgreich gesendet': 'toast_saved', 'Code kopiert': 'toast_saved', 'Profilbild gespeichert': 'toast_saved',
    'Toast erfolgreich': 'toast_saved', 'Zahlung gebucht': 'toast_saved', 'Spende gebucht': 'toast_saved', 'Ausgabe gebucht': 'toast_saved', 'Person hinzugefügt': 'toast_saved'
};
let toastTimeout;
function showToast(msg, type = 'success') {
    const key = TOAST_KEYS[String(msg).trim().replace(/[!.]/g, '')] || msg;
    let toast = $('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} show`;
    toast.innerHTML = `${type === 'success' ? '✅' : '⚠️'} ${translations[key] || msg}`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

const ALERT_KEYS = {
    'Bitte alle Felder ausfüllen': 'alert_fill_fields', 'Ungültiger Betrag': 'alert_invalid_amount', 'Ungültiges Datum': 'alert_invalid_date',
    'Bitte ein Datum angeben': 'alert_invalid_date', 'Bitte Datum wählen': 'alert_invalid_date', 'Bitte eine Person auswählen': 'modal_person_name',
    'Bitte geben Sie Ihr altes Passwort ein': 'old_password',
    ...Object.fromEntries(['Fehler beim Laden der Daten. Bitte Seite neu laden', 'Person nicht gefunden', 'Zuordnung fehlgeschlagen. Bitte erneut versuchen',
        'Kein Personenprofil gefunden', 'Anfrage konnte nicht gesendet werden. Bitte erneut versuchen', 'Neuer Code konnte nicht gespeichert werden',
        'Fehler beim Speichern', 'Fehler beim Löschen', 'Fehler beim Löschen des Eintrags', 'Neues Passwort muss mindestens 6 Zeichen lang sein',
        'Kein Benutzer angemeldet'].map(msg => [msg, 'toast_error']))
};
const nativeAlert = window.alert.bind(window);
window.alert = msg => {
    if (!msg) return;
    const key = ALERT_KEYS[String(msg).trim().replace(/\.$/, '')] || String(msg).trim().replace(/\.$/, '');
    nativeAlert(translations[key] || msg);
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
const canManageEvents = () => isSuperAdminUser() || hasPermission('canManageEvents', 'manage_events');
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
        throw new Error('Authentifizierung fehlgeschlagen. Bitte erneut anmelden. (' + (tokenError?.code || tokenError?.message || 'Unbekannter Fehler') + ')');
    }
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
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
    const res = await api(path, method, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || fallbackError || `HTTP ${res.status}`), { data });
    return data;
}

const getToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : (localStorage.getItem('token') || ''));

// --- Modal stack with browser-history integration ---
const modalStack = [];
let programmaticBacks = 0;

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
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal._escHandler = e => { if (e.key === 'Escape') closeModal(id); };
    document.addEventListener('keydown', modal._escHandler);
}

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

function closeModal(id, fromPopstate = false) {
    const modal = $(id);
    if (!modal) return;
    const stackIndex = modalStack.indexOf(id);
    if (stackIndex > -1) {
        modalStack.splice(stackIndex, 1);
        if (!fromPopstate && history.state?.isModal) {
            programmaticBacks++;
            history.back();
        }
    }
    hideModal(modal);
    restoreFocus(modal._returnFocusTo);
    delete modal._returnFocusTo;
    reshowTopModal();
    if (typeof modal._customOnClose === 'function') {
        try { modal._customOnClose(); } catch { /* ignore */ }
        delete modal._customOnClose;
    }
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
    if (backs > 0 && history.state?.isModal) {
        programmaticBacks++;
        history.back();
    }
    reshowTopModal();
}

window.addEventListener('popstate', () => {
    if (programmaticBacks > 0) {
        programmaticBacks--;
        return;
    }
    if ($('mentoring-threads-layout')?.classList.contains('in-chat') && window.matchMedia('(max-width: 768px)').matches) {
        mentoringChatHistoryPushed = false;
        closeMentoringChatMobile(true, true);
        return;
    }
    if (modalStack.length > 0) {
        closeModal(modalStack[modalStack.length - 1], true);
        return;
    }
    // Back from a tab entry: return to the start page
    if (tabHistoryPushed && !history.state?.tab) {
        tabHistoryPushed = false;
        if (currentActiveTab !== HOME_TAB) switchTab(HOME_TAB, 'history');
    }
});

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
                <button type="button" class="btn-close-enhanced" onclick="closeModal('${id}')" aria-label="Schließen">✕</button>
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
        title: title || t('receipt', 'Beleg'),
        subtitle: filename || '',
        icon: '📎',
        maxWidth: '520px',
        contentHtml: `<div style="text-align: center;"><img src="${imageUrl}" style="max-width: 100%; border-radius: 8px; border: 1px solid var(--border);" alt="Beleg"></div>`,
        footerHtml: `
            <a href="${imageUrl}" download="${filename || 'beleg'}" class="btn btn-primary" style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">📥 ${t('download_btn', 'Herunterladen')}</a>
            <button type="button" class="btn btn-secondary" onclick="closeModal('receipt-preview-modal')">${t('btn_cancel', 'Schließen')}</button>`
    });
}

function renderReceiptPreviewCard(imgUrl, filename, label) {
    const title = label || t('receipt', 'Beleg');
    return `
        <div style="position:relative; border:1px solid var(--border); border-radius:12px; padding:10px; background:var(--surface-alt);">
            <img src="${imgUrl}" style="width:100%; border-radius:8px; opacity:0; transition:opacity 0.3s ease-in; cursor:pointer;" onload="this.style.opacity=1" onclick="window.showReceiptImageModal('${escapeHtml(title)}', '${imgUrl}', '${escapeHtml(filename)}')" alt="${escapeHtml(title)}">
            <div style="margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
                <a href="${imgUrl}" download="${filename}" class="btn btn-secondary btn-small" style="${STYLE.outlineBtn} display:inline-flex; align-items:center; gap:6px; padding:6px 12px; font-size:0.85rem; border-radius:8px;">
                    ${svgIcon('download')} ${t('download_btn', 'Herunterladen')}
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
        container.innerHTML = `${header}<div style="${listStyle}">${urls.map((url, i) => renderReceiptPreviewCard(url, filenames[i], t('receipt', 'Beleg'))).join('')}</div>`;
    } catch (err) {
        console.error(err);
        container.innerHTML = error;
    }
}

function renderAvatarWrap(userId, userName, { wrapClass = 'duty-assignee-avatar-wrap', imgClass = 'duty-assignee-avatar-img', initialsClass = 'duty-assignee-initials', style } = {}) {
    const name = userName || 'P';
    return `
        <div class="${wrapClass}" ${style ? `style="${style}"` : ''}>
            <span class="${initialsClass}">${escapeHtml(getInitials(name))}</span>
            ${userId ? `<img src="${API}/profile/picture/${encodeURIComponent(userId)}" alt="${escapeHtml(name)}" class="${imgClass}" onerror="this.style.display='none'">` : ''}
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
    btn.setAttribute('aria-label', reveal ? 'Passwort verbergen' : 'Passwort anzeigen');
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

function connectSSE() {
    if (sseConnection) return;
    sseConnection = new EventSource(API + '/stream', { withCredentials: true });
    sseConnection.addEventListener('data_update', () => {
        console.log('SSE: Data updated remotely, refreshing...');
        if (isAuthenticated) loadData(true);
    });
    sseConnection.onerror = () => {
        console.log('SSE error, reconnecting...');
        sseConnection.close();
        sseConnection = null;
        setTimeout(connectSSE, 5000);
    };
}

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
    const visible = aiEnabled && canAccessAi();
    show('admin-ai-nav-btn-bottom', visible);
    show('admin-ai-nav-btn-desktop', visible);
}

function updateFabVisibility() {
    const financesFab = currentActiveTab === 'finances' && canManageFinances();
    const eventsFab = currentActiveTab === 'events' && !!currentUser;
    const visible = financesFab || eventsFab;
    show('fab-finances-items', financesFab, 'block');
    show('fab-events-items', eventsFab, 'block');
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
}

const TAB_ALIASES = { overview: 'finances', 'payment-history': 'finances', 'people-view': 'finances', 'user-history': 'user-finances', 'user-requests': 'user-finances', calendar: 'events' };
const TAB_GUARDS = {
    finances: () => canViewFinances(),
    'super-admin-settings': () => isSuperAdminUser(),
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

function syncTabHistory(tabName) {
    if (tabName === HOME_TAB) {
        if (tabHistoryPushed && history.state?.tab) {
            tabHistoryPushed = false;
            programmaticBacks++;
            history.back();
        }
        return;
    }
    // One history entry for "somewhere other than home"; moving between tabs only replaces it
    if (tabHistoryPushed && history.state?.tab) history.replaceState({ tab: tabName }, '');
    else {
        history.pushState({ tab: tabName }, '');
        tabHistoryPushed = true;
    }
}

// source: the clicked nav element (ignored) or 'history' when called from a back navigation
function switchTab(tabName, source) {
    if (tabName !== 'mentoring') {
        mentoringChatReturnHome = false;
        closeMentoringChatMobile(true);
    }
    if (tabName === 'overview' || tabName === 'payment-history') switchFinanceSubpage('history');
    else if (tabName === 'people-view') switchFinanceSubpage('members');
    tabName = TAB_ALIASES[tabName] || tabName;
    if (TAB_GUARDS[tabName] && !TAB_GUARDS[tabName]()) tabName = 'user-overview';

    currentActiveTab = tabName;
    updateNavVisibility();

    const desktopNav = [...document.querySelectorAll('#desktop-nav [data-tab], .desktop-nav [data-tab]')];
    const currentIndex = desktopNav.findLastIndex(el => el.classList.contains('active'));
    const targetIndex = desktopNav.findLastIndex(el => el.dataset.tab === tabName);
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active', 'slide-in-right', 'slide-in-left'));
    $(tabName)?.classList.add('active', currentIndex > -1 && targetIndex > -1 && targetIndex < currentIndex ? 'slide-in-left' : 'slide-in-right');

    const container = document.querySelector('.container');
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
        const active = el.dataset.tab === tabName;
        el.classList.toggle('active', active);
        el.setAttribute('aria-selected', String(active));
    });
    if (source !== 'history' && isAuthenticated) syncTabHistory(tabName);
    TAB_LOADERS[tabName]?.();
}

function resolveHashTab() {
    let tab = (window.location.hash || '').replace(/^#\/?/, '').trim().split('?')[0].split('/')[0];
    if (tab === 'calendar') tab = 'events';
    if (tab === 'requests') tab = canViewFinances() ? 'finances' : 'user-finances';
    return tab && $(tab)?.classList.contains('tab-content') ? tab : null;
}

window.addEventListener('hashchange', () => {
    const tab = isAuthenticated && resolveHashTab();
    if (tab) switchTab(tab);
});

function closeProfileMenu() {
    $('profileDropdown')?.classList.remove('show');
    document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
}

function toggleProfileMenu() {
    const menu = $('profileDropdown');
    const btn = document.querySelector('.profile-btn');
    if (!menu || !btn) return;
    menu.classList.toggle('show');
    btn.setAttribute('aria-expanded', menu.classList.contains('show'));
}

document.addEventListener('click', e => {
    const container = document.querySelector('.profile-menu-container');
    if (container && !container.contains(e.target) && $('profileDropdown')?.classList.contains('show')) closeProfileMenu();
    const dropdown = $('mentoring-chat-menu-dropdown');
    if (dropdown?.style.display === 'block' && !$('mentoring-chat-menu-btn')?.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
});

function toggleFab() {
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
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = actual === 'dark' ? '#0f172a' : '#e6f2fa'; });
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
    try {
        const snap = await get(ref(db, 'settings'));
        if (snap.exists()) {
            settings = snap.val();
        }
    } catch (err) {
        console.warn('Could not fetch settings:', err);
    }

    const uid = currentUser.uid;
    const peopleRef = ref(db, 'people');
    const linkPerson = key => update(child(peopleRef, key), { uid }).catch(err => console.warn('Auto-link update failed:', err));
    let peopleList = [];
    try {
        let snap = await get(query(peopleRef, orderByChild('uid'), equalTo(uid)));
        if (snap.exists()) peopleList = safeList(snap.val());
        const name = fullName(currentUser) || currentUser.name || '';
        if (peopleList.length === 0 && name) {
            snap = await get(query(peopleRef, orderByChild('name'), equalTo(name)));
            const val = snap.exists() ? snap.val() : {};
            const key = Object.keys(val)[0];
            if (key) {
                await linkPerson(key);
                peopleList = [{ ...val[key], uid }];
            }
        }
    } catch (queryErr) {
        console.warn('Index missing, falling back to client-side filtering:', queryErr);
        try {
            const snap = await get(peopleRef);
            const all = snap.val();
            const name = (fullName(currentUser) || currentUser.name || '').toLowerCase();
            const nameMatches = p => p.name && p.name.toLowerCase() === name;
            peopleList = safeList(all).filter(p => p.uid === uid || nameMatches(p));
            const first = peopleList[0];
            if (first && !first.uid && nameMatches(first)) {
                first.uid = uid;
                const key = snap.exists() && Object.keys(all).find(k => all[k].id === first.id || all[k].personKey === first.id);
                if (key) await linkPerson(key);
            }
        } catch (err) {
            console.warn('Could not load people:', err);
        }
    }
    people = peopleList.filter(p => !p.isDeleted);

    let rSnap = null;
    try {
        rSnap = await get(query(ref(db, 'requests'), orderByChild('userId'), equalTo(uid)));
    } catch (reqErr) {
        console.warn('Request index missing, fetching all requests:', reqErr);
        rSnap = await get(ref(db, 'requests')).catch(err => {
            console.warn('Could not get requests:', err);
            return null;
        });
    }
    requests = (rSnap?.exists() ? safeList(rSnap.val()) : []).filter(r => r.userId === uid);
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

async function loadData(silent = false) {
    const loader = $('loading-overlay');
    if (loader && !silent) loader.style.display = 'flex';
    try {
        if (isAuthenticated) await refreshCurrentUser();
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        if (canViewFinances() || isSuperAdminUser()) await loadAdminData();
        else await loadMemberData();

        if (canManageRegistrationCode()) {
            const code = await apiGet('system/inviteCode').catch(() => null);
            if (code) updateInviteCodeDisplay(code);
        } else {
            updateInviteCodeDisplay('');
        }

        setText('user-name-display', fullName(currentUser) || currentUser.name || '');
        setText('user-email-display', currentUser.email || '');
        setText('profile-menu-name', fullName(currentUser) || currentUser.name || '');
        setText('profile-menu-email', currentUser.email || '');
        if (canAccessAi()) {
            apiJson('/admin/ai-status').then(data => {
                aiEnabled = !!data.enabled;
                updateAiNavVisibility();
            }).catch(() => {});
        }
        updateNavVisibility();
        if (isAuthenticated) {
            loadMentoringThreads(false);
            loadEventsData();
        }

        if (window.location.hash) {
            const tab = resolveHashTab();
            if (tab) switchTab(tab);
        } else if (!document.querySelector('.tab-content.active')) {
            switchTab('user-overview');
        }

        people.forEach(preprocessPerson);
        if (canManageFinances()) {
            const updates = [];
            for (const person of people) {
                const result = checkAndExecuteStandingOrders(person);
                if (!result) continue;
                const totalPaid = sumAmounts(result.payments);
                updates.push(update(ref(db, 'people/' + person.id), { payments: result.payments, standingOrders: result.standingOrders, totalPaid }));
                Object.assign(person, result, { totalPaid });
            }
            await Promise.all(updates);
        }
        await renderViews(!silent);
    } catch (err) {
        console.error('Ladefehler:', err);
        alert(t('alert_error_loading_data', 'Fehler beim Laden der Daten. Bitte Seite neu laden.'));
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
        await loadSystemGroups();
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

async function bootstrapSuperAdmin(user) {
    try {
        const res = await api('/admin/bootstrap-super-admin', 'POST');
        if (!res.ok) return;
        const result = await res.json();
        if (result.isSuperAdmin || result.isOwner) {
            currentUser = { ...(currentUser || {}), admin: true, owner: true, superAdmin: true };
            currentUser = (await fetchUserProfile(user.uid, 2)) || currentUser;
        }
    } catch (error) {
        console.warn('Super admin bootstrap skipped:', error);
    }
}

onAuthStateChanged(auth, async user => {
    if (user) {
        showAuthLoader('Profil wird geladen...');
        localStorage.setItem('agora-is-logged-in', 'true');
        currentUser = await fetchUserProfile(user.uid, 2);
        if (!currentUser) {
            setLoadingMessage('Profil nicht gefunden, bitte Admin kontaktieren.');
            currentUser = { role: 'user', email: user.email, uid: user.uid };
        }
        await bootstrapSuperAdmin(user);
        $('login-modal').classList.remove('show');
        isAuthenticated = true;
        connectSSE();
        loadData();
        loadCurrentProfilePicture();
        ensurePushNotificationSubscription();
    } else {
        localStorage.removeItem('agora-is-logged-in');
        localStorage.removeItem('nova-is-logged-in');
        isAuthenticated = false;
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        currentUser = null;
        $('login-modal')?.classList.add('show');
        show('loading-overlay', false);
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
    setButtonLoading('btn-login', true, 'Anmelden...');
    if (!email || !pass) {
        showAuthError('Bitte E-Mail und Passwort eingeben.');
    } else {
        try {
            show('auth-error', false);
            await signInWithEmailAndPassword(auth, email, pass);
            showAuthLoader('Profil wird geladen...');
        } catch (error) {
            console.error(error);
            showAuthError('Login fehlgeschlagen: ' + error.message);
        }
    }
    setButtonLoading('btn-login', false);
}

async function attemptRegister() {
    const [code, email, first, last, p1, p2] = ['reg-code', 'reg-email', 'reg-firstname', 'reg-lastname', 'reg-pass1', 'reg-pass2'].map(inputValue);
    const validationError = (!code || !email || !first || !last || !p1 || !p2) ? 'Bitte alle Felder ausfüllen.'
        : p1.length < 6 ? 'Passwort muss mindestens 6 Zeichen lang sein.'
        : p1 !== p2 ? 'Passwörter stimmen nicht überein.' : null;
    if (validationError) return showAuthError(validationError);
    try {
        show('auth-error', false);
        showAuthLoader('Profil wird initialisiert...');
        await createUserWithEmailAndPassword(auth, email, p1, { inviteCode: code, firstName: first, lastName: last, name: `${first} ${last}`.trim() });
    } catch (error) {
        console.error(error);
        showAuthError(error.message?.includes('Ungültiger Registrierungscode') ? 'Ungültiger Registrierungscode.' : 'Registrierung fehlgeschlagen: ' + error.message);
        show('loading-overlay', false);
        $('login-modal').classList.add('show');
    }
}

async function logout() {
    try {
        sseConnection?.close();
        sseConnection = null;
        applyProfilePicture(null);
        await signOut(auth);
    } catch (error) {
        console.error('Logout Error:', error);
    }
}

async function changePassword(isUser = false) {
    const [newId, oldId] = isUser ? ['user-new-password', 'user-old-password'] : ['new-password', 'old-password'];
    const pw = $(newId).value;
    const oldPw = $(oldId).value;
    if (!oldPw) return alert(t('alert_enter_old_password', 'Bitte geben Sie Ihr altes Passwort ein.'));
    if (!pw || pw.length < 6) return alert(t('alert_new_password_length', 'Neues Passwort muss mindestens 6 Zeichen lang sein.'));
    try {
        if (!auth.currentUser) return alert(t('alert_no_user_logged_in', 'Kein Benutzer angemeldet.'));
        await updatePassword(auth.currentUser, oldPw, pw);
        showToast(t('toast_password_changed', 'Passwort erfolgreich geändert'));
        setValue(newId, '');
        setValue(oldId, '');
    } catch (error) {
        console.error(error);
        alert(t('alert_password_change_failed', 'Fehler beim Ändern des Passworts: ') + error.message);
    }
}

// --- Registration code ---
async function generateNewCode() {
    if (!canManageRegistrationCode()) return alert(t('alert_no_permission', 'Keine Berechtigung zum Verwalten des Registrierungscodes.'));
    const newCode = String(100000 + (window.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    try {
        await set(ref(db, 'system/inviteCode'), newCode);
        updateInviteCodeDisplay(newCode);
    } catch (err) {
        console.error('Fehler beim Generieren des Codes:', err);
        alert(t('alert_save_code_failed', 'Neuer Code konnte nicht gespeichert werden.'));
    }
}

async function copyInviteCode() {
    if (!canManageRegistrationCode()) return alert(t('alert_no_permission', 'Keine Berechtigung zum Verwalten des Registrierungscodes.'));
    const code = inputValue('admin-invite-code') || inputValue('user-invite-code');
    if (!code || code === '------') return;
    try {
        await navigator.clipboard.writeText(code);
        showToast(t('toast_code_copied', 'Code kopiert!'));
    } catch (err) {
        console.error('Kopieren fehlgeschlagen:', err);
        alert(t('toast_copy_failed', 'Kopieren fehlgeschlagen'));
    }
}

// --- Notification preferences & web push ---
const NOTIFICATION_KEYS = ['duties', 'events', 'messages', 'finances'];
function setNotificationCheckboxes(values) {
    NOTIFICATION_KEYS.forEach(key => ['notif-pref-', 'user-notif-pref-'].forEach(prefix => {
        const el = $(prefix + key);
        if (el) el.checked = values[key];
    }));
}

async function autoSaveNotificationPreferences() {
    if (!currentUser?.uid) return;
    const [own, other] = currentActiveTab === 'user-settings' ? ['user-notif-pref-', 'notif-pref-'] : ['notif-pref-', 'user-notif-pref-'];
    const notificationSettings = Object.fromEntries(NOTIFICATION_KEYS.map(key => [key, ($(own + key) || $(other + key))?.checked ?? true]));
    // Keep emailNotifications in sync for backwards compatibility
    const emailNotifications = Object.values(notificationSettings).some(Boolean);
    try {
        await update(ref(db, 'users/' + currentUser.uid), { notificationSettings, emailNotifications });
        Object.assign(currentUser, { notificationSettings, emailNotifications });
        setNotificationCheckboxes(notificationSettings);
        showToast(t('notification_settings_saved', 'Benachrichtigungseinstellungen gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der Benachrichtigungseinstellungen:', err);
        showToast(t('alert_settings_save_failed', 'Einstellungen konnten nicht gespeichert werden.'), 'error');
    }
}

function updateNotificationPreferencesUI() {
    if (!currentUser) return;
    const financesAllowed = canViewFinances() || currentUser.admin === true || currentUser.owner === true || currentUser.superAdmin === true;
    show('notif-pref-finances-wrap', financesAllowed, 'flex');
    show('user-notif-pref-finances-wrap', financesAllowed, 'flex');
    const allDisabled = currentUser.emailNotifications === false && !currentUser.notificationSettings;
    const prefs = { duties: true, events: true, messages: true, finances: true, ...currentUser.notificationSettings };
    setNotificationCheckboxes(Object.fromEntries(NOTIFICATION_KEYS.map(key => [key, !allDisabled && prefs[key] !== false])));
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

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
                body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: navigator.userAgent })
            }).catch(e => console.warn('Push sync error:', e));
        }
    } catch (err) {
        console.warn('Auto-subscribe push notification error:', err);
    }
}

// --- PWA install ---
let deferredInstallPrompt = null;
const installBtn = $('install-pwa-btn');
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    show(installBtn, true, 'inline-flex');
});
installBtn?.addEventListener('click', async () => {
    show(installBtn, false);
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    deferredInstallPrompt = null;
});
window.addEventListener('appinstalled', () => {
    show(installBtn, false);
    deferredInstallPrompt = null;
    console.log('PWA was installed');
    setupPwaPushAutoPrompt();
});

// --- Profile pictures ---
async function fetchProfilePicUrl(uid) {
    const res = await api(`/profile/picture/${encodeURIComponent(uid)}`);
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
    if (!blob) return showToast('Fehler beim Verarbeiten des Bildes.', 'error');
    setButtonLoading('btn-confirm-crop', true, 'Speichern...');
    try {
        await apiJson('/profile/picture', 'POST', toFormData({ picture: new File([blob], 'profile.jpg', { type: 'image/jpeg' }) }), 'Upload fehlgeschlagen');
        closeModal('profile-crop-modal');
        showToast('Profilbild gespeichert!', 'success');
        await loadCurrentProfilePicture();
    } catch (e) {
        console.error('Profile upload error:', e);
        showToast('Fehler beim Hochladen: ' + e.message, 'error');
    } finally {
        setButtonLoading('btn-confirm-crop', false, null);
    }
}

Object.assign(window, {
    switchTab, switchFinanceSubpage, toggleProfileMenu, toggleFab, setTheme, attemptLogin, attemptRegister, logout, changePassword,
    generateNewCode, copyInviteCode, autoSaveNotificationPreferences, openProfileCrop, cancelProfileCrop, confirmProfileCrop,
    showLogin: () => showAuthForm(true),
    showRegister: () => showAuthForm(false),
    openHomeTab: () => {
        closeProfileMenu();
        switchTab('user-overview');
    },
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
    { id: 'view_finances', name: 'Finanzverwaltung (Nur Lesen)', description: 'Erlaubt die Einsicht in Kassenstände, Historie, Transaktionen und Berichte ohne Bearbeitungsrechte' },
    { id: 'manage_finances', name: 'Finanzverwaltung (Vollzugriff)', description: 'Erlaubt das Erfassen, Bearbeiten, Buchen und Löschen von Zahlungen, Spenden, Ausgaben und Daueraufträgen' },
    { id: 'manage_registration_code', name: 'Registrierungscode verwalten', description: 'Erlaubt das Einsehen, Kopieren und Neugenerieren des Registrierungscodes für neue Mitglieder' },
    { id: 'access_ai', name: 'KI-Support nutzen', description: 'Erlaubt den Zugriff und die Nutzung des integrierten KI-Assistenten' },
    { id: 'manage_mentoring', name: 'Mentoring-Verwaltung', description: 'Berechtigt Leiter dazu, Mentorenbewerbungen zu prüfen, genehmigen oder abzulehnen (kein Zugriff auf private Chats)' },
    { id: 'manage_events', name: 'Event- & Dienstplanverwaltung', description: 'Erlaubt das Anlegen von Serienterminen und die vollständige Verwaltung aller Events und Dienste' }
];

async function loadSystemGroups() {
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
    listEl.innerHTML = item(activeGroupFilter === null, 'window.filterByGroup(null)', '👥', `<span data-i18n="group_all_users">${t('group_all_users', 'Alle Benutzer')}</span>`, Array.isArray(users) ? users.length : 0)
        + groupList().map(g => item(
            activeGroupFilter === g.id || activeGroupFilter === g.name,
            `window.filterByGroup('${escapeHtml(g.id)}')`, '🏷️', `<span>${escapeHtml(g.name)}</span>`, g.memberCount !== undefined ? g.memberCount : 0,
            `<button type="button" class="nc-group-action-btn" title="${t('modal_manage_group_title', 'Gruppe verwalten')}" onclick="event.stopPropagation(); window.openManageGroupModal('${escapeHtml(g.id)}');">${svgIcon('gear')}</button>`
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
        await apiJson('/admin/groups', 'POST', { name, permissions: [] }, 'Fehler beim Erstellen der Gruppe');
        input.value = '';
        showToast(t('toast_group_created', 'Gruppe erfolgreich erstellt'), 'success');
        await refreshGroupsAndUsers(false);
    } catch (err) {
        alert(err.message || 'Fehler beim Erstellen der Gruppe');
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
    setText('manage-group-modal-title', group ? t('modal_manage_group_title', 'Gruppe verwalten') : t('modal_create_group_title', 'Neue Gruppe erstellen'));
    show('btn-delete-group', !!group, 'inline-block');
    const list = $('manage-group-permissions-list');
    if (list) {
        const active = group?.permissions || [];
        list.innerHTML = systemPermissions.length
            ? systemPermissions.map(p => checkItem('nc-permission', 'group-permission-cb', p.id, active.includes(p.id), p.name, escapeHtml(p.description || ''))).join('')
            : '<div style="color: var(--text-secondary); font-size: 0.85rem;">Keine Berechtigungs-Definitionen gefunden.</div>';
    }
    openModal('manage-group-modal');
}

async function submitSaveGroup() {
    const id = inputValue('manage-group-id');
    const name = inputValue('manage-group-name').trim();
    if (!name) return alert(t('alert_fill_fields', 'Bitte Gruppennamen eingeben.'));
    try {
        const permissions = checkedValues('#manage-group-permissions-list .group-permission-cb');
        await apiJson(id ? `/admin/groups/${id}` : '/admin/groups', id ? 'PUT' : 'POST', { name, permissions }, 'Fehler beim Speichern der Gruppe');
        closeModal('manage-group-modal');
        showToast(id ? t('toast_group_updated', 'Gruppe erfolgreich aktualisiert') : t('toast_group_created', 'Gruppe erfolgreich erstellt'), 'success');
        await refreshGroupsAndUsers();
    } catch (err) {
        console.error('Fehler beim Speichern der Gruppe:', err);
        alert(err.message || 'Fehler beim Speichern der Gruppe');
    }
}

async function deleteCurrentGroup() {
    const id = inputValue('manage-group-id');
    if (!id || !confirmAction(t('confirm_delete_group', 'Möchten Sie die Gruppe wirklich löschen? Die Gruppe wird von allen Benutzern entfernt.'))) return;
    try {
        await apiJson(`/admin/groups/${id}`, 'DELETE', undefined, 'Fehler beim Löschen der Gruppe');
        if (activeGroupFilter === id) activeGroupFilter = null;
        closeModal('manage-group-modal');
        showToast(t('toast_group_deleted', 'Gruppe erfolgreich gelöscht'), 'success');
        await refreshGroupsAndUsers();
    } catch (err) {
        console.error('Fehler beim Löschen der Gruppe:', err);
        alert(err.message || 'Fehler beim Löschen der Gruppe');
    }
}

function openAssignGroupModal(uid) {
    const user = users.find(u => u.uid === uid);
    if (!user) return;
    setValue('assign-group-uid', uid);
    setText('assign-group-user-display', `${fullName(user) || user.email || 'Benutzer'} (${user.email || 'Kein Login'})`);
    const list = $('assign-group-checklist');
    if (!list) return;
    const userGroups = Array.isArray(user.groups) ? user.groups : [];
    list.innerHTML = groupList().length
        ? systemGroups.map(g => {
            const perms = Array.isArray(g.permissions) ? g.permissions : [];
            return checkItem('nc-group-check', 'user-group-assign-cb', g.id, userGroups.includes(g.id) || userGroups.includes(g.name), g.name, perms.length > 0 ? `${perms.length} Berechtigungen` : 'Standard-Zugriff');
        }).join('')
        : '<div style="color: var(--text-secondary); font-size: 0.85rem; padding: 10px 0;">Keine Gruppen vorhanden. Erstellen Sie zuerst eine Gruppe.</div>';
    openModal('assign-group-modal');
}

async function submitAssignGroups() {
    const uid = inputValue('assign-group-uid');
    if (!uid) return;
    const groups = checkedValues('#assign-group-checklist .user-group-assign-cb');
    try {
        await apiJson(`/admin/users/${uid}/groups`, 'PUT', { groups }, 'Fehler beim Zuweisen der Gruppen');
        const localUser = users.find(u => u.uid === uid);
        if (localUser) {
            localUser.groups = groups;
            localUser.groupObjects = groups.map(gid => findGroup(gid) || { id: gid, name: gid });
        }
        closeModal('assign-group-modal');
        showToast(t('toast_user_groups_updated', 'Benutzergruppen erfolgreich aktualisiert'), 'success');
        await refreshGroupsAndUsers(currentUser?.uid === uid);
    } catch (err) {
        console.error('Fehler beim Zuweisen der Gruppen:', err);
        alert(err.message || 'Fehler beim Zuweisen der Gruppen');
    }
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
    events: () => loadEventSystemSettings()
};

function switchSysSettingsTab(tabName) {
    currentSysSettingsTab = tabName;
    Object.keys(SYS_TAB_LOADERS).forEach(key => {
        $(`sys-subtab-btn-${key}`)?.classList.toggle('active', key === tabName);
        show(`sys-panel-${key}`, key === tabName);
    });
    SYS_TAB_LOADERS[tabName]?.();
}

function renderAccountRow(u) {
    const name = fullName(u) || 'Unbekannt';
    const uid = escapeHtml(u.uid);
    const isOwner = u.owner === true || u.superAdmin === true;
    const initials = ((u.firstName?.[0] || '') + (u.lastName?.[0] || (u.firstName ? '' : '?'))).toUpperCase() || '?';
    const linked = findLinkedPerson(u.uid);
    const memberSince = u.memberSince || linked?.memberSince || linked?.data?.memberSince || '';
    const groups = Array.isArray(u.groupObjects) && u.groupObjects.length > 0
        ? u.groupObjects
        : (Array.isArray(u.groups) ? u.groups.map(gid => findGroup(gid) || { id: gid, name: gid, permissions: [] }) : []);
    const groupBadges = groups.length > 0
        ? groups.map(g => `<span class="nc-badge-group" style="margin: 2px;">${escapeHtml(g.name)}</span>`).join(' ')
        : `<span class="nc-badge-group" style="opacity:0.6; border-style:dashed; margin: 2px;">+ ${t('modal_assign_group_title', 'Zuweisen')}</span>`;
    const pays = u.pays !== false;
    return `
        <tr data-uid="${uid}">
            <td>
                <div class="nc-user-cell">
                    <div class="nc-avatar ${getAvatarRingClass(u)}" style="position: relative; overflow: hidden;">
                        <span style="user-select: none;">${escapeHtml(initials)}</span>
                        <img src="${API}/profile/picture/${u.uid}" alt="${escapeHtml(name)}" style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'">
                    </div>
                    <div class="nc-user-info">
                        <div class="nc-user-name">
                            <span>${escapeHtml(name)}</span>
                            ${isOwner ? `<span class="nc-badge-owner">👑 ${t('badge_owner', 'Eigentümer')}</span>` : ''}
                            ${u.isClaimed === false ? `<span class="nc-badge-group" style="background: rgba(245, 158, 11, 0.12); color: #d97706; border-color: rgba(245, 158, 11, 0.3); font-size: 0.72rem; padding: 2px 6px;">⏳ ${t('badge_unclaimed', 'Nicht registriert')}</span>` : ''}
                        </div>
                    </div>
                </div>
            </td>
            <td style="color: var(--text-secondary); font-size: 0.88rem;">${u.email ? escapeHtml(u.email) : `<span style="opacity: 0.5; font-style: italic;">${t('accounts_no_login', 'Kein Login hinterlegt')}</span>`}</td>
            <td style="cursor: pointer;" onclick="window.openAssignGroupModal('${uid}')" title="${t('modal_assign_group_title', 'Gruppen zuweisen')}">
                ${groupBadges}
            </td>
            <td>
                <input type="date" class="form-input" style="padding: 3px 6px; font-size: 0.82rem; height: 30px; border-radius: 8px; width: 130px; margin: 0;" value="${escapeHtml(memberSince)}" onchange="window.updateUserMemberSince('${uid}', this.value)">
            </td>
            <td>
                <select class="nc-select-pays" onchange="window.toggleUserPays('${uid}', this.value === 'yes')">
                    <option value="yes" ${pays ? 'selected' : ''}>${t('option_yes', 'Ja')}</option>
                    <option value="no" ${!pays ? 'selected' : ''}>${t('option_no', 'Nein')}</option>
                </select>
            </td>
            <td>
                <label class="switch" style="margin: 0;">
                    <input type="checkbox" ${u.admin ? 'checked' : ''} ${isOwner ? 'disabled' : ''} onchange="window.toggleUserSystemAdmin('${uid}', this.checked)">
                    <span class="slider"></span>
                </label>
            </td>
            <td>
                <div class="nc-actions-cell">
                    <button class="nc-icon-btn" title="${t('btn_reset_password', 'Passwort zurücksetzen')}" onclick="window.openResetPasswordModal('${uid}', '${escapeHtml(name)}')">${svgIcon('lock', 15)}</button>
                    ${!isOwner && u.uid !== currentUser?.uid ? `<button class="nc-icon-btn danger" title="${t('btn_delete', 'Löschen')}" onclick="window.deleteUserAccount('${uid}')">${svgIcon('trash', 15)}</button>` : ''}
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
        tbody.innerHTML = emptyRow('Keine Benutzer gefunden.');
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
            setText('nc-active-group-count', `(${filtered.length} Benutzer)`);
        }
    }
    tbody.innerHTML = filtered.length ? filtered.map(renderAccountRow).join('') : emptyRow('Keine passenden Benutzer gefunden.');
}

async function saveUserSetting(uid, field, payload, applyLocal, successMsg, errorMsg, logMsg) {
    if (!isSuperAdminUser()) return;
    try {
        const res = await api(`/admin/users/${uid}/${field}`, 'PUT', payload);
        if (!res.ok) throw new Error((await res.text()) || 'Speichern fehlgeschlagen');
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
}, t('toast_member_since_updated', 'Mitgliedsdatum aktualisiert'), 'Mitgliedsdatum konnte nicht gespeichert werden', 'Fehler beim Speichern des Mitgliedsdatums:');

const toggleUserSystemAdmin = (uid, isAdmin) => saveUserSetting(uid, 'admin', { admin: !!isAdmin }, localUser => {
    if (localUser) localUser.admin = !!isAdmin;
}, t('toast_admin_updated', 'System-Admin Rechte aktualisiert'), 'Benutzerrechte konnten nicht gespeichert werden', 'Fehler beim Speichern der Admin-Rolle:');

const toggleUserPays = (uid, pays) => saveUserSetting(uid, 'pays', { pays: !!pays }, localUser => {
    if (localUser) localUser.pays = !!pays;
    const linked = people.find(p => p.uid === uid);
    if (linked) {
        linked.pays = !!pays;
        if (linked.data) linked.data.pays = !!pays;
    }
}, t('toast_pays_updated', 'Zahlungsstatus aktualisiert'), 'Beitragsstatus konnte nicht gespeichert werden', 'Fehler beim Speichern des Beitragsstatus:');

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
    if (!firstName || !lastName) return alert(t('alert_fill_fields', 'Bitte Vor- und Nachnamen ausfüllen.'));
    if (password && password.length < 6) return alert(t('setup_admin_password_invalid', 'Passwort muss mindestens 6 Zeichen lang sein.'));
    try {
        await apiJson('/admin/users', 'POST', {
            firstName, lastName, email, password,
            pays: isChecked('new-user-pays'),
            admin: isChecked('new-user-admin'),
            status: inputValue('new-user-status') || 'vollverdiener',
            memberSince: inputValue('new-user-start') || getTodayStr(),
            groups: ['Standard']
        }, 'Erstellen fehlgeschlagen');
        await loadData();
        closeModal('create-user-modal');
        showToast(t('toast_user_created', 'Benutzer erfolgreich erstellt'));
    } catch (err) {
        console.error('Fehler beim Erstellen des Benutzers:', err);
        alert(err.message || 'Fehler beim Erstellen des Benutzers');
    }
}

function openResetPasswordModal(uid, name) {
    setValue('reset-password-uid', uid);
    setText('reset-password-user-display', name);
    setValue('reset-password-new', '');
    openModal('reset-password-modal');
}

async function submitResetPassword() {
    const password = inputValue('reset-password-new');
    if (password.length < 6) return alert(t('setup_admin_password_invalid', 'Passwort muss mindestens 6 Zeichen lang sein.'));
    try {
        await apiJson(`/admin/users/${inputValue('reset-password-uid')}/password`, 'PUT', { password }, 'Passwort-Zurücksetzen fehlgeschlagen');
        closeModal('reset-password-modal');
        showToast(t('toast_password_reset', 'Passwort erfolgreich geändert'));
    } catch (err) {
        console.error('Fehler beim Zurücksetzen des Passworts:', err);
        alert(err.message || 'Fehler beim Zurücksetzen des Passworts');
    }
}

async function deleteUserAccount(uid) {
    if (!confirmAction(t('confirm_delete_user', 'Möchten Sie dieses Benutzerkonto wirklich löschen?'))) return;
    try {
        await apiJson(`/admin/users/${uid}`, 'DELETE', undefined, 'Löschen fehlgeschlagen');
        users = users.filter(u => u.uid !== uid);
        renderAccountsTab();
        renderUnlinkedUsers();
        showToast(t('toast_user_deleted', 'Benutzer erfolgreich gelöscht'));
    } catch (err) {
        console.error('Fehler beim Löschen des Benutzers:', err);
        alert(err.message || 'Fehler beim Löschen des Benutzers');
    }
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
    try {
        const res = await api('/admin/system-config');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        advancedConfigAppName = data.appName || null;
        setValue('super-admin-app-name', data.appName || '');
        SMTP_FIELDS.forEach(key => setValue(`super-admin-smtp-${key}`, data.smtp?.[key] || ''));
        $('super-admin-smtp-secure').checked = !!data.smtp?.secure;
        advancedConfigLoaded = true;
        await loadAiConfig();
    } catch (err) {
        console.error('Fehler beim Laden der erweiterten Konfiguration:', err);
        showToast('Erweiterte Konfiguration konnte nicht geladen werden', 'error');
    }
}

async function saveAdvancedSystemConfig() {
    if (!isSuperAdminUser()) return;
    try {
        const appName = inputValue('super-admin-app-name').trim() || advancedConfigAppName || config.appName;
        if (!appName) throw new Error('App-Name konnte nicht ermittelt werden. Dies kann auf fehlende Konfigurationsdaten hinweisen. Bitte Seite neu laden.');
        const payload = { appName, smtp: null };
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
            if (!payload.smtp.port || Number.isNaN(payload.smtp.port)) throw new Error('SMTP Port ist ungültig.');
        }
        const res = await api('/admin/system-config', 'PUT', payload);
        if (!res.ok) throw new Error(await readErrorText(res));
        advancedConfigAppName = appName;
        showToast(t('toast_config_saved', 'System-Konfiguration gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der erweiterten Konfiguration:', err);
        alert(t('alert_config_save_failed', 'Erweiterte Konfiguration konnte nicht gespeichert werden: ') + (err.message || t('setup_err_unknown', 'Unbekannter Fehler')));
    }
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
    try {
        const payload = {
            enabled: $('super-admin-ai-enabled')?.checked ?? false,
            baseUrl: inputValue(AI_FIELDS.baseUrl).trim(),
            apiKey: inputValue(AI_FIELDS.apiKey),
            model: inputValue(AI_FIELDS.model).trim()
        };
        await apiJson('/admin/ai-config', 'PUT', payload);
        aiEnabled = payload.enabled;
        updateAiNavVisibility();
        showToast(t('toast_ai_saved', 'KI-Einstellungen gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der KI-Einstellungen:', err);
        alert(t('alert_ai_save_failed', 'KI-Einstellungen konnten nicht gespeichert werden: ') + (err.message || t('setup_err_unknown', 'Unbekannter Fehler')));
    }
}

async function uploadChurchLogo() {
    if (!isSuperAdminUser()) return;
    const fileInput = $('super-admin-logo-file');
    if (!fileInput?.files?.length) return alert(t('alert_please_select_svg', 'Bitte eine SVG-Datei auswählen.'));
    try {
        const res = await api('/admin/logo', 'POST', toFormData({ logo: fileInput.files[0] }));
        if (!res.ok) throw new Error((await readErrorText(res)) || `HTTP ${res.status}`);
        const cacheBust = `?v=${Date.now()}`;
        document.querySelectorAll("img[src*='church-logo.svg']").forEach(img => { img.src = `assets/church-logo.svg${cacheBust}`; });
        fileInput.value = '';
        showToast(t('toast_logo_updated', 'Logo aktualisiert'));
    } catch (err) {
        const errMsg = err.message || err.code || 'Unbekannter Fehler';
        console.error('Fehler beim Logo-Upload:', errMsg, err);
        alert(t('alert_logo_update_failed', 'Logo konnte nicht aktualisiert werden: ') + errMsg);
        showToast(t('toast_logo_update_failed', 'Logo konnte nicht aktualisiert werden'), 'error');
    }
}

async function autoSaveRate(fieldId) {
    const el = $(fieldId);
    if (!el) return;
    const val = parseAmount(el.value);
    if (isNaN(val) || val < 0) return;
    settings[['vollverdiener', 'geringverdiener'].find(key => fieldId === 'rate-' + key) || 'keinverdiener'] = val;
    try {
        await set(ref(db, 'settings'), settings);
        await renderViews();
        showToast(t('toast_settings_saved', 'Einstellungen gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der Rate:', err);
        showToast(t('alert_settings_save_failed', 'Einstellungen konnten nicht gespeichert werden.'), 'error');
    }
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
    payment: { label: 'Zahlung', icon: 'coin' },
    status: { label: 'Statusänderung', icon: 'history' },
    expense: { label: 'Ausgabe', icon: 'receipt' },
    standing_order: { label: 'Dauerauftrag', icon: 'repeat' }
};
const quotedNote = note => note ? `<br><small style="color: var(--text-secondary);"><span style="opacity: 0.7;">"</span>${escapeHtml(note)}<span style="opacity: 0.7;">"</span></small>` : '';

function renderRequestDetails(req, statusLabels) {
    const data = req.data;
    if (req.type === 'payment') return `${euro(data.amount)} am ${formatDateFast(data.date)}${quotedNote(data.note)}`;
    if (req.type === 'status') return `Neu: <strong>${escapeHtml(statusLabels[data.newStatus] || data.newStatus)}</strong> ab ${formatDateFast(data.date)}`;
    if (req.type === 'standing_order') return `${euro(data.amount)} / Monat<br>Start: ${formatDateFast(data.date)}${quotedNote(data.note)}`;
    if (req.type !== 'expense') return '';
    const id = escapeHtml(req.id);
    return `${euro(data.amount)} für "${escapeHtml(data.description)}" am ${formatDateFast(data.date)}` + (data.receipt ? `<div id="receipt-container-${id}" style="margin-top:10px;">
        <button class="btn btn-small" style="background: transparent; border: 1px solid var(--border); color: var(--text); display: flex; align-items: center; gap: 6px;" data-receipt="${escapeHtml(data.receipt)}" data-id="${id}" onclick="viewRequestReceipt(this.dataset.receipt, 'receipt-container-' + this.dataset.id)">
            ${svgIcon('image')}
            Beleg anzeigen
        </button>
    </div>` : '');
}

function renderAdminRequests() {
    const target = $('admin-requests-inline');
    if (!target) return;
    const pending = requests.filter(r => r.status === 'pending');
    if (pending.length === 0) {
        target.innerHTML = '';
        return;
    }
    const statusLabels = getStatusLabels(false);
    const canApprove = canManageFinances() || isOwnerUser();
    const actionBtn = (cls, style, handler, icon, label, id) => `
        <button class="btn ${cls} btn-small" style="flex: 1; display: flex; justify-content: center; align-items: center; gap: 6px; ${style}border-radius: 12px; padding: 8px 0;" data-id="${escapeHtml(id)}" onclick="${handler}(this.dataset.id)">
            ${svgIcon(icon, 16)}
            ${label}
        </button>`;
    const renderRequest = req => {
        const type = REQUEST_TYPES[req.type] || { label: '', icon: null };
        return `
            <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="display:flex; justify-content:space-between; gap:10px; margin-bottom:12px; align-items:center;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text);">
                        ${type.icon ? svgIcon(type.icon, 18) : ''}
                        <span>${type.label}</span>
                    </div>
                    <span style="font-size:0.75rem; color:var(--text-secondary); white-space:nowrap; background: var(--surface-alt); padding: 4px 8px; border-radius: 12px;">${dateTimeFormatter.format(new Date(req.timestamp))}</span>
                </div>
                <div style="margin-bottom:16px; font-size: 0.95rem; color: var(--text); line-height: 1.5;">${renderRequestDetails(req, statusLabels)}</div>
                ${canApprove ? `
                <div style="display:flex; gap:10px;">
                    ${actionBtn('btn-primary', '', 'approveRequest', 'check', 'Genehmigen', req.id)}
                    ${actionBtn('', 'background: transparent; color: var(--text-secondary); border: 1px solid var(--border); ', 'rejectRequest', 'x', 'Ablehnen', req.id)}
                </div>` : ''}
            </div>`;
    };
    const grouped = groupBy(pending, req => req.personName || 'Unbekannt');
    const groupBlocks = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([personName, items]) => `
        <div style="margin-top: 16px;">
            <div style="font-weight: 600; margin-bottom: 10px; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 8px;">
                ${svgIcon('person', 16, 2, 'style="color: var(--secondary);"')}
                ${escapeHtml(personName)}
            </div>
            ${items.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).map(renderRequest).join('')}
        </div>`).join('');
    target.innerHTML = `
        <div class="card" style="margin-bottom: 20px;">
            <div class="card-header" style="display: flex; align-items: center; gap: 8px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.9rem; color: var(--text-secondary);">
                ${svgIcon('download', 18)}
                Offene Anfragen (${pending.length})
            </div>
            <div class="card-body" style="padding-top: 10px;">${groupBlocks}</div>
        </div>`;
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
    const options = people.filter(p => !p.uid).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    target.innerHTML = `
        <div class="card" style="margin-bottom:20px;">
            <div class="card-header">${t('unlinked_title', '🧩 Nicht zugeordnete Benutzer ({count})', { count: unlinked.length })}</div>
            <div class="card-body">
                ${unlinked.map(u => `
                    <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                        <div style="flex:1; min-width:200px;">
                            <div style="font-weight:700;">${escapeHtml(u.firstName || '?')} ${escapeHtml(u.lastName || '')}</div>
                            <div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(u.email || '')}</div>
                        </div>
                        <select id="link-select-${u.uid}" class="form-select" style="flex:1; min-width:220px;">
                            <option value="">${t('unlinked_select_person', 'Person auswählen')}</option>
                            ${options}
                        </select>
                        <button class="btn btn-primary btn-small" style="width:auto;" data-uid="${escapeHtml(u.uid)}" onclick="assignUserToPerson(this.dataset.uid)">${t('unlinked_assign_btn', 'Zuordnen')}</button>
                    </div>`).join('')}
            </div>
        </div>`;
}

async function assignUserToPerson(uid) {
    const select = $(`link-select-${uid}`);
    if (!select) return;
    const person = select.value && findPerson(select.value);
    if (!select.value) return alert(t('unlinked_alert_select_person', 'Bitte eine Person auswählen.'));
    if (!person) return alert(t('toast_person_not_found', 'Person nicht gefunden.'));
    try {
        await update(ref(db, 'people/' + select.value), { uid });
        person.uid = uid;
        showToast('Zuordnung gespeichert');
        renderUnlinkedUsers();
        renderPeople();
    } catch (err) {
        console.error('Fehler beim Zuordnen:', err);
        alert(t('unlinked_alert_failed', 'Zuordnung fehlgeschlagen. Bitte erneut versuchen.'));
    }
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

    currentEditedPayment = { personId, targetIndex, type, paymentId };
    const isExpense = type === 'expense';
    setText('edit-payment-person', ({ donation: '[Spende] ', expense: '[Ausgabe] ' }[type] || '') + (tx.personName || tx.who || 'Unbekannt'));
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
    if (Number.isNaN(amount)) return alert(t('alert_invalid_amount', 'Ungültiger Betrag.'));
    if (!date) return alert(t('alert_please_enter_date', 'Bitte ein Datum angeben.'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return alert(t('alert_invalid_date', 'Ungültiges Datum.'));

    const saveBtn = document.querySelector('#edit-payment-modal button.btn-primary');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Speichert...';
    }
    const { type, personId, paymentId, targetIndex } = currentEditedPayment;
    try {
        if (type === 'payment') {
            await mutatePerson(personId, draft => {
                const payments = draft.payments;
                const idx = targetIndex >= 0 && targetIndex < payments.length ? targetIndex : payments.findIndex(matchesPaymentId(paymentId));
                if (idx >= 0) payments[idx] = { ...payments[idx], amount, date, description };
                else console.warn('saveEditedPayment: fallback payment match not found, mapping all', currentEditedPayment);
                return { ...draft, payments, totalPaid: sumAmounts(payments) };
            });
            showToast('Zahlung aktualisiert');
        } else if (type === 'expense') {
            for (const file of $('edit-payment-new-receipt')?.files || []) {
                try {
                    currentEditedReceipts.push(await uploadReceipt(file, issuer || 'Beleg', date));
                } catch (uploadErr) {
                    console.error('Error uploading new receipt in edit:', uploadErr);
                    alert(t('alert_upload_error_for', 'Fehler beim Hochladen von: ') + file.name + ' - ' + uploadErr.message);
                    throw uploadErr;
                }
            }
            const receipt = currentEditedReceipts.length > 0 ? JSON.stringify(currentEditedReceipts) : '';
            await mutateCollection('expenses', list => replaceById(list, paymentId, { amount, date, description, issuer, receipt }));
            showToast('Ausgabe aktualisiert');
        } else {
            await mutateCollection('donations', list => replaceById(list, paymentId, { amount, date, description }));
            showToast('Spende aktualisiert');
        }
        closeModal('edit-payment-modal');
        currentEditedPayment = null;
        currentEditedReceipts = [];
        refreshFinanceViews();
    } catch (err) {
        console.error('Fehler beim Bearbeiten:', err);
        showToast('Eintrag konnte nicht aktualisiert werden', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = 'Speichern';
        }
    }
}

const fileRowInner = (preview, name, actions, nameStyle = 'color:var(--text); font-weight:600;') => `
    <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
        ${preview}
        <span style="${STYLE.fileName} ${nameStyle}">${escapeHtml(name)}</span>
    </div>
    ${actions ? `<div style="display:flex; gap:6px;">${actions}</div>` : ''}`;

async function renderEditReceiptsList() {
    const listEl = $('edit-payment-receipts-list');
    if (!listEl) return;
    if (currentEditedReceipts.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary); font-size:0.85rem;">Keine Belege vorhanden.</div>';
        return;
    }
    listEl.innerHTML = '';
    for (const filename of [...currentEditedReceipts]) {
        const item = document.createElement('div');
        item.style.cssText = STYLE.fileRow;
        item.innerHTML = fileRowInner('<div class="spinner" style="width:16px; height:16px; border-width:2px; margin:0;"></div>', filename, '', 'color:var(--text-secondary);');
        listEl.appendChild(item);
        const deleteBtn = iconButton(`deleteEditReceipt('${escapeHtml(filename)}')`, 'Löschen');
        try {
            const imgUrl = await fetchReceiptImage(filename);
            item.innerHTML = fileRowInner(`<img src="${imgUrl}" style="${STYLE.thumb}" alt="Beleg">`, filename,
                `<a href="${imgUrl}" download="${filename}" class="btn btn-secondary btn-small" style="${STYLE.outlineBtn} ${STYLE.iconBtn}" title="Herunterladen">${svgIcon('download')}</a>${deleteBtn}`);
        } catch {
            item.innerHTML = fileRowInner('<span style="font-size:1.25rem;">⚠️</span>', filename, deleteBtn, 'color:var(--text);');
        }
    }
}

function deleteEditReceipt(filename) {
    if (!confirmAction(t('confirm_delete_receipt', 'Möchtest du diesen Beleg wirklich löschen?'))) return;
    currentEditedReceipts = currentEditedReceipts.filter(fn => fn !== filename);
    renderEditReceiptsList();
}

async function confirmDeleteRecordedPayment() {
    if (!canManageFinances() || !currentEditedPayment) return;
    const { type, personId, paymentId, targetIndex } = currentEditedPayment;
    closeMultipleModals(['confirm-delete-modal', 'edit-payment-modal']);
    try {
        if (type === 'payment') {
            await mutatePerson(personId, draft => {
                const payments = draft.payments.filter((entry, i) => i !== targetIndex && !matchesPaymentId(paymentId)(entry, i));
                return { ...draft, payments, totalPaid: sumAmounts(payments) };
            });
        } else {
            await mutateCollection(type === 'donation' ? 'donations' : 'expenses', list => list.filter(entry => String(entry.id) !== String(paymentId)));
        }
        showToast({ payment: 'Zahlung gelöscht', donation: 'Spende gelöscht', expense: 'Ausgabe gelöscht' }[type]);
        currentEditedPayment = null;
        refreshFinanceViews();
    } catch (err) {
        console.error('Fehler beim Löschen:', err);
        showToast('Eintrag konnte nicht gelöscht werden', 'error');
    }
}

// --- Request approval ---
const newId = () => Date.now().toString();
const REQUEST_APPLIERS = {
    payment: (person, data) => ({
        ...person,
        payments: [...person.payments, { id: newId(), amount: parseFloat(data.amount), date: data.date, description: data.note || 'Zahlung (Genehmigt)' }],
        totalPaid: (person.totalPaid || 0) + parseFloat(data.amount)
    }),
    status: (person, { date, newStatus }) => {
        const changeDate = new Date(date);
        const latest = person.statusHistory.slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];
        const currentStart = latest?.endDate || person.originalMemberSince || person.memberSince;
        const statusHistory = person.statusHistory.filter(entry => new Date(entry.startDate) < changeDate);
        if (new Date(currentStart) < changeDate) statusHistory.push({ status: person.status, startDate: currentStart, endDate: date });
        return { ...person, status: newStatus, statusHistory };
    },
    standing_order: (person, data) => ({
        ...person,
        standingOrders: [...safeList(person.standingOrders), { id: newId(), amount: parseFloat(data.amount), startDate: data.date, note: data.note || 'Dauerauftrag (Genehmigt)', lastAutoPayment: null }]
    })
};

async function approveRequest(reqId) {
    const req = requests.find(r => r.id === reqId);
    if (!req) return;
    try {
        if (req.type === 'expense') {
            const { amount, description, date, receipt } = req.data;
            await mutateCollection('expenses', list => [...list, { id: newId(), amount: parseFloat(amount), description: description + ` (Von: ${req.personName})`, date, receipt }]);
        } else if (REQUEST_APPLIERS[req.type]) {
            await mutatePerson(req.personId, person => REQUEST_APPLIERS[req.type](person, req.data));
        }
        await update(ref(db, 'requests/' + reqId), { status: 'approved' });
        await loadData();
        showToast(t('toast_request_approved', 'Anfrage genehmigt'));
    } catch (err) {
        console.error('Fehler beim Genehmigen der Anfrage:', err);
        alert(t('alert_approve_failed', 'Anfrage konnte nicht genehmigt werden. Bitte erneut versuchen.'));
    }
}

async function rejectRequest(reqId) {
    const reason = prompt(t('status_btn', 'Grund für Ablehnung') + ':');
    if (reason === null) return;
    try {
        await update(ref(db, 'requests/' + reqId), { status: 'rejected', rejectionReason: reason || 'Kein Grund angegeben' });
        await loadData();
        showToast(t('toast_request_rejected', 'Anfrage abgelehnt'));
    } catch (err) {
        console.error('Fehler beim Ablehnen der Anfrage:', err);
        alert(t('alert_reject_failed', 'Anfrage konnte nicht abgelehnt werden. Bitte erneut versuchen.'));
    }
}

// --- Member views ---
const paidUntilText = paidUntil => (paidUntil ? monthYearFormatter.format(paidUntil) : t('never_paid', 'Nie'));
const personPaidUntil = p => (p._paidUntil ? new Date(p._paidUntil) : null);
const standingOrderCovers = meta => meta.isActiveStandingOrder && !meta.isOverdue;

function renderUserView() {
    renderHomeMentoringCard();
    renderHomeDutiesCard();
    const statusCard = $('user-status-card');
    const financeCard = $('user-finances-status-card');
    const historyEl = $('user-payment-history');
    const setCards = html => {
        if (statusCard) statusCard.innerHTML = html;
        if (financeCard) financeCard.innerHTML = html;
    };
    const noMemberHtml = `
        <div style="text-align:center; padding: 20px; color: var(--text-secondary); background: var(--surface); border-radius: 16px; border: 1px solid var(--border);">
            ${t('user_no_member_found', 'Kein Mitgliedseintrag gefunden.<br>Bitte kontaktieren Sie einen Administrator.')}
        </div>`;

    if (currentUser && currentUser.pays === false) {
        setCards(`
            <div class="user-hero-status user-status-ok" style="border-color: var(--border);">
                <div style="font-size: 2rem; margin-bottom: 8px;">👤</div>
                <h2 style="color: var(--text); font-size: 1.25rem; font-weight: 800; margin-bottom: 5px;">
                    ${t('user_account_non_paying_title', 'Benutzerkonto')}
                </h2>
                <div style="font-size: 0.95rem; color: var(--text-secondary);">
                    ${t('user_account_non_paying_desc', 'Aktives Benutzerkonto (Keine Beitragspflicht)')}
                </div>
            </div>`);
        if (historyEl) historyEl.innerHTML = '';
    } else if (people.length === 0) {
        setCards(noMemberHtml);
        if (historyEl) historyEl.innerHTML = `
            <div style="text-align:center; padding: 20px; color: var(--text-secondary); background: var(--surface); border-radius: 12px; border: 1px solid var(--border);">
                ${t('user_no_history', 'Keine Einträge vorhanden')}
            </div>`;
    } else {
        const p = findLinkedPerson(currentUser?.uid);
        if (!p) return setCards(noMemberHtml);
        const meta = p._statusMeta || { text: t('status_unknown', 'Unbekannt'), isOverdue: false, isSoonDue: false };
        const currentStatus = p._currentStatus || p.status;
        const [statusClass, accent, rgb] = meta.isOverdue ? ['user-status-overdue', 'var(--danger)', '239,68,68']
            : meta.isSoonDue ? ['user-status-soon', 'var(--warning)', '245,158,11'] : ['user-status-ok', 'var(--success)', '16,185,129'];
        const tint = `background:rgba(${rgb},0.08); border-color:rgba(${rgb},0.25);`;
        const statusText = escapeHtml(translateStatusText(meta.text));
        const subline = style => `<div class="user-finance-hero-sub"${style}>${standingOrderCovers(meta) ? t('user_standing_order_active', 'Dauerauftrag aktiv') : `${t('user_paid_until', 'Bezahlt bis')} <strong>${paidUntilText(personPaidUntil(p))}</strong>`}</div>`;
        const overdueBox = style => meta.isOverdue ? `
            <div class="user-finance-overdue-box"${style}>
                <div class="user-finance-overdue-label">${t('user_open_amount', 'Offener Betrag')}</div>
                <div class="user-finance-overdue-amount">${euro(p._overdueAmount || 0)}</div>
            </div>` : '';
        const requestStatus = t('user_req_status_tooltip', 'Statuswechsel beantragen');

        if (statusCard) {
            statusCard.style.display = 'block';
            statusCard.innerHTML = `
                <div class="user-hero-status ${statusClass}" style="${tint}">
                    <div class="user-finance-hero-title" style="color: ${accent}; font-size: 1.35rem; font-weight: 800; margin-bottom: 5px;">${statusText}</div>
                    ${subline(' style="font-size: 0.95rem;"')}
                    ${overdueBox(' style="margin-top: 14px; margin-bottom: 0;"')}
                </div>`;
        }
        if (financeCard) {
            financeCard.innerHTML = `
                <div class="user-finance-hero-card" style="${tint}">
                    <div class="user-finance-hero-top">
                        <div class="user-finance-hero-info">
                            <div class="user-finance-hero-title" style="color:${accent};">${statusText}</div>
                            ${subline('')}
                        </div>
                    </div>
                    ${overdueBox('')}
                    <div class="user-finance-stat-row">
                        <div class="user-finance-stat">
                            <div class="user-finance-stat-label">${t('user_monthly_rate', 'Monatsbeitrag')}</div>
                            <div class="user-finance-stat-value">${euro(settings[currentStatus] || 0)}</div>
                        </div>
                        <div class="user-finance-stat-divider"></div>
                        <div class="user-finance-stat user-finance-stat-clickable" role="button" tabindex="0" onclick="openUserRequestModal('status')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); openUserRequestModal('status');}" title="${requestStatus}" aria-label="${requestStatus}">
                            <div class="user-finance-stat-label">${t('user_current_status', 'Status')}</div>
                            <div class="user-finance-stat-value">${escapeHtml(getStatusLabels(false)[currentStatus] || currentStatus)}</div>
                        </div>
                    </div>
                </div>`;
        }
        if (historyEl) historyEl.innerHTML = generateTimelineHTML(p);
    }
    renderUserRequests();
}

const USER_REQUEST_STATES = {
    rejected: ['❌', '#ef444415', 'req_status_rejected', 'Abgelehnt'],
    approved: ['✅', '#10b98115', 'req_status_approved', 'Genehmigt'],
    pending: ['⏳', '#f59e0b15', 'req_status_pending', 'In Prüfung']
};

function renderUserRequests() {
    const reqList = $('user-requests-list');
    if (!reqList) return;
    const mine = currentUser ? requests.filter(r => r.userId === currentUser.uid).sort((a, b) => b.timestamp - a.timestamp) : [];
    if (mine.length === 0) {
        reqList.innerHTML = `
            <div class="user-requests-empty">
                <div class="user-requests-empty-title">${t('user_no_requests_title', 'Keine Anfragen vorhanden')}</div>
                <div class="user-requests-empty-desc">${t('user_no_requests_desc', 'Hier erscheinen deine eingereichten Anfragen.')}</div>
            </div>`;
        return;
    }
    const statusLabels = getStatusLabels(false);
    const typeIcons = { payment: '💰', status: '🔄', expense: '💸', standing_order: '🔁' };
    const typeLabels = { payment: t('action_payment', 'Zahlung'), status: t('action_status', 'Status'), expense: t('action_expense', 'Ausgabe'), standing_order: t('modal_standing_order', 'Dauerauftrag') };
    reqList.innerHTML = mine.map(req => {
        const [badge, bg, key, fallback] = USER_REQUEST_STATES[req.status] || USER_REQUEST_STATES.pending;
        const data = req.data || {};
        let receiptCount = 0;
        try {
            const receipts = JSON.parse(data.receipt);
            if (Array.isArray(receipts)) receiptCount = receipts.length;
        } catch { /* no receipts */ }
        const meta = [
            data.amount && `<span>💶 <strong>${euro(data.amount)}</strong></span>`,
            data.date && `<span>📅 ${formatDateFast(data.date)}</span>`,
            data.newStatus && `<span>💼 ${escapeHtml(statusLabels[data.newStatus] || data.newStatus)}</span>`,
            data.note && `<span>📝 ${escapeHtml(data.note)}</span>`,
            data.description && `<span>ℹ️ ${escapeHtml(data.description)}</span>`,
            receiptCount > 0 && `<span>📎 ${receiptCount} ${receiptCount === 1 ? 'Beleg' : 'Belege'}</span>`
        ].filter(Boolean);
        return `
            <div class="user-request-item">
                <div style="display: flex; justify-content: space-between; align-items: start;">
                    <div>
                        <div style="font-size: 1.05rem; font-weight: 700; margin-bottom: 3px;">${typeIcons[req.type] || '📋'} ${typeLabels[req.type] || req.type}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">${formatDateFast(req.timestamp)}</div>
                    </div>
                    <div style="background: ${bg}; padding: 6px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; white-space: nowrap;">
                        ${badge} ${t(key, fallback)}
                    </div>
                </div>
                ${meta.length ? `<div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:8px; font-size:0.85rem; color:var(--text-secondary); background:var(--surface-alt); padding:8px 12px; border-radius:8px;">${meta.join('')}</div>` : ''}
                ${req.status === 'rejected' ? `<div style="color:var(--danger); font-size:0.85rem; margin-top:8px; padding:10px; background:rgba(239, 68, 68, 0.1); border-radius:8px; border:1px solid rgba(239, 68, 68, 0.2);">⚠️ ${escapeHtml(req.rejectionReason) || t('user_no_reason', 'Keine Begründung')}</div>` : ''}
            </div>`;
    }).join('');
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
        ? `<h3 class="list-section-title" style="color:var(${color})">${t(key, fallback)} (${items.length})</h3>` + items.map(generatePersonHTML).join('')
        : '';
    list.innerHTML = `
        <div class="people-grid-container">
            <div class="people-column overdue-column">${section(overdue, '--danger', 'overdue_header', 'Überfällig')}</div>
            <div class="people-column valid-column">${section(current, '--success', 'current_members_header', 'Aktuelle Mitglieder')}</div>
        </div>`;
    filterPeopleSync();
}

function generateTimelineHTML(person) {
    const history = safeList(person.statusHistory);
    const events = history.map(h => ({ type: 'status', dateStr: h.startDate, status: h.status }));
    const currentStart = history.length > 0 ? history[history.length - 1].endDate : (person.originalMemberSince || person.memberSince);
    if (currentStart) events.push({ type: 'status', dateStr: currentStart, status: person.status });
    safeList(person.payments).forEach(p => events.push({ type: 'payment', dateStr: p.date, amount: p.amount, description: p.description }));
    if (events.length === 0) return `<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">${t('timeline_no_entries', 'Keine Einträge vorhanden.')}</div>`;

    const statusLabels = getStatusLabels(true);
    const line = (title, meta) => `
        <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div style="font-weight: 600;">${title}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">${meta}</div>
            </div>
        </div>`;
    return `<div class="timeline">${events.sort((a, b) => b.dateStr.localeCompare(a.dateStr)).map(ev => {
        const date = formatDateFast(ev.dateStr);
        return ev.type === 'status'
            ? line(`${t('timeline_status_change', 'Statusänderung')}: ${escapeHtml(statusLabels[ev.status] || ev.status)}`, `${t('timeline_valid_from', 'Gültig ab')} ${date}`)
            : line(`${t('timeline_payment', 'Zahlung')}: ${formatCurrency(ev.amount)}€`, `${escapeHtml(ev.description) || t('timeline_no_note', 'Keine Notiz')} • ${date}`);
    }).join('')}</div>`;
}

function renderStandingOrders(p) {
    const orders = safeList(p.standingOrders);
    if (orders.length === 0) return '';
    const chip = (icon, text, extraClass = '') => `
        <div class="so-chip${extraClass}">
            ${svgIcon(icon, 11)}
            <span>${text}</span>
        </div>`;
    return `
        <div class="standing-order-section">
            <div class="so-section-header">
                <div class="so-header-title">
                    ${svgIcon('rotate', 13, 2.5)}
                    <span>${t('modal_standing_order', 'Dauerauftrag')}</span>
                </div>
            </div>
            <div class="so-items-list">
                ${orders.map(so => {
                    const isEnded = so.endDate && new Date(so.endDate) < new Date();
                    const note = so.note?.trim();
                    return `
                    <div class="so-card-item ${isEnded ? 'is-ended' : ''}">
                        <div class="so-card-top">
                            <div class="so-card-amount-wrapper">
                                <span class="so-amount-val">${euro(so.amount)}</span>
                                <span class="so-period-label">/ ${t('month', 'Monat')}</span>
                                <span class="so-status-pill ${isEnded ? 'ended' : 'active'}">${isEnded ? t('status_ended', 'Beendet') : t('status_active', 'Aktiv')}</span>
                            </div>
                            ${canManageFinances() ? `
                            <button type="button" class="btn-so-action" data-pid="${escapeHtml(p.id)}" data-soid="${escapeHtml(so.id)}" onclick="openEndStandingOrderModal(this.dataset.pid, this.dataset.soid)" title="${escapeHtml(t('edit_end_title', 'Bearbeiten/Beenden'))}">
                                ${svgIcon('edit', 12)}
                                <span>${t('btn_manage', 'Verwalten')}</span>
                            </button>` : ''}
                        </div>
                        <div class="so-card-meta-chips">
                            ${chip('calendar', `Start: ${formatDateFast(so.startDate)}`)}
                            ${so.endDate ? chip('clock', `Ende: ${formatDateFast(so.endDate)}`, isEnded ? ' ended' : ' ') : ''}
                            ${note && note !== 'Ohne Notiz' && note !== 'No note' ? chip('fileText', escapeHtml(so.note), ' so-note-chip') : ''}
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
}

function generatePersonHTML(p) {
    const meta = p._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
    const dateText = paidUntilText(personPaidUntil(p));
    const pillClass = meta.isOverdue ? 'status-err' : meta.isSoonDue ? 'status-warn' : 'status-ok';
    const statusLabels = getStatusLabels(false);
    const currentStatus = p._currentStatus || p.status;
    const id = escapeHtml(p.id);
    const memberButton = (cls, handler, icon, size, strokeWidth, label) => `
        <button type="button" class="${cls}" data-id="${id}" onclick="${handler}(this.dataset.id)">
            ${svgIcon(icon, size, strokeWidth)}
            <span>${label}</span>
        </button>`;
    const tileLabel = (icon, label) => `
        <span class="summary-tile-label">
            ${svgIcon(icon, 12)}
            ${label}
        </span>`;
    return `
        <div class="person-wrapper">
            <div id="person-item-${p.id}" class="person-item" role="button" tabindex="0" aria-expanded="false" data-id="${id}" onclick="toggleDetails(this.dataset.id)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); toggleDetails(this.dataset.id);}">
                <div class="person-pill">
                    <div class="person-left">
                        <div class="person-name">
                            ${escapeHtml(p.name)}
                            <span class="chevron">›</span>
                        </div>
                        <span class="person-status">${escapeHtml(statusLabels[currentStatus] || currentStatus)}</span>
                    </div>
                    <div class="person-right">
                        ${standingOrderCovers(meta) ? '' : `<span class="payment-pill ${pillClass}">${dateText}</span>`}
                        <span class="time-remaining">${escapeHtml(translateStatusText(meta.text))}</span>
                    </div>
                </div>
            </div>
            <div id="drawer-${p.id}" class="person-details">
                <div class="details-content">
                    <div class="member-summary-card ${meta.isOverdue ? 'danger' : 'success'}">
                        <div class="summary-grid">
                            <div class="summary-tile">
                                ${tileLabel('user', t('status_label', 'Status'))}
                                <span class="summary-status-badge">${escapeHtml(statusLabels[p.status] || p.status)}</span>
                            </div>
                            <div class="summary-tile">
                                ${tileLabel('calendar', t('paid_until', 'Bezahlt bis'))}
                                ${standingOrderCovers(meta) ? `
                                    <span class="summary-so-badge">
                                        ${svgIcon('rotate', 11, 2.5)}
                                        ${t('status_standing_order_active', 'Dauerauftrag läuft')}
                                    </span>` : `<span class="summary-paid-badge ${pillClass}">${dateText}</span>`}
                            </div>
                        </div>
                        ${meta.isOverdue ? `
                        <div class="summary-overdue-alert">
                            <div class="overdue-alert-label">
                                ${svgIcon('alert', 14, 2.5)}
                                <span>${t('overdue_amount_label', 'Offener Betrag')}</span>
                            </div>
                            <span class="overdue-alert-val">${euro(p._overdueAmount || 0)}</span>
                        </div>` : ''}
                    </div>
                    ${renderStandingOrders(p)}
                    ${canManageFinances() ? `
                    <div class="member-actions-group">
                        ${memberButton('btn-member-primary', 'openPaymentModal', 'coin', 15, 2.2, t('record_payment_btn', 'Zahlung erfassen'))}
                        <div class="member-secondary-actions">
                            ${memberButton('btn-member-secondary', 'openChangeStatusModal', 'refresh', 14, 2, t('status_btn', 'Status'))}
                            ${memberButton('btn-member-secondary', 'sendStatusEmail', 'mail', 14, 2, t('email_btn', 'E-Mail'))}
                        </div>
                    </div>` : ''}
                    <div class="history-header">${t('history_label', 'Verlauf')}</div>
                    <div id="timeline-${p.id}">
                        <div style="padding:10px; color:var(--text-secondary); font-size:0.8rem; font-style:italic;">${t('loading_history', 'Lade Verlauf...')}</div>
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

function filterPeopleSync() {
    const term = $('people-search')?.value.toLowerCase() || '';
    document.querySelectorAll('.person-wrapper').forEach(item => {
        item.style.display = item.querySelector('.person-name')?.textContent.toLowerCase().includes(term) ? 'block' : 'none';
    });
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
            container.innerHTML = emptyNotice(t('no_transactions', 'Keine Buchungen vorhanden.'), 'text-align:center; padding:30px 20px; color:var(--text-secondary);');
            return;
        }
        let lastDate = null;
        let html = cachedTransactions.map((tx, index) => {
            const date = tx.date ? formatDateFast(tx.date) : t('no_date', 'Kein Datum');
            const header = date !== lastDate ? `<div style="margin: ${index === 0 ? '0' : '20px'} 0 8px 10px; font-weight: bold; font-size: 0.9rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">${date}</div>` : '';
            lastDate = date;
            const receiptBadge = tx.receipt ? `<span class="receipt-badge-inline" title="${escapeHtml(t('modal_expense_receipt', 'Beleg vorhanden'))}" style="display:inline-flex; align-items:center; vertical-align:-2px; margin-left:6px; color:var(--primary); opacity:0.85; flex-shrink: 0;">${svgIcon('paperclip', 14, 2.2)}</span>` : '';
            const desc = tx.description?.trim() ? `<span class="trans-desc">${escapeHtml(tx.description)}</span>` : '';
            const iconClass = TX_ICONS[tx.type] ? tx.type : 'exp';
            return `${header}
                <div class="trans-item" role="button" tabindex="0" data-id="${escapeHtml(tx.id)}" data-type="${escapeHtml(tx.type)}" onclick="showTransactionDetails(this.dataset.id, this.dataset.type)" onkeydown="if(event.key==='Enter'||event.key===' '){showTransactionDetails(this.dataset.id, this.dataset.type)}" style="cursor:pointer;">
                    <div style="display: flex; align-items: center; flex: 1; min-width: 0;">
                        <div class="trans-icon-wrapper ${iconClass}"${tx.type === 'pay' && tx.personUid ? ` data-uid="${tx.personUid}"` : ''}>
                            ${svgIcon(TX_ICONS[iconClass], 20)}
                        </div>
                        <div class="trans-left" style="flex: 1; min-width: 0;">
                            <span style="font-weight:600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(tx.who)}</span>
                            ${desc || receiptBadge ? `<div class="trans-meta">${desc}${receiptBadge}</div>` : ''}
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; margin-left: 12px; flex-shrink: 0;">
                        <div class="trans-amount ${txColor(tx)}" style="font-size: 1.1rem;">${txSign(tx)}${formatCurrency(tx.amount)}€</div>
                    </div>
                </div>`;
        }).join('');
        if (cachedTransactions.length < transactionTotalItems) {
            html += `
                <div style="text-align:center; padding:20px;">
                    <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom: 12px;">${t('showing_transactions_count', 'Es werden {count} von {total} Buchungen angezeigt.', { count: cachedTransactions.length, total: transactionTotalItems })}</div>
                    <button class="btn btn-secondary" onclick="loadMoreHistory()">${t('load_more_btn', 'Mehr laden...')}</button>
                </div>`;
        }
        const scrollContainer = container.parentElement;
        const previousScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        container.innerHTML = html;
        container.querySelectorAll('.trans-icon-wrapper[data-uid]').forEach(wrapper => {
            getProfilePicUrl(wrapper.dataset.uid).then(url => {
                if (!url) return;
                wrapper.innerHTML = `<img src="${url}" alt="${escapeHtml(t('profile_pic_title', 'Profil'))}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`;
                wrapper.style.background = 'transparent';
                wrapper.style.color = 'inherit';
            });
        });
        if (!resetLimit && scrollContainer) scrollContainer.scrollTop = previousScrollTop;
    } catch (err) {
        console.error('Fehler beim Laden der Transaktionen:', err);
        container.innerHTML = emptyNotice(t('error_loading_transactions', 'Fehler beim Laden der Buchungen.'), 'text-align:center; padding:30px 20px; color:var(--danger);');
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
    const typeName = { exp: t('action_expense', 'Ausgabe'), don: t('btn_add_donation', 'Spende'), pay: t('action_payment', 'Zahlung') }[type];
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
                <span>ℹ️</span> <span>${escapeHtml(t('modal_section_info', 'Transaktionsdetails'))}</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; font-size:0.86rem;">
                ${detailRow(`📅 ${escapeHtml(t('modal_date', 'Datum'))}`, tx.date ? formatDateFast(tx.date) : '-')}
                ${who ? detailRow(`👤 ${escapeHtml(t('modal_person_name', 'Person'))}`, escapeHtml(who)) : ''}
                ${tx.issuer ? detailRow(`🏛️ ${escapeHtml(t('details_issued_by', 'Ausgestellt von'))}`, escapeHtml(tx.issuer)) : ''}
                ${description ? `
                <div style="display:flex; flex-direction:column; gap:4px; padding-top:2px;">
                    <span style="color:var(--text-secondary); font-size:0.78rem; font-weight:500;">📝 ${escapeHtml(t('details_description', 'Beschreibung'))}</span>
                    <span style="font-weight:500; color:var(--text); background:var(--surface); padding:7px 10px; border-radius:8px; border:1px solid var(--border-light); word-break:break-word; white-space:pre-wrap; font-size:0.84rem;">${escapeHtml(description)}</span>
                </div>` : ''}
            </div>
        </div>
        <div id="receipt-container" style="margin-top:10px;"></div>`;

    const noReceipts = `<div style="color:var(--text-secondary); text-align:center; font-size:0.9rem;">${t('no_receipts', 'Kein Beleg vorhanden.')}</div>`;
    if (!tx.receipt) {
        $('receipt-container').innerHTML = noReceipts;
        return;
    }
    await renderReceiptsInto($('receipt-container'), tx.receipt, {
        holder: content,
        loading: `<div class="spinner" style="margin:20px auto;"></div><div style="text-align:center">${t('loading_receipts', 'Lade Belege...')}</div>`,
        header: `<div style="font-weight:600; margin-bottom:10px;">${t('details_receipts', 'Belege')}</div>`,
        listStyle: 'display:flex; flex-direction:column; gap:15px;',
        empty: noReceipts,
        error: `<div style="color:var(--danger); text-align:center;">${t('error_loading_receipts', 'Belege konnten nicht geladen werden.')}</div>`
    });
}

function viewRequestReceipt(receiptField, containerId) {
    const container = $(containerId);
    if (!container) return;
    renderReceiptsInto(container, receiptField, {
        loading: '<div class="spinner" style="margin:10px auto;"></div><div style="text-align:center; font-size:0.8rem; color:var(--text-secondary);">Lade Beleg(e)...</div>',
        listStyle: 'display:flex; flex-direction:column; gap:15px; margin-top:10px;',
        empty: '<div style="color:var(--text-secondary); font-size:0.8rem; margin-top:10px;">Kein Beleg vorhanden.</div>',
        error: '<div style="color:var(--danger); font-size:0.8rem; margin-top:10px;">Fehler beim Laden des Belegs.</div>'
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
    if (preview) preview.innerHTML = reportPlaceholder('<div class="spinner" style="margin: 0 auto 15px;"></div>', t('loading', 'Lade Daten...'));
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
                ? emptyNotice(t('no_transactions', 'Keine Buchungen vorhanden.'))
                : allReportTransactions.map((tx, idx) => {
                    const key = reportKey(tx, idx);
                    return `
                        <div class="report-checklist-item" onclick="window.toggleManualTransactionSelection('${key}')">
                            <input type="checkbox" id="chk-report-${key}" value="${key}" onclick="event.stopPropagation(); window.toggleManualTransactionSelection('${key}')">
                            <div class="report-checklist-info">
                                <span style="font-weight: 600;">${escapeHtml(tx.who)}</span>
                                <span class="report-checklist-meta">${tx.date ? formatDateFast(tx.date) : ''} &bull; <span class="${txColor(tx)}">${txSign(tx)}${formatCurrency(tx.amount)}€</span></span>
                            </div>
                        </div>`;
                }).join('');
        }
        $('report-type-select').value = 'annual';
        onReportTypeChange();
    } catch (err) {
        console.error('Fehler beim Laden der Berichtstransaktionen:', err);
        if (preview) preview.innerHTML = reportPlaceholder('<div class="report-placeholder-icon">⚠️</div>', t('alert_error_loading_data', 'Fehler beim Laden der Daten.'), ' style="color: var(--danger);"');
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

function onReportTypeChange() {
    const type = inputValue('report-type-select');
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
            description: fromText && toText ? `${fromText} - ${toText}` : fromText ? `Ab ${fromText}` : toText ? `Bis ${toText}` : 'Alle Buchungen'
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

const REPORT_TYPE_LABELS = { pay: ['report_type_membership', 'Membership'], don: ['report_type_donation', 'Donation'], exp: ['report_type_expense', 'Expense'] };

function renderReportRows(filtered, tier) {
    return filtered.map(tx => {
        const isExp = tx.type === 'exp';
        const [key, fallback] = REPORT_TYPE_LABELS[tx.type] || REPORT_TYPE_LABELS.exp;
        const partner = tx.type === 'pay' ? tx.who : tx.type === 'don' ? tx.who || t(key, fallback) : tx.description || tx.who || t(key, fallback);
        let rows = `
            <tr>
                <td>${tx.date ? formatDateFast(tx.date) : ''}</td>
                <td><strong>${t(key, fallback)}</strong></td>
                <td>${escapeHtml(partner)}</td>
                <td class="amount-cell ${isExp ? 'amount-expense' : 'amount-income'}">${txSign(tx)}${euro(tx.amount)}</td>
            </tr>`;
        const notes = !isExp ? (tx.description || tx.note || '') : '';
        const tags = tx.tags ? (Array.isArray(tx.tags) ? tx.tags : [tx.tags]) : [];
        if (tier === 'detailed' && (notes || tx.receipt || tags.length > 0)) {
            rows += `
                <tr class="preview-detail-row">
                    <td></td>
                    <td colspan="3">${notes ? `<div class="preview-notes">"${escapeHtml(notes)}"</div>` : ''}${tags.length ? `<div>${tags.map(tag => `<span class="preview-tags-badge">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${tx.receipt ? `
                        <div class="preview-attachment-indicator">
                            ${svgIcon('upload', 12, 2.5, 'style="margin-right: 2px;"')}
                            <span>${t('report_receipt_attached', 'Receipt attached')}</span>
                        </div>` : ''}</td>
                </tr>`;
        }
        return rows;
    }).join('');
}

function updateReportPreview() {
    const type = inputValue('report-type-select');
    const tier = inputValue('report-tier-select');
    const preview = $('report-print-preview');
    if (!preview) return;
    const { filtered, description, person } = selectReportTransactions(type);
    filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (filtered.length === 0) {
        preview.innerHTML = reportPlaceholder('<div class="report-placeholder-icon">📄</div>', t('report_no_data', 'Keine Daten im gewählten Zeitraum'));
        return;
    }
    const income = sumAmounts(filtered.filter(tx => tx.type !== 'exp'));
    const expenses = sumAmounts(filtered.filter(tx => tx.type === 'exp'));
    const net = income - expenses;
    const statCard = (label, cls, value) => `
        <div class="preview-stat-card">
            <div class="preview-stat-label">${label}</div>
            <div class="preview-stat-value ${cls}">${value}</div>
        </div>`;
    const overdue = person?._overdueAmount || 0;
    const thirdCard = type !== 'person' ? statCard(t('report_balance', 'Balance'), `balance ${net >= 0 ? 'income' : 'expense'}`, `${net >= 0 ? '+' : ''}${euro(net)}`)
        : overdue > 0 ? statCard(t('report_outstanding_till_today', 'Ausstehend (bis heute)'), 'expense', euro(overdue))
        : statCard(t('status_label', 'Status'), 'income', t('report_status_good', 'Kein Rückstand'));
    preview.innerHTML = `
        <div class="preview-header">
            <div class="preview-logo">
                ${svgIcon('shield', 28, 2.5, 'style="color: #1e3a8a;"')}
                <span>${escapeHtml(APP_NAME)}</span>
            </div>
            <div class="preview-meta">
                <div>${t('report_created_on', 'Created on:')} ${formatDateFast(getTodayStr())}</div>
                <div style="font-weight: 600; margin-top: 2px;">${description}</div>
            </div>
        </div>
        <div class="preview-title-block">
            <h2>${t('report_financial_report', 'Financial Report')}</h2>
            <div style="font-size: 0.9rem; color: #718096; margin-top: 5px;">
                ${t('report_summary', 'Summary of income and expenses')}
            </div>
        </div>
        <div class="preview-stats-grid">
            ${statCard(t('nav_income', 'Einnahmen'), 'income', `+${euro(income)}`)}
            ${statCard(t('nav_expenses', 'Ausgaben'), 'expense', `-${euro(expenses)}`)}
            ${thirdCard}
        </div>
        ${tier === 'compact' ? '' : `
        <table class="preview-table">
            <thead><tr><th>${t('report_table_date', 'Date')}</th><th>${t('report_table_type', 'Type')}</th><th>${t('report_table_desc', 'Description / Partner')}</th><th style="text-align: right;">${t('report_table_amount', 'Amount')}</th></tr></thead>
            <tbody>${renderReportRows(filtered, tier)}</tbody>
        </table>`}`;
    requestAnimationFrame(resizeReportPreview);
}

function downloadReportPdf() {
    const element = $('report-print-preview');
    if (!element) return;
    if (typeof html2pdf === 'undefined') return alert(t('report_pdf_lib_error', 'PDF library failed to load.'));
    setButtonLoading('btn-download-pdf', true, t('report_generating', 'Generating...'));
    // Render an unscaled off-screen A4-width clone to avoid a blank first page
    const printContainer = document.createElement('div');
    printContainer.style.cssText = 'position: absolute; left: 0; top: 0; width: 794px; pointer-events: none; z-index: -9999; background: #ffffff;';
    const clone = element.cloneNode(true);
    clone.style.cssText += 'transform: none; min-height: auto; width: 794px; padding: 30px 35px !important; margin: 0; box-sizing: border-box; background: #ffffff;';
    printContainer.appendChild(clone);
    document.body.appendChild(printContainer);
    const done = () => {
        setButtonLoading('btn-download-pdf', false);
        printContainer.remove();
    };
    html2pdf().set({
        margin: 0,
        filename: `${APP_NAME.replace(/[^a-zA-Z0-9]/g, '_')}_Finanzbericht_${getTodayStr()}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false, scrollY: 0, scrollX: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.preview-stat-card', '.preview-header', '.preview-title-block', 'tr'] }
    }).from(clone).save().then(done).catch(err => {
        console.error('PDF generation failed:', err);
        done();
        alert(t('report_pdf_error', 'Failed to generate PDF.'));
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

async function addPayment() {
    if (!validateRequired(['payment-amount', 'payment-date'])) return;
    setButtonLoading('btn-add-payment', true, 'Buche...');
    const amount = parseAmount(inputValue('payment-amount'));
    const date = inputValue('payment-date');
    const note = inputValue('payment-desc');
    const isStandingOrder = isChecked('payment-is-standing-order');
    try {
        if (!currentPersonId || isNaN(amount)) return;
        const updated = await mutatePerson(currentPersonId, person => isStandingOrder
            ? { ...person, standingOrders: [...safeList(person.standingOrders), { id: newId(), amount, startDate: date, note, lastAutoPayment: null }] }
            : { ...person, payments: [...person.payments, { amount, date, description: note, id: Date.now() }], totalPaid: (person.totalPaid || 0) + amount });
        if (!updated) return alert(t('alert_person_not_found', 'Person nicht gefunden.'));
        closeModal('add-payment-modal');
        if (currentUser && !currentUser.admin) renderUserView();
        else refreshFinanceViews();
        $('payment-is-standing-order').checked = false;
        setText('payment-date-label', 'Datum');
        showToast(t('toast_payment_booked', 'Zahlung gebucht'));
    } catch (err) {
        console.error('Fehler beim Speichern der Zahlung:', err);
        alert(t('alert_save_payment_failed', 'Zahlung konnte nicht gespeichert werden. Bitte erneut versuchen.'));
    } finally {
        setButtonLoading('btn-add-payment', false);
    }
}

async function addDonation() {
    if (!validateRequired(['donation-amount', 'donation-date', 'donation-name'])) return;
    const amount = parseAmount(inputValue('donation-amount'));
    if (isNaN(amount)) return;
    setButtonLoading('btn-add-donation', true, 'Speichert...');
    try {
        const donation = { amount, name: inputValue('donation-name'), date: inputValue('donation-date'), description: inputValue('donation-desc').trim(), id: Date.now() };
        await mutateCollection('donations', list => [...list, donation]);
        closeModal('add-donation-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        ['donation-amount', 'donation-name', 'donation-date', 'donation-desc'].forEach(id => setValue(id, ''));
        showToast(t('toast_donation_saved', 'Spende gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der Spende:', err);
        alert(t('alert_save_donation_failed', 'Spende konnte nicht gespeichert werden. Bitte erneut versuchen.'));
    } finally {
        setButtonLoading('btn-add-donation', false);
    }
}

async function addExpense() {
    if (!validateRequired(['expense-amount', 'expense-date', 'expense-issuer', 'expense-desc'])) return;
    const amount = parseAmount(inputValue('expense-amount'));
    if (isNaN(amount)) return;
    const [issuer, date, description] = ['expense-issuer', 'expense-date', 'expense-desc'].map(inputValue);
    setButtonLoading('btn-add-expense', true, 'Speichert...');
    try {
        let receipt = null;
        if (pendingUploads.expense.files.length > 0) {
            setButtonLoading('btn-add-expense', true, 'Lade hoch...');
            try {
                receipt = await uploadAll(pendingUploads.expense.files, issuer, date);
            } catch (err) {
                console.error(err);
                return alert(t('alert_receipt_upload_error', 'Fehler beim Hochladen des Belegs: ') + err.message);
            }
        }
        await mutateCollection('expenses', list => [...list, { amount, issuer, description, date, id: Date.now(), receipt }]);
        closeModal('add-expense-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        ['expense-amount', 'expense-issuer', 'expense-desc', 'expense-receipt'].forEach(id => setValue(id, ''));
        resetPendingFiles('expense');
        showToast(t('toast_expense_saved', 'Ausgabe gespeichert'));
    } catch (err) {
        console.error('Fehler beim Speichern der Ausgabe:', err);
        alert(t('alert_save_expense_failed', 'Ausgabe konnte nicht gespeichert werden. Bitte erneut versuchen.'));
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
    if (!endDate) return alert(t('alert_please_choose_date', 'Bitte Datum wählen.'));
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
        showToast(t('toast_so_updated', 'Dauerauftrag aktualisiert'));
    } catch (err) {
        console.error('Fehler beim Beenden:', err);
        alert(t('alert_save_error', 'Fehler beim Speichern.'));
    }
}

async function deleteStandingOrderCompletely() {
    if (!confirmAction(t('confirm_delete_so', 'Dauerauftrag wirklich komplett entfernen? Historie geht verloren.'))) return;
    try {
        await mutatePerson(editingPersonId, person => ({ ...person, standingOrders: safeList(person.standingOrders).filter(so => String(so.id) !== String(editingSoId)) }));
        await renderViews();
        closeModal('end-standing-order-modal');
        showToast(t('toast_so_deleted', 'Dauerauftrag gelöscht'));
    } catch (err) {
        console.error('Fehler beim Löschen:', err);
        alert(t('alert_delete_error', 'Fehler beim Löschen.'));
    }
}

// --- Member status changes & status e-mail ---
// Rewrites the status history so `newStatus` applies from `changeDateStr` (retroactive or future changes).
function applyStatusChangeToHistory(person, newStatus, changeDateStr) {
    const memberSince = person.originalMemberSince || person.memberSince || changeDateStr;
    const changeDate = new Date(changeDateStr);
    if (changeDate < new Date(memberSince)) throw new Error('Änderungsdatum liegt vor Beginn der Mitgliedschaft.');
    if (changeDateStr <= memberSince) return { ...person, status: newStatus, statusHistory: [{ status: newStatus, startDate: memberSince }] };

    const history = safeList(person.statusHistory)
        .filter(entry => (entry.startDate ? new Date(entry.startDate) : new Date(memberSince)) < changeDate)
        .map(entry => (entry.endDate && new Date(entry.endDate) <= changeDate ? { ...entry } : { ...entry, endDate: changeDateStr }));
    const lastEnd = history[history.length - 1]?.endDate;
    if (history.length === 0 || (lastEnd && lastEnd < changeDateStr)) {
        const priorStart = lastEnd || memberSince;
        if (priorStart < changeDateStr) history.push({ status: person.status || 'vollverdiener', startDate: priorStart, endDate: changeDateStr });
    }
    history.push({ status: newStatus, startDate: changeDateStr });
    return { ...person, status: newStatus, statusHistory: history };
}

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
    if (!changeDate) return alert(t('alert_please_enter_date', 'Bitte ein Datum angeben.'));
    try {
        const updated = await mutatePerson(currentPersonId, person => applyStatusChangeToHistory(person, inputValue('change-status-select'), changeDate));
        if (!updated) return alert(t('alert_person_not_found', 'Person nicht gefunden.'));
        await renderViews();
        closeModal('change-status-modal');
        showToast(t('toast_status_changed', 'Status geändert'));
    } catch (err) {
        console.error('Fehler bei der Statusänderung:', err);
        alert(t('alert_status_change_failed', 'Statusänderung fehlgeschlagen: ') + err.message);
    }
}

async function sendStatusEmail(personId) {
    if (!canManageFinances()) return;
    const person = findPerson(personId);
    if (!person) return showToast('Person nicht gefunden', 'error');
    const email = person.uid && users.find(u => u.uid === person.uid)?.email;
    if (!email) return showToast('Keine E-Mail-Adresse für diese Person hinterlegt', 'error');

    const meta = person._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
    const readableStatus = getStatusLabels(false)[person._currentStatus || person.status] || person._currentStatus || person.status;
    const paidUntil = person._paidUntil ? new Date(person._paidUntil) : calculatePaidUntil(person);
    const paidUntilLabel = paidUntil ? monthYearFormatter.format(paidUntil) : 'Nie';
    const today = new Date();
    const overdueMonths = paidUntil ? Math.max(0, (today.getFullYear() * 12 + today.getMonth()) - (paidUntil.getFullYear() * 12 + paidUntil.getMonth())) : 0;
    const monthStr = overdueMonths === 1 ? 'einen Monat' : `${overdueMonths} Monate`;
    const openAmount = euro(person._overdueAmount || 0);
    const box = (color, border, inner) => `<div style="background-color: ${color}; border-left: 4px solid ${border}; padding: 15px; border-radius: 8px; margin-bottom: 25px;">${inner}</div>`;
    const okParagraph = text => `<p style="margin: 0; color: #15803D; font-size: 16px; font-weight: 600;">${text}</p>`;
    let customMessage;
    let customHtml;
    if (meta.isActiveStandingOrder) {
        customMessage = 'Wir haben festgestellt, dass dein Dauerauftrag aktiv ist – du musst dich also um nichts weiter kümmern!';
        customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
    } else if (meta.isOverdue) {
        customMessage = `Das bedeutet, dass dein Beitrag aktuell für ${monthStr} überfällig ist.\nInsgesamt beläuft sich der offene Betrag auf ${openAmount}.`;
        customHtml = box('#FEF2F2', '#EF4444', `<p style="margin: 0 0 5px 0; color: #B91C1C; font-size: 16px;">Das bedeutet, dass dein Beitrag aktuell für <strong>${monthStr}</strong> überfällig ist.</p><p style="margin: 0; color: #B91C1C; font-size: 16px; font-weight: 600;">Insgesamt beläuft sich der offene Betrag auf ${openAmount}.</p>`);
    } else {
        customMessage = 'Dein Beitragskonto ist damit bestens ausgeglichen. Vielen Dank dafür!';
        customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
    }
    const paragraph = (margin, content, extra = ' line-height: 1.5;') => `<p style="margin: ${margin}; font-size: 16px;${extra}">${content}</p>`;
    const text = `Hallo ${person.name},\n\nwir möchten dir ein kurzes Update zu deinem aktuellen Status in der Kasse geben.\n\nDein Beitragstarif ist derzeit auf '${readableStatus}' eingestellt.\nNach unseren Aufzeichnungen hast du deine Beiträge bis einschließlich ${paidUntilLabel} bezahlt.\n\n${customMessage}\n\nBei Fragen kannst du dich jederzeit gerne melden.\n\nLiebe Grüße,\ndein ${APP_NAME} Team`;
    const html = `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
                    <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(APP_NAME)}</h1>
                </div>
                <div style="padding: 40px 30px;">
                    <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; color: #1A202C;">Hallo ${escapeHtml(person.name)},</h2>
                    ${paragraph('0 0 15px 0', 'wir möchten dir ein kurzes Update zu deinem aktuellen Status in der Kasse geben.')}
                    ${paragraph('0 0 15px 0', `Dein Beitragstarif ist derzeit auf <strong style="color: #14B8A6;">${escapeHtml(readableStatus)}</strong> eingestellt.`)}
                    ${paragraph('0 0 25px 0', `Nach unseren Aufzeichnungen hast du deine Beiträge bis einschließlich <strong style="color: #4A5568;">${escapeHtml(paidUntilLabel)}</strong> bezahlt.`)}
                    ${customHtml}
                    ${paragraph('0 0 5px 0', 'Bei Fragen kannst du dich jederzeit gerne melden.', ' color: #4A5568;')}
                    <br>
                    ${paragraph('0 0 5px 0', 'Liebe Grüße,', ' color: #4A5568;')}
                    ${paragraph('0', `dein ${escapeHtml(APP_NAME)} Team`, ' font-weight: 600; color: #2D3748;')}
                </div>
            </div>
        </div>`;
    try {
        const res = await api('/send-email', 'POST', { to: email, subject: `Dein Kassenstatus - ${APP_NAME}`, text, html });
        if (res.ok) {
            showToast('Status-E-Mail gesendet');
        } else {
            showToast('Fehler beim Senden der E-Mail', 'error');
            console.error('Email API response not ok:', await res.text());
        }
    } catch (err) {
        console.error('Fehler beim Senden der Status-E-Mail:', err);
        showToast('Fehler beim Senden der E-Mail', 'error');
    }
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
            <input type="text" inputmode="decimal" id="req-amount" class="form-input hero-amount-input" placeholder="0,00">
        </div>
    </div>`;
const requestDateInput = () => `<input type="date" id="req-date" class="form-input" value="${getTodayStr()}">`;

const REQUEST_FORMS = {
    payment: {
        badge: ['badge-donation', '💳'],
        title: () => [t('user_req_payment_title', 'Zahlung melden'), t('user_req_payment_subtitle', 'Beitrag & Einzahlung an Admin melden')],
        body: () => modalSection('💶', t('modal_section_amount', 'Zahlungsbetrag'), amountField())
            + modalSection('⚙️', t('modal_section_payment_type', 'Zahlungsart & Datum'), `
                <div class="modal-switch-row">
                    <label class="switch">
                        <input type="checkbox" id="req-is-standing-order" onchange="document.getElementById('req-date-label').innerText = this.checked ? '${escapeHtml(t('modal_date_start', 'Startdatum'))}' : '${escapeHtml(t('modal_date', 'Datum'))}'">
                        <span class="slider"></span>
                    </label>
                    <label for="req-is-standing-order" class="modal-switch-label">${t('modal_standing_order', 'Dauerauftrag')}</label>
                </div>
                <div class="form-group">
                    <label class="form-label" id="req-date-label" for="req-date" style="display:none;">${t('modal_date', 'Datum')}</label>
                    ${requestDateInput()}
                </div>`)
            + modalSection('📝', t('modal_note', 'Notiz / Verwendungszweck'), `
                <div class="form-group">
                    <input type="text" id="req-note" class="form-input" placeholder="${t('modal_note_placeholder', 'z.B. Beitrag Mai')}">
                </div>`)
    },
    status: {
        badge: ['badge-person', '⚡'],
        title: () => [t('user_req_status_title', 'Statusänderung beantragen'), t('user_req_status_subtitle', 'Neuen Mitgliedsstatus anfragen')],
        body: () => {
            const myPerson = people.length > 0 ? findLinkedPerson(currentUser?.uid) : null;
            const current = myPerson?._currentStatus || myPerson?.status;
            const labels = getStatusLabels(true);
            return modalSection('💼', t('modal_new_status', 'Neuer Status'), `
                <div class="form-group">
                    <select id="req-status" class="form-select">
                        ${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>`)
                + modalSection('📅', t('modal_valid_from', 'Gültigkeitsdatum'), `
                <div class="form-group">
                    ${requestDateInput()}
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:5px; line-height:1.35;">
                        ${t('modal_status_desc', '<strong>Rückwirkend:</strong> Korrigiert die Berechnung ab dem angegebenen Datum.<br><strong>Zukünftig:</strong> Der neue Status gilt ab dem Datum (bisherige Berechnung bleibt).')}
                    </div>
                </div>`);
        }
    },
    expense: {
        badge: ['badge-expense', '🧾'],
        title: () => [t('user_req_expense_title', 'Ausgabe melden'), t('user_req_expense_subtitle', 'Ausgabe zur Erstattung einreichen')],
        body: () => modalSection('💶', t('modal_section_amount', 'Ausgabenbetrag'), amountField())
            + modalSection('ℹ️', t('modal_section_info', 'Angaben zur Ausgabe'), `
                <div class="form-group">
                    <label class="form-label" for="req-desc">${t('req_desc_label', 'Beschreibung / Wofür?')}</label>
                    <input type="text" id="req-desc" class="form-input" placeholder="${t('modal_expense_what_placeholder', 'Verwendungszweck')}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="req-date">${t('modal_date', 'Datum')}</label>
                    ${requestDateInput()}
                </div>`)
            + modalSection('📎', t('modal_expense_receipt', 'Beleg anhängen'), `
                <div class="file-upload-dropzone">
                    <div class="file-upload-icon">📁</div>
                    <div class="file-upload-text">${t('modal_expense_receipt_text', 'Beleg auswählen oder hierhin ziehen')}</div>
                    <div class="file-upload-subtext">JPG, PNG, HEIC, PDF</div>
                    <input type="file" id="req-receipt" accept="image/*,.heic,.heif,.pdf" multiple onchange="window.handleReqReceiptFiles(this.files)">
                </div>
                <div id="req-receipt-preview-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;"></div>`)
    }
};
const REQUEST_CHOICES = [
    ['payment', 'rgba(6, 182, 212, 0.12)', 'var(--primary)', '💳', 'user_req_type_payment', 'Einzahlung / Zahlung', 'user_req_type_payment_desc', 'Beitrag oder Einzahlung melden.'],
    ['status', 'rgba(245, 158, 11, 0.12)', '#f59e0b', '⚡', 'user_req_type_status', 'Statuswechsel', 'user_req_type_status_desc', 'Änderung des Mitgliedsstatus beantragen.'],
    ['expense', 'rgba(239, 68, 68, 0.12)', 'var(--danger)', '🧾', 'user_req_type_expense', 'Ausgabe', 'user_req_type_expense_desc', 'Ausgabe zur Erstattung einreichen (mit Beleg).']
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
    const [title, subtitle] = form ? form.title() : [t('user_request_modal_title', 'Anfrage'), t('user_req_select_subtitle', 'Wähle die Art der Anfrage')];
    if ($('req-modal-title')) $('req-modal-title').innerText = title;
    if ($('req-modal-subtitle')) $('req-modal-subtitle').innerText = subtitle;
    show('req-modal-back-btn', !!form, 'inline-flex');
    show('btn-submit-request', !!form, 'block');
    $('req-form-content').innerHTML = form ? form.body() : `
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 2px;">
            ${REQUEST_CHOICES.map(([key, bg, color, icon, titleKey, titleFallback, descKey, descFallback]) => `
                <button type="button" onclick="openUserRequestModal('${key}')" style="display: flex; align-items: center; text-align: left; width: 100%; background: var(--surface-alt); border: 1px solid var(--border-light); border-radius: 12px; padding: 10px 12px; cursor: pointer; transition: all 0.2s ease;">
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
    const fillFields = () => alert(t('alert_fill_fields', 'Bitte alle Felder ausfüllen.'));
    const invalidAmount = amount => isNaN(parseFloat(amount)) || parseFloat(amount) <= 0;
    if (currentRequestType === 'status') {
        const newStatus = $('req-status') ? inputValue('req-status') : 'vollverdiener';
        return newStatus ? { type: 'status', data: { newStatus, date } } : fillFields();
    }
    const amount = normalizeAmount(inputValue('req-amount'));
    if (currentRequestType === 'expense') {
        const description = inputValue('req-desc').trim();
        if (!amount || !description) return fillFields();
        if (invalidAmount(amount)) return alert(t('alert_invalid_amount', 'Ungültiger Betrag.'));
        return { type: 'expense', data: { amount, description, date } };
    }
    if (currentRequestType !== 'payment') return { type: 'payment', data: {} };
    if (!amount) return fillFields();
    if (invalidAmount(amount)) return alert(t('alert_invalid_amount', 'Ungültiger Betrag.'));
    return { type: isChecked('req-is-standing-order') ? 'standing_order' : 'payment', data: { amount, date, note: inputValue('req-note').trim() } };
}

async function submitUserRequest() {
    if (!currentUser) return;
    const person = people.find(p => p.uid === currentUser.uid) || people[0] || null;
    const personId = person ? person.id : (currentUser.uid || currentUser.id || 'unknown');
    const personName = person ? person.name : (fullName(currentUser) || currentUser.name || currentUser.email || 'Benutzer');
    const date = $('req-date') ? inputValue('req-date') : getTodayStr();
    if (!date) return alert(t('alert_fill_fields', 'Bitte alle Felder ausfüllen.'));
    const request = collectRequestData(date);
    if (!request) return;

    if (request.type === 'expense') {
        const files = pendingUploads.req.files.length > 0 ? pendingUploads.req.files : Array.from($('req-receipt')?.files || []);
        if (files.length > 0) {
            setButtonLoading('btn-submit-request', true, 'Lade hoch...');
            try {
                request.data.receipt = await uploadAll(files, personName, date);
            } catch (err) {
                alert(t('alert_upload_error', 'Fehler beim Hochladen: ') + err.message);
                return setButtonLoading('btn-submit-request', false);
            }
        }
    }
    const newReq = { id: newId(), type: request.type, userId: currentUser.uid || currentUser.id, personId, personName, data: request.data, status: 'pending', timestamp: Date.now() };
    setButtonLoading('btn-submit-request', true, 'Sende...');
    try {
        await set(ref(db, 'requests/' + newReq.id), newReq);
        closeModal('user-request-modal');
        showToast(t('toast_request_sent', 'Anfrage erfolgreich gesendet'));
        // Show the request immediately, then sync with the server
        if (!requests.some(r => r.id === newReq.id)) {
            requests.unshift(newReq);
            renderUserView();
        }
        await loadData(true);
        api('/notify-admins', 'POST', { reqType: request.type, personName }).catch(e => console.warn('Fehler beim Senden der Admin-Info über Backend', e));
    } catch (err) {
        console.error('Fehler beim Senden der Anfrage:', err);
        alert(t('alert_send_request_failed', 'Anfrage konnte nicht gesendet werden. Bitte erneut versuchen: ') + (err.message || ''));
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
    assignUserToPerson, saveEditedPayment, deleteEditReceipt, confirmDeleteRecordedPayment, approveRequest, rejectRequest, toggleDetails,
    showTransactionDetails, viewRequestReceipt, openExportReportModal, toggleManualTransactionSelection, onReportTypeChange, updateReportPreview,
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
const MAX_AI_CHAT_INPUT_HEIGHT = 120;

function createEl(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
}

function clearAiChat() {
    aiMessages = [];
    const messagesEl = $('ai-chat-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = `
        <div class="ai-chat-welcome">
            <div class="ai-chat-welcome-icon">
                ${svgIcon('chat', 32)}
            </div>
            <div class="ai-chat-welcome-text">KI-Assistent bereit</div>
            <div class="ai-chat-welcome-sub">${canViewFinances() ? 'Stelle Fragen zu deinen Mitgliedern, Finanzen oder Einstellungen.' : 'Stelle Fragen zur Gemeinde, Mitgliedern oder zur App-Nutzung.'}</div>
        </div>`;
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

function appendAiMessage(role, content) {
    const messagesEl = $('ai-chat-messages');
    if (!messagesEl) return null;
    messagesEl.querySelector('.ai-chat-welcome')?.remove();
    const bubble = createEl('div', `ai-chat-bubble ai-chat-bubble-${role}`);
    if (role === 'assistant') bubble.appendChild(renderMarkdown(content));
    else bubble.textContent = content;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

// Renders streamed assistant content; <think>/<thought> blocks and reasoning go into a collapsed <details>.
function finalizeAssistantBubble(bubble, rawContent, reasoningContent) {
    if (!bubble) return;
    const wasOpen = bubble.querySelector('details.ai-thinking')?.open || false;
    let inlineThinking = '';
    const mainContent = rawContent.replace(/<(?:think|thought)>([\s\S]*?)(?:<\/?(?:think|thought)>|$)/gi, (_, inner) => {
        inlineThinking += inner;
        return '';
    }).trim();
    const thinking = (reasoningContent + inlineThinking).trim();
    bubble.replaceChildren();
    if (thinking) {
        const details = createEl('details', 'ai-thinking');
        details.append(createEl('summary', 'ai-thinking-summary', 'Denkprozess anzeigen'), createEl('pre', 'ai-thinking-content', thinking));
        details.open = wasOpen;
        bubble.appendChild(details);
    }
    bubble.appendChild(renderMarkdown(mainContent));
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
    const scrollToEnd = () => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; };
    const typingEl = createEl('div', 'ai-chat-typing');
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    messagesEl?.appendChild(typingEl);
    scrollToEnd();

    let bubble = null;
    let content = '';
    let reasoning = '';
    try {
        let token;
        try {
            token = await auth.currentUser.getIdToken();
        } catch {
            throw new Error('Authentifizierung fehlgeschlagen');
        }
        const messages = sanitizeAiMessages(aiMessages);
        if (messages.length === 0) throw new Error('Keine gültige Nachricht vorhanden');
        const res = await fetch(`${API}/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ messages })
        });
        typingEl.remove();
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || errData.error || `HTTP ${res.status}`);
        }
        // Server-sent events: "data: {content, reasoning}" lines, terminated by "data: [DONE]"
        bubble = appendAiMessage('assistant', '');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines.map(l => l.trim()).filter(l => l.startsWith('data:'))) {
                const data = line.slice(5).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    content += parsed.content || '';
                    reasoning += parsed.reasoning || '';
                    finalizeAssistantBubble(bubble, content, reasoning);
                    scrollToEnd();
                } catch { /* skip malformed chunk */ }
            }
        }
        finalizeAssistantBubble(bubble, content, reasoning);
        scrollToEnd();
        const clean = sanitizeAiText(content).trim();
        if (clean) aiMessages.push({ role: 'assistant', content: clean });
    } catch (err) {
        typingEl.remove();
        console.error('KI-Chat Fehler:', err);
        const message = `Fehler: ${err.message || 'Unbekannter Fehler'}`;
        if (bubble) bubble.textContent = message;
        else bubble = appendAiMessage('assistant', message);
        bubble?.classList.add('ai-chat-bubble-error');
        // Drop the failed user message so it can be retried
        if (aiMessages[aiMessages.length - 1]?.role === 'user') aiMessages.pop();
    } finally {
        aiStreaming = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

Object.assign(window, {
    clearAiChat, sendAiMessage,
    handleAiChatInput: event => event?.target && adjustAiInputHeight(event.target),
    handleAiChatKey: chatKeyHandler(sendAiMessage, adjustAiInputHeight)
});

// --- Mentoring: anonymous, confidential 1:1 support ---
let mentoringMentors = [];
let mentoringThreads = [];
let activeMentoringThreadId = null;
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

function setCountBadge(id, count, display) {
    const badge = $(id);
    if (!badge) return;
    badge.innerText = String(count);
    badge.style.display = count > 0 ? display : 'none';
}

// Mentors see the anonymous alias of the seeker, seekers see their mentor's name.
function threadPartner(thread) {
    const isMentor = !!thread && isCurrentUser(thread.mentor);
    return {
        isMentor,
        name: isMentor ? (thread.mentee_alias || t('mentoring_partner_anonymous', 'Anonymer Suchender')) : (thread?.mentor_name || t('mentoring_partner_mentor', 'Mentor')),
        role: isMentor ? t('mentoring_role_seeker', 'Suchender (anonym)') : t('mentoring_role_mentor', 'Dein Mentor')
    };
}

function updateMentoringUnreadBadge() {
    setCountBadge('mentoring-unread-badge', mentoringThreads.reduce((sum, th) => sum + (th.unread_count > 0 ? th.unread_count : 0), 0), 'inline-block');
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
                applyBtn.innerHTML = myMentorProfile?.status === 'approved' ? t('mentoring_my_profile_btn', 'Mein Mentoren-Profil')
                    : myMentorProfile?.status === 'pending' ? t('mentoring_pending_profile_btn', '⏳ Bewerbung in Prüfung')
                    : t('mentoring_apply_btn', 'Als Mentor bewerben');
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
                setCountBadge('mentoring-pending-badge', Array.isArray(list) ? list.length : 0, 'inline-block');
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
            grid.innerHTML = gridMessage('--text-secondary', t('mentoring_load_error', 'Mentoren konnten nicht geladen werden.'));
        }
    } catch (err) {
        console.warn('Failed to load mentors:', err);
        grid.innerHTML = gridMessage('--danger', t('mentoring_network_error', 'Netzwerkfehler beim Laden der Mentoren.'));
    }
}

function mentorCapacity(m) {
    const max = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
    const active = typeof m.active_mentees === 'number' ? m.active_mentees : (typeof m.activeMentees === 'number' ? m.activeMentees : 0);
    return { max, active, isFull: m.isFull === true || (typeof m.active_mentees === 'number' && active >= max) || m.isAccepting === false };
}

function mentorCardAction(m, name, isSelf, isFull) {
    if (isSelf) return `<button type="button" class="btn btn-secondary btn-small" onclick="window.openMentorApplicationModal()">${t('mentoring_btn_edit_profile', 'Profil bearbeiten')}</button>`;
    const mentorUserId = m.user || m.user_id || m.id;
    const existing = mentoringThreads.find(th => (th.mentor === mentorUserId || th.mentor === m.user || th.mentor === m.id) && th.mentee === currentUid());
    if (existing) {
        const closed = existing.status === 'closed';
        return `
            <button type="button" class="btn btn-secondary btn-small" onclick="window.openMentoringChatDirect('${escapeHtml(existing.id)}', 'find')" title="${closed ? t('mentoring_btn_open_closed_chat', 'Abgeschlossenes Gespräch anzeigen') : t('mentoring_btn_open_chat', 'Laufendes Gespräch öffnen')}">
                ${closed ? t('mentoring_btn_open_closed_chat', '📁 Zum Gespräch') : t('mentoring_btn_open_chat', '💬 Zum Gespräch')}
            </button>`;
    }
    return `
        <button type="button" class="btn btn-mentor-primary btn-small" ${isFull ? 'disabled' : ''} onclick="window.openMentorContactModal('${escapeHtml(mentorUserId)}', '${escapeHtml(name)}')">
            ${isFull ? t('mentoring_btn_full', 'Voll belegt') : t('mentoring_btn_contact', 'Anonym kontaktieren')}
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
                <div style="font-weight: 600; font-size: 1.1rem; margin-bottom: 6px;">${t('mentoring_no_mentors_title', 'Derzeit keine Mentoren verfügbar')}</div>
                <div style="font-size: 0.9rem;">${isManager ? t('mentoring_no_mentors_desc_manager', 'Sobald Bewerbungen freigegeben wurden, erscheinen die Mentoren hier.') : t('mentoring_no_mentors_desc_user', 'Aktuell sind alle Mentoren vollständig ausgelastet oder es liegen keine freigegebenen Profile vor.')}</div>
            </div>`;
        return;
    }
    grid.innerHTML = visible.map(m => {
        const name = m.name || m.mentorName || t('mentoring_partner_mentor', 'Mentor');
        const avatarUrl = m.avatar_url || (m.user_id ? `${API}/profile/picture/${encodeURIComponent(m.user_id)}` : '');
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
                        <span class="mentor-role-badge">${t('mentoring_verified_badge', 'Geprüfter Mentor')}</span>
                    </div>
                </div>
                <div class="mentor-card-bio">${escapeHtml(m.bio || t('mentoring_no_bio', 'Keine Beschreibung vorhanden.'))}</div>
                <div class="mentor-card-footer">
                    ${isManager || isSelf ? `
                    <div class="mentor-capacity" title="${t('mentoring_capacity_title', 'Auslastung: Begleitungen')}">
                        <span>${t('mentoring_capacity_active', '👥 {active} / {max} aktiv', { active, max })}</span>
                        ${isFull ? `<span class="mentor-badge-full">${t('mentoring_badge_full', 'Ausgelastet')}</span>` : ''}
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
            ? t('mentoring_toast_existing_closed', 'Du hast bereits ein früheres Gespräch mit diesem Mentor.')
            : t('mentoring_toast_existing_active', 'Du hast bereits eine aktive Begleitung mit diesem Mentor.'), 'info');
        openMentoringChatDirect(existing.id);
        return;
    }
    setValue('mentor-contact-user-id', userId);
    const target = $('mentor-contact-target-name');
    if (target) target.innerText = t('mentor_contact_modal_subtitle', 'Anfrage an {name}', { name: mentorName });
    setValue('mentor-contact-message', '');
    openModal('mentor-contact-modal');
    setTimeout(() => $('mentor-contact-message')?.focus(), 150);
}

async function submitMentorContact(e) {
    e?.preventDefault?.();
    const mentorId = inputValue('mentor-contact-user-id');
    const message = inputValue('mentor-contact-message').trim();
    if (!mentorId) return alert(t('mentor_contact_error_no_mentor', 'Kein Mentor ausgewählt.'));
    if (!message) return alert(t('mentor_contact_error_no_msg', 'Bitte gib eine Erstnachricht für den Mentor ein.'));
    try {
        const res = await api('/mentoring/threads', 'POST', { mentor: mentorId, mentorId, message, initialMessage: message });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (data.threadId) {
                closeModal('mentor-contact-modal');
                showToast(data.error || t('mentoring_toast_existing_active', 'Bestehendes Gespräch geöffnet.'), 'info');
                openMentoringChatDirect(data.threadId);
                return;
            }
            throw new Error(data.error || data.message || t('mentoring_req_error', 'Fehler beim Erstellen der Anfrage.'));
        }
        closeModal('mentor-contact-modal');
        showToast(t('mentoring_toast_req_sent', 'Vertrauliche Anfrage erfolgreich gesendet!'), 'success');
        const threadId = data.threadId || data.thread?.id;
        if (threadId) {
            await loadMentoringThreads(true, threadId);
            openMentoringChatDirect(threadId);
        } else {
            loadMentoringThreads(true);
        }
    } catch (err) {
        alert(err.message || t('mentoring_req_error', 'Fehler beim Senden der Anfrage.'));
    }
}

function renderThreadItem(thread) {
    const { isMentor, name, role } = threadPartner(thread);
    const isClosed = thread.status === 'closed';
    const unread = thread.unread_count || 0;
    const closedLabel = t('mentoring_sub_closed', 'Gespräch beendet');
    const lastMsg = thread.last_message || (isClosed ? closedLabel : t('mentoring_no_messages_yet', 'Noch keine Nachrichten'));
    const dateStr = thread.updated ? new Date(thread.updated).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    const avatar = isMentor
        ? `<div class="mentoring-thread-avatar mentee-avatar" title="${escapeHtml(name)}">${svgIcon('shield', 20)}</div>`
        : `<div class="mentoring-thread-avatar mentor-avatar" title="${escapeHtml(name)}">
                <span class="mentoring-avatar-initials">${escapeHtml(name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'M')}</span>
                ${thread.mentor ? `<img src="${API}/profile/picture/${encodeURIComponent(thread.mentor)}" alt="${escapeHtml(name)}" class="mentoring-avatar-img" onerror="this.style.display='none'">` : ''}
            </div>`;
    return `
        <div class="mentoring-thread-item ${activeMentoringThreadId === thread.id ? 'active' : ''} ${unread > 0 ? 'unread' : 'read'}" data-thread-id="${escapeHtml(thread.id)}" onclick="window.openMentoringThread('${escapeHtml(thread.id)}')">
            <div class="mentoring-thread-avatar-wrap">
                ${avatar}
                <span class="mentoring-thread-status-dot ${isClosed ? 'closed' : 'active'}" title="${isClosed ? closedLabel : 'Aktiv'}"></span>
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
                    ${unread > 0 ? `<span class="mentoring-badge-count">${unread}</span>` : ''}
                </div>
            </div>
        </div>`;
}

async function loadMentoringThreads(shouldSelect = false, selectThreadId = null) {
    const listEl = $('mentoring-threads-list');
    if (!listEl) return;
    const generation = mentoringChatGeneration;
    try {
        const res = await api('/mentoring/threads');
        if (!res.ok) return console.warn('Failed to fetch mentoring threads, status:', res.status);
        const data = await res.json();
        mentoringThreads = Array.isArray(data) ? data : [];
        updateMentoringUnreadBadge();
        setCountBadge('mentoring-threads-count-badge', mentoringThreads.length, 'inline-flex');
        if (mentoringThreads.length === 0) {
            listEl.innerHTML = `
                <div class="mentoring-threads-empty">
                    <div class="mentoring-empty-icon">💬</div>
                    <div class="mentoring-empty-title">${t('mentoring_no_threads_title', 'Keine aktiven Begleitungen')}</div>
                    <div class="mentoring-empty-desc">${t('mentoring_no_threads_desc', 'Kontaktiere einen Mentor, um ein vertrauliches Gespräch zu beginnen.')}</div>
                    <button class="btn btn-secondary btn-small" onclick="window.switchMentoringSubTab('find')">${t('mentoring_tab_find', 'Mentoren finden')}</button>
                </div>`;
            return;
        }
        listEl.innerHTML = mentoringThreads.map(renderThreadItem).join('');
        const search = inputValue('mentoring-threads-search-input');
        if (search) filterMentoringThreads(search);
        if (generation !== mentoringChatGeneration) return;
        if (selectThreadId) {
            await openMentoringThread(selectThreadId);
        } else if (shouldSelect || (!isMobile() && !activeMentoringThreadId)) {
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
        subEl.innerText = isClosed ? t('mentoring_sub_closed', 'Gespräch beendet')
            : isMentor ? t('mentoring_sub_active_seeker', 'Vertraulich & Anonym') : t('mentoring_sub_active_mentee', 'Dein vertraulicher Mentor');
    }
    show('mentoring-chat-menu-dropdown', false);
    if ($('mentoring-chat-actions')) {
        show('mentoring-chat-actions', true, 'flex');
        show('mentoring-chat-menu-btn', !isClosed, 'inline-flex');
    }
    show('mentoring-chat-input-container', !isClosed, 'block');
    show('mentoring-chat-closed-bar', isClosed, 'flex');

    await loadMentoringMessages(threadId);
    autoResizeMentoringInput($('mentoring-chat-input'));
    clearInterval(mentoringChatPollTimer);
    mentoringChatPollTimer = setInterval(() => {
        if (activeMentoringThreadId === threadId && currentActiveTab === 'mentoring' && currentMentoringSubTab === 'chats') loadMentoringMessages(threadId, true);
    }, 3500);
}

// fromHistory: the chat's history entry is already gone (back gesture or tab switch).
// userBack: the user left the chat (button or gesture), so a chat opened from the start page returns there.
function closeMentoringChatMobile(fromHistory = false, userBack = !fromHistory) {
    mentoringChatGeneration++;
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
    if (steps > 0) {
        programmaticBacks++;
        history.go(-steps);
    }
    if (returnHome) switchTab(HOME_TAB, 'history');
    else loadMentoringThreads(false);
}

async function loadMentoringMessages(threadId, isPoll = false) {
    const messagesEl = $('mentoring-chat-messages');
    if (!messagesEl) return;
    try {
        const res = await api(`/mentoring/threads/${threadId}/messages`);
        if (!res.ok) {
            if (res.status === 403) messagesEl.innerHTML = `<div style="text-align:center; color:var(--danger); margin:auto; padding:20px;">${t('mentoring_access_denied', 'Zugriff verweigert (Geschützte Verbindung).')}</div>`;
            return;
        }
        let messages = await res.json();
        if (Array.isArray(messages?.messages)) messages = messages.messages;
        if (!Array.isArray(messages)) return;

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
                    <div style="font-weight:600; margin-bottom:4px;">${t('mentoring_no_messages_yet', 'Noch keine Nachrichten')}</div>
                    <div style="font-size:0.85rem; color:var(--text-secondary);">${t('mentoring_start_conversation_desc', 'Beginne das Gespräch! Alles was du schreibst, ist absolut vertraulich.')}</div>
                </div>`;
            return;
        }
        messagesEl.innerHTML = messages.map(m => {
            const isMe = isCurrentUser(m.sender);
            const time = m.created ? new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            return `
                <div class="mentoring-message ${isMe ? 'outgoing msg-mine' : 'incoming msg-other'}">
                    ${!isMe ? `<div class="mentoring-message-sender">${escapeHtml(m.sender_name || t('mentoring_partner_mentor', 'Gesprächspartner'))}</div>` : ''}
                    <div class="mentoring-message-bubble">${escapeHtml(m.message || m.text || '')}</div>
                    <div class="mentoring-message-time">${escapeHtml(time)}</div>
                </div>`;
        }).join('');
        if (!isPoll || wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
        console.warn('Failed to load messages:', err);
    }
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
        <div class="mentoring-message-time">${escapeHtml(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))} • ${t('mentoring_sending_optimistic', 'Wird gesendet…')}</div>`;
    messagesEl.appendChild(pending);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    input.value = '';
    autoResizeMentoringInput(input);
    try {
        await apiJson(`/mentoring/threads/${activeMentoringThreadId}/messages`, 'POST', { message: text, text }, t('mentoring_send_error', 'Fehler beim Senden.'));
        await loadMentoringMessages(activeMentoringThreadId);
        loadMentoringThreads(false);
    } catch (err) {
        const time = pending.querySelector('.mentoring-message-time');
        if (time) time.innerHTML = `<span style="color:#ef4444;">${t('mentoring_send_error', '⚠️ Fehler beim Senden')}</span>`;
        alert(err.message || t('mentoring_send_error', 'Nachricht konnte nicht gesendet werden.'));
    }
}

function toggleMentoringChatMenu(e) {
    e?.stopPropagation();
    e?.preventDefault();
    const dropdown = $('mentoring-chat-menu-dropdown');
    if (dropdown) dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
}

async function toggleCloseCurrentThread(forcedStatus) {
    const thread = activeMentoringThreadId && mentoringThreads.find(th => th.id === activeMentoringThreadId);
    if (!thread) return;
    show('mentoring-chat-menu-dropdown', false);
    const newStatus = forcedStatus || (thread.status === 'closed' ? 'active' : 'closed');
    if (!confirmAction(newStatus === 'closed'
        ? t('mentoring_confirm_close', 'Möchtest du diese Begleitung wirklich abschließen? Beide Seiten können keine neuen Nachrichten mehr schreiben, bis sie wiedereröffnet wird.')
        : t('mentoring_confirm_reopen', 'Möchtest du diese Begleitung wiedereröffnen?'))) return;
    try {
        await apiJson(`/mentoring/threads/${activeMentoringThreadId}/status`, 'PATCH', { status: newStatus }, t('mentoring_status_error', 'Fehler beim Ändern des Status.'));
        thread.status = newStatus;
        openMentoringThread(activeMentoringThreadId);
        loadMentoringThreads();
        showToast(newStatus === 'closed' ? t('mentoring_toast_closed', 'Gespräch beendet.') : t('mentoring_toast_reopened', 'Gespräch wiedereröffnet.'), 'info');
    } catch (err) {
        alert(err.message || t('mentoring_status_error', 'Fehler beim Aktualisieren.'));
    }
}

function openMentorApplicationModal() {
    setValue('mentor-app-bio', myMentorProfile ? myMentorProfile.bio || '' : '');
    setValue('mentor-app-max', myMentorProfile ? myMentorProfile.max_mentees || 3 : 3);
    const submitBtn = $('btn-submit-mentor-app');
    if (submitBtn) submitBtn.innerText = myMentorProfile ? t('mentor_app_btn_update', 'Profil aktualisieren') : t('mentor_app_btn_submit', 'Bewerbung absenden');
    openModal('mentor-application-modal');
}

async function submitMentorApplication(e) {
    e?.preventDefault?.();
    const bio = inputValue('mentor-app-bio').trim();
    const max_mentees = $('mentor-app-max') ? parseInt(inputValue('mentor-app-max'), 10) : 3;
    if (!bio) return alert(t('mentor_app_error_no_bio', 'Bitte gib eine persönliche Vorstellung ein, was du über dich sagst und dich beschreibt.'));
    const isUpdate = !!myMentorProfile;
    try {
        const data = await apiJson(isUpdate ? '/mentoring/my-profile' : '/mentoring/apply', isUpdate ? 'PUT' : 'POST', { bio, max_mentees }, t('mentor_app_error_generic', 'Fehler beim Einreichen der Bewerbung.'));
        myMentorProfile = data.mentor || myMentorProfile;
        closeModal('mentor-application-modal');
        showToast(isUpdate ? t('mentor_app_toast_updated', 'Mentoren-Profil aktualisiert!') : t('mentor_app_toast_submitted', 'Bewerbung erfolgreich eingereicht! Die Leitung wird sie prüfen.'), 'success');
        loadMentoringData();
    } catch (err) {
        alert(err.message || t('mentor_app_error_generic', 'Fehler bei der Bewerbung.'));
    }
}

const MENTOR_STATUS_STYLES = {
    pending: ['rgba(234, 179, 8, 0.15)', '#eab308', 'mentoring_filter_pending', 'Ausstehend'],
    approved: ['rgba(16, 185, 129, 0.15)', '#10b981', 'mentoring_filter_approved', 'Freigegeben'],
    rejected: ['rgba(239, 68, 68, 0.15)', '#ef4444', 'mentoring_filter_rejected', 'Abgelehnt']
};

async function loadMentoringReviewList() {
    const listEl = $('mentoring-review-list');
    if (!canManageMentoring() || !listEl) return;
    const statusFilter = $('mentor-review-filter') ? inputValue('mentor-review-filter') : 'pending';
    const notice = (color, text, padding = 20) => `<div style="text-align:center; padding:${padding}px; color:var(${color});">${text}</div>`;
    listEl.innerHTML = notice('--text-secondary', t('mentoring_review_loading', 'Lade Bewerbungen...'));
    try {
        const res = await api(`/mentoring/mentors?status=${encodeURIComponent(statusFilter)}`);
        if (!res.ok) {
            listEl.innerHTML = notice('--danger', t('mentoring_review_load_error', 'Fehler beim Laden der Bewerbungen.'));
            return;
        }
        const mentors = await res.json();
        if (!Array.isArray(mentors) || mentors.length === 0) {
            listEl.innerHTML = notice('--text-secondary', t('mentoring_review_none', 'Keine Bewerbungen mit Status "{status}" vorhanden.', { status: t(`mentoring_filter_${statusFilter}`, statusFilter) }), 30);
            return;
        }
        listEl.innerHTML = mentors.map(m => {
            const status = m.status || 'pending';
            const [bg, color, labelKey, labelFallback] = MENTOR_STATUS_STYLES[status] || MENTOR_STATUS_STYLES.pending;
            const email = escapeHtml(m.email || m.userEmail || '');
            const dateStr = m.created ? new Date(m.created).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            const statusButton = (target, cls, style, key, fallback) => status === target ? '' : `
                <button type="button" class="btn ${cls} btn-small"${style} onclick="window.setMentorStatus('${escapeHtml(m.id)}', '${target}')">
                    ${t(key, fallback)}
                </button>`;
            return `
                <div class="card" style="margin-bottom:12px; border:1px solid var(--border); padding:16px; border-radius:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
                        <div>
                            <div style="font-weight:700; font-size:1.05rem; display:flex; align-items:center; gap:8px;">
                                <span>${escapeHtml(m.name || m.mentorName || t('mentoring_applicant_fallback', 'Bewerber'))}</span>
                                <span style="font-size:0.75rem; padding:2px 8px; border-radius:999px; background:${bg}; color:${color}; font-weight:700;">
                                    ${t(labelKey, labelFallback)}
                                </span>
                            </div>
                            <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
                                ${email ? `${email} • ` : ''}${t('mentoring_review_submitted', 'Eingereicht: {date} • Kapazität: max. {max} Mentees', { date: dateStr, max: m.max_mentees || 3 })}
                            </div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            ${statusButton('approved', 'btn-primary', '', 'mentoring_btn_approve', '✓ Genehmigen')}
                            ${statusButton('rejected', 'btn-secondary', ' style="color:var(--danger);"', 'mentoring_btn_reject', '✗ Ablehnen')}
                        </div>
                    </div>
                    <div style="background:var(--surface-alt); padding:12px 14px; border-radius:8px; font-size:0.92rem; line-height:1.5;">
                        <div style="font-weight: 600; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${t('mentoring_review_bio_label', 'Über sich / Selbstbeschreibung:')}</div>
                        ${escapeHtml(m.bio || t('mentoring_no_bio', 'Keine Personenbeschreibung hinterlegt.'))}
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        console.warn('Failed to load review list:', err);
    }
}

async function setMentorStatus(mentorId, status) {
    const action = status === 'approved' ? t('mentoring_action_approve', 'genehmigen') : t('mentoring_action_reject', 'ablehnen');
    if (!confirmAction(t('mentoring_confirm_status', 'Möchtest du diese Bewerbung wirklich {action}?', { action }))) return;
    try {
        await apiJson(`/mentoring/manage/${mentorId}/status`, 'POST', { status }, t('mentoring_status_error', 'Status konnte nicht geändert werden.'));
        showToast(status === 'approved' ? t('mentoring_toast_approved', 'Bewerbung erfolgreich freigegeben!') : t('mentoring_toast_rejected', 'Bewerbung erfolgreich abgelehnt!'), 'success');
        loadMentoringReviewList();
        loadMentoringData();
    } catch (err) {
        alert(err.message || t('mentoring_status_error', 'Fehler beim Aktualisieren.'));
    }
}

// Home screen teaser for the newest unread conversation (hidden when everything is read)
function renderHomeMentoringCard() {
    const container = $('user-mentoring-home-card');
    if (!container) return;
    const unread = currentUser && canUseMentoring() ? mentoringThreads.filter(th => (th.unread_count || 0) > 0) : [];
    container.style.display = unread.length ? 'block' : 'none';
    if (unread.length === 0) {
        container.innerHTML = '';
        return;
    }
    const thread = unread[0];
    const { name, role } = threadPartner(thread);
    const time = thread.updated ? new Date(thread.updated).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    container.innerHTML = `
        <div class="home-mentoring-card home-mentoring-card-unread" onclick="window.openMentoringChatDirect('${escapeHtml(thread.id)}', 'home')" role="button" tabindex="0">
            <div class="home-mentoring-top-row">
                <div class="home-mentoring-sender-info">
                    <span class="home-mentoring-pulse-dot"></span>
                    <span class="home-mentoring-sender-name">${escapeHtml(name)}</span>
                    <span class="home-mentoring-role-pill">${escapeHtml(role)}</span>
                </div>
                ${time ? `<span class="home-mentoring-time">${escapeHtml(time)}</span>` : ''}
            </div>
            <div class="home-mentoring-snippet-box">
                <div class="home-mentoring-snippet">"${escapeHtml(thread.last_message || t('mentoring_start_conversation_desc', 'Neue vertrauliche Nachricht'))}"</div>
                <div class="home-mentoring-arrow" aria-hidden="true">
                    ${svgIcon('chevronRight', 18, 2.5)}
                </div>
            </div>
            ${unread.length > 1 ? `
            <div class="home-mentoring-extra-bar">
                <span>+${unread.length - 1} ${t('home_mentoring_more_unread', 'weitere ungelesene Unterhaltungen')}</span>
            </div>` : ''}
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
    sendMentoringMessage, toggleMentoringChatMenu, toggleCloseCurrentThread, openMentorApplicationModal, submitMentorApplication,
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

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
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

const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function eventDateParts(dateStr) {
    if (!dateStr) return { dayNum: '--', weekdayStr: '', monthStr: '' };
    const [y, m, d] = splitDate(dateStr);
    return { dayNum: String(d), weekdayStr: WEEKDAY_SHORT[new Date(y, m - 1, d).getDay()] || '', monthStr: MONTH_SHORT[m - 1] || '' };
}

// "17.–19. Okt." / "30. Sep. – 2. Okt." for list cards (the year is in the month header)
function formatEventDateSpanShort(startDate, endDate) {
    const [, m1, d1] = splitDate(startDate);
    const [, m2, d2] = splitDate(endDate);
    const month = m => `${MONTH_SHORT[m - 1]}.`;
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
    return `${WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()]}, ${d}. ${MONTH_NAMES[m - 1]} ${y}`;
}

function formatEventDateSpanCompact(startDate, endDate) {
    if (!startDate) return '--';
    const months = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
    const [y1, m1, d1] = splitDate(startDate);
    if (!endDate || endDate === startDate) return `${WEEKDAY_SHORT[new Date(y1, m1 - 1, d1).getDay()]}., ${d1}. ${months[m1 - 1]} ${y1}`;
    const [y2, m2, d2] = splitDate(endDate);
    if (y1 === y2 && m1 === m2) return `${d1}. – ${d2}. ${months[m1 - 1]} ${y1}`;
    if (y1 === y2) return `${d1}. ${months[m1 - 1]} – ${d2}. ${months[m2 - 1]} ${y1}`;
    return `${d1}.${m1}.${y1} – ${d2}.${m2}.${y2}`;
}

const eventTimeRange = (ev, withUhr = true) => ev.startTime ? (ev.endTime ? `${ev.startTime} – ${ev.endTime}${withUhr ? ' Uhr' : ''}` : (withUhr ? `ab ${ev.startTime} Uhr` : ev.startTime)) : '';
const eventImage = ev => {
    const raw = ev ? (ev.imageUrl || ev.image || ev.coverUrl || ev.photo || '') : '';
    return typeof raw === 'string' ? raw.trim() : '';
};
const cardIcon = name => svgIcon(name, 12, name === 'chevronRight' ? 2.5 : 2);

async function loadEventsData() {
    if (!currentUser) return;
    try {
        const [eventsRes, requestsRes] = await Promise.all([
            api('/events'),
            api('/events/my-requests').catch(() => null),
            loadSystemGroups()
        ]);
        if (eventsRes.ok) appEvents = await eventsRes.json();
        myDutyRequests = requestsRes?.ok ? await requestsRes.json() : [];
        renderMyDutyRequests();
        renderEvents();
        renderHomeDutiesCard();
    } catch (err) {
        console.warn('Failed to load events:', err);
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
                    <strong style="font-size:0.95rem; color:var(--text);">Offene Dienstanfragen an dich (${list.length})</strong>
                </div>
                <span class="events-requests-badge">Rückmeldung erbeten</span>
            </div>
            <div class="events-requests-list">
                ${list.map(req => {
                    const id = escapeHtml(req.id);
                    return `
                    <div class="events-request-card" id="${onHome ? 'home-' : ''}duty-request-${id}">
                        <div class="events-request-info"${onHome ? ` onclick="window.openEventDetailModal('${escapeHtml(req.eventId)}')" role="button" tabindex="0" style="cursor:pointer;" title="Termin-Details anzeigen"` : ''}>
                            <div class="events-request-event-title">📅 ${escapeHtml(req.eventTitle || 'Event')}</div>
                            <div class="events-request-event-sub">
                                <span>${escapeHtml(formatEventDate(req.eventDate))}${req.eventStartTime ? ` um ${escapeHtml(req.eventStartTime)} Uhr` : ''}</span>
                            </div>
                            <div class="events-request-role">
                                🛠️ <strong>${escapeHtml(req.roleName)}</strong>
                                <span style="color:var(--text-secondary); font-size:0.8rem;">(${req.section ? `Bereich: ${escapeHtml(req.section)} • ` : ''}Angefragt von ${escapeHtml(req.requestedByName || 'Team')})</span>
                            </div>
                        </div>
                        <div class="events-request-actions">
                            <button type="button" class="btn btn-success btn-small" onclick="${stop}window.respondToDutyRequest('${id}', 'accept')">
                                ✅ Zusagen
                            </button>
                            <button type="button" class="btn btn-ghost btn-small text-danger" onclick="${stop}window.respondToDutyRequest('${id}', 'decline')">
                                ❌ Ablehnen
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
    container.style.display = openRequests.length || dutyEvents.length ? 'block' : 'none';
    container.innerHTML = (openRequests.length ? `<div class="events-requests-banner" style="margin-bottom: 20px;">${dutyRequestBanner(openRequests, true)}</div>` : '')
        + (dutyEvents.length ? `
            <div class="home-duties-freestanding-wrap" style="margin-top: 16px;">
                <h2 class="home-duties-freestanding-title">Deine Dienste</h2>
                <div class="events-feed-list">
                    ${dutyEvents.map(ev => renderEventCard(ev, 'home-duty-card-')).join('')}
                </div>
            </div>` : '');
}

function refreshDetailEvent(openDuties) {
    if (!currentDetailEvent) return;
    openEventDetailModal(currentDetailEvent.id);
    const details = $('detail-modal-duties-details');
    if (openDuties && details) details.open = true;
}

// Runs an event API call, reports the outcome as toast, reloads events and refreshes the open detail modal.
async function eventAction(path, method, body, { success, successType = 'success', error, useServerError = true, networkError = 'Verbindungsfehler', before, after = () => refreshDetailEvent(true) }) {
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
    success: action === 'accept' ? 'Dienst zugesagt! Du bist jetzt für dieses Event eingeteilt.' : 'Dienstanfrage abgelehnt.',
    successType: action === 'accept' ? 'success' : 'info',
    error: 'Fehler beim Antworten auf die Dienstanfrage',
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
            const hasDuty = duties.some(d => d.assignedUser === currentUser?.id || d.requestedUser === currentUser?.id);
            // Registration events only show up in "Termine" for participants; pinned highlights live on the events tab
            if (ev.requiresRegistration ? !isRegistered && !hasDuty : ev.isPinned && ev.eventType !== 'termin' && !hasDuty) return false;
        } else if (ev.eventType === 'termin' && !ev.isPinned) {
            return false;
        }
        return !eventsSearchQuery || matches(ev.title) || matches(ev.location) || matches(ev.description)
            || duties.some(d => matches(d.roleName) || matches(d.assignedGroupName) || matches(d.assignedUserName));
    });
}

function renderEvents() {
    const container = $('events-list-container');
    if (!container) return;
    const todayStr = getTodayStr();
    const isEventsTab = currentEventsSubTab === 'events';
    const filtered = getFilteredEvents(todayStr);
    const upcoming = isEventsTab ? filtered.filter(ev => !isEventPast(ev, todayStr)) : filtered;
    const past = isEventsTab ? filtered.filter(ev => isEventPast(ev, todayStr)) : [];
    const listClass = isEventsTab ? 'events-cards-grid' : 'events-feed-list';

    past.sort((a, b) => (b.endDate || b.date || '').localeCompare(a.endDate || a.date || '') || (b.startTime || '').localeCompare(a.startTime || ''));
    const pastSection = past.length === 0 ? '' : `
        <div class="events-past-toggle-wrap">
            <button type="button" class="events-past-toggle-btn" onclick="window.toggleShowPastEvents()">
                <span style="font-size: 0.72rem;">${showPastEvents ? '▲' : '▼'}</span>
                <span>Abgelaufene Events ${showPastEvents ? 'verbergen' : 'anzeigen'} (${past.length})</span>
            </button>
            ${showPastEvents ? `
                <div style="width: 100%; margin-top: 22px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 0 4px;">
                        <span style="font-size: 0.84rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">
                            Abgelaufene Events (${past.length})
                        </span>
                        <span style="font-size: 0.76rem; color: var(--text-secondary);">Versteckt bis zur manuellen Löschung</span>
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
                <div style="font-weight: 700; font-size: 1.05rem; color: var(--text); margin-bottom: 4px;">${isEventsTab ? 'Keine anstehenden Events gefunden' : 'Keine passenden Termine gefunden'}</div>
                <div style="font-size: 0.88rem; margin-bottom: 14px;">Versuche die Filter zurückzusetzen oder erstelle einen neuen Eintrag.</div>
                <div>
                    <button type="button" class="btn btn-primary btn-small" onclick="window.openNewEventDetailModal('${isEventsTab ? 'event' : 'termin'}')">${isEventsTab ? '+ Neues Event' : '+ Neuer Termin'}</button>
                </div>
            </div>
            ${pastSection}`;
        return;
    }

    // Pinned highlights first, then chronologically
    upcoming.sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)) || (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
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
    const byMonth = (list, render) => [...groupBy(list, ev => (ev.date ? ev.date.substring(0, 7) : 'Ohne Datum'))].map(([key, items]) => {
        const [y, m] = key.split('-').map(Number);
        return group(escapeHtml(key.includes('-') ? `${MONTH_NAMES[m - 1]} ${y}` : key), items, render);
    }).join('');
    const ctCard = ev => renderChurchtoolsEventCard(ev, false);
    const pinned = upcoming.filter(ev => ev.isPinned);
    container.innerHTML = (isEventsTab
        ? (pinned.length ? group('Highlights', pinned, ctCard, ' events-highlights-group') : '') + byMonth(upcoming.filter(ev => !ev.isPinned), ctCard)
        : byMonth(upcoming, ev => renderEventCard(ev))) + pastSection;
}

const statusBadge = (cls, content, title = '') => `<span class="event-card-status ${cls}"${title ? ` title="${title}"` : ''}>${content}</span>`;

// Large cover card used on the events tab
function renderChurchtoolsEventCard(ev, forcePast = false) {
    const isPast = forcePast || isEventPast(ev);
    const isPinned = Boolean(ev.isPinned);
    const isMultiDay = ev.endDate && ev.endDate !== ev.date;
    const timeDisplay = !isMultiDay ? eventTimeRange(ev) : '';
    const { myDuty, myRequestedDuty, isWaitlist } = getEventCardStatusInfo(ev);
    const status = isPast ? statusBadge('status-past', '⌛ Vorbei')
        : myDuty ? statusBadge('status-duty', `${cardIcon('user')}<span>${escapeHtml(myDuty.roleName || 'Dienst')}</span>`)
        : myRequestedDuty ? statusBadge('status-requested', `${cardIcon('clock')}<span>Anfrage offen</span>`)
        : isWaitlist ? statusBadge('status-waitlist', '<span>Warteliste</span>')
        : ev.requiresRegistration && ev.isFull && !ev.myRegistration ? statusBadge('status-full', '<span>Ausgebucht</span>') : '';
    const regCount = ev.registeredCount || 0;
    const max = ev.maxParticipants || 0;
    const footerBadges = !ev.requiresRegistration ? '<span class="ct-footer-pill-muted">Ohne Anmeldung</span>'
        : max > 0 ? `
            <div class="ct-capacity-wrap" title="${regCount} von ${max} Plätzen belegt">
                <span class="ct-capacity-text">${regCount}/${max} Plätze</span>
                <div class="ct-capacity-track"><div class="ct-capacity-bar" style="width:${Math.min(100, Math.round((regCount / max) * 100))}%;"></div></div>
            </div>` : `<span class="ct-footer-pill">${regCount} angemeldet</span>`;
    const metaRow = (icon, text, extra = '') => `<div class="ct-event-card-meta-row${extra}">${cardIcon(icon)}<span>${escapeHtml(text)}</span></div>`;
    return `
        <div class="churchtools-event-card ${isPinned ? 'is-pinned' : ''} ${isPast ? 'is-past' : ''}" id="event-card-${escapeHtml(ev.id)}" onclick="window.openEventDetailModal('${escapeHtml(ev.id)}')">
            <div class="ct-event-card-cover-wrap">
                ${ev.imageUrl
                    ? `<img class="ct-event-card-cover-img" src="${escapeHtml(ev.imageUrl)}" alt="${escapeHtml(ev.title)}" loading="lazy">`
                    : `<div class="ct-event-card-fallback-cover"><div class="ct-fallback-icon-wrap">${cardIcon('calendar')}</div></div>`}
                ${eventCalendarLeaf(ev.date, `ct-event-card-date-badge ${isPinned ? 'cat-pinned' : 'cat-event'}`)}
                <div class="ct-event-card-badges-floating"><span class="event-card-top-label ${isPinned ? 'label-pinned' : 'label-event'}">${isPinned ? 'Großevent' : 'Event'}</span>${status}</div>
            </div>
            <div class="ct-event-card-body">
                <div class="ct-event-card-title">${escapeHtml(ev.title)}</div>
                <div class="ct-event-card-meta">
                    ${isMultiDay ? metaRow('calendar', formatEventDateSpanShort(ev.date, ev.endDate), ' multiday-row') : ''}
                    ${timeDisplay ? metaRow('clock', timeDisplay) : ''}
                    ${ev.location ? metaRow('location', ev.location) : ''}
                </div>
                <div class="ct-event-card-footer">
                    <div>${footerBadges}</div>
                    <div class="ct-details-btn"><span>Details</span>${cardIcon('chevronRight')}</div>
                </div>
            </div>
        </div>`;
}

// Compact list card used for appointments and on the home screen: calendar leaf, title, one "when" line,
// location and at most one status badge; the category colour shows as leaf strip and left accent
function renderEventCard(ev, idPrefix = 'event-card-') {
    const timeDisplay = eventTimeRange(ev);
    const todayStr = getTodayStr();
    const isToday = ev.date === todayStr;
    const isPast = ev.date && ev.date < todayStr;
    const isMultiDay = ev.endDate && ev.endDate !== ev.date;
    const isEvent = ev.eventType ? ev.eventType === 'event' : !ev.isOfficialTermin;
    const isPinned = isEvent && Boolean(ev.isPinned);
    const { myDuty, myRequestedDuty, isRegistered, isWaitlist, openDutiesCount } = getEventCardStatusInfo(ev);
    let status = '';
    if (myDuty) {
        const viaGroup = myDuty.assignedGroup && userInGroup(currentUser, myDuty.assignedGroup) && !isCurrentUser(myDuty.assignedUser);
        const label = viaGroup ? (myDuty.assignedGroupName || myDuty.assignedGroup || myDuty.roleName || 'Dienst') : (myDuty.roleName || 'Dienst');
        status = statusBadge('status-duty', `${cardIcon('user')}<span>${escapeHtml(label)}</span>`, 'Eingeteilter Dienst');
    } else if (myRequestedDuty) {
        status = statusBadge('status-requested', `${cardIcon('clock')}<span>Anfrage offen</span>`, 'Dienstanfrage offen');
    } else if (isWaitlist) {
        status = statusBadge('status-waitlist', `${cardIcon('alert')}<span>Warteliste</span>`, 'Auf der Warteliste');
    } else if (!isRegistered && openDutiesCount > 0 && ev.canAccessDutyPlan) {
        status = statusBadge('status-open-duties', `<span>${openDutiesCount} ${openDutiesCount === 1 ? 'Dienst frei' : 'Dienste frei'}</span>`, `${openDutiesCount} offene Dienste`);
    } else if (!isRegistered && ev.requiresRegistration && ev.isFull) {
        status = statusBadge('status-full', '<span>Ausgebucht</span>');
    }
    const when = isMultiDay ? formatEventDateSpanShort(ev.date, ev.endDate) : (timeDisplay || 'Ganztägig');
    const category = isPinned ? 'cat-pinned' : isEvent ? 'cat-event' : 'cat-termin';
    const categoryLabel = isPinned ? 'Großevent' : isEvent ? 'Event' : 'Termin';
    return `
        <div class="event-card ${category} ${isPast ? 'is-past' : ''} ${isToday ? 'is-today' : ''}" id="${idPrefix}${escapeHtml(ev.id)}" title="${categoryLabel}" onclick="window.openEventDetailModal('${escapeHtml(ev.id)}')">
            ${eventCalendarLeaf(ev.date)}
            <div class="event-card-body">
                <div class="event-card-title">${escapeHtml(ev.title)}</div>
                <div class="event-card-when">
                    ${isToday ? '<span class="event-card-today">Heute</span>' : ''}
                    ${cardIcon(isMultiDay ? 'calendar' : 'clock')}<span>${escapeHtml(when)}</span>
                </div>
                ${ev.location ? `<div class="event-card-where">${cardIcon('location')}<span>${escapeHtml(ev.location)}</span></div>` : ''}
            </div>
            <div class="event-card-right">
                ${status}
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

function setDescriptionToggle(expanded) {
    setText('detail-desc-toggle-text', expanded ? 'Weniger anzeigen' : 'Mehr anzeigen');
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

// Registration card: "1 von 2 Plätzen belegt · 1 frei", capacity bar, then my status or the register button
function renderRegistrationSection(ev) {
    const status = ev.myRegistration?.status;
    const max = ev.maxParticipants || 0;
    const count = ev.registeredCount || 0;
    const min = ev.minParticipants || 0;
    const free = Math.max(0, max - count);
    const meta = [
        max > 0 ? `${count} von ${max} Plätzen belegt` : `${count} angemeldet`,
        max > 0 ? (free > 0 ? `${free} frei` : 'ausgebucht') : '',
        min > 0 ? `mind. ${min}` : ''
    ].filter(Boolean).join(' · ');
    setText('detail-modal-reg-meta', meta);
    const capacity = $('detail-modal-capacity-info');
    if (capacity) {
        capacity.style.display = max > 0 ? 'block' : 'none';
        capacity.classList.toggle('is-full', max > 0 && free === 0);
        capacity.querySelector('.event-progress-bar').style.width = `${max > 0 ? Math.min(100, Math.round((count / max) * 100)) : 0}%`;
    }
    const toggle = current => `window.toggleEventRegistration('${ev.id}', '${current}')`;
    const banner = (cls, icon, title, sub, action = '') => `
        <div class="event-reg-status ${cls}">
            <span class="event-reg-status-icon">${svgIcon(icon, 16, 2.5)}</span>
            <div class="event-reg-status-text"><strong>${title}</strong>${sub ? `<span>${sub}</span>` : ''}</div>
            ${action}
        </div>`;
    const leave = (current, label) => `<button type="button" class="event-reg-status-action" onclick="${toggle(current)}">${label}</button>`;
    $('detail-modal-reg-action-wrap').innerHTML = isEventPast(ev)
        ? banner('is-past', status === 'registered' ? 'check' : 'clock', status === 'registered' ? 'Du warst angemeldet' : 'Die Anmeldung ist beendet', 'Das Event ist vorbei.')
        : status === 'registered' ? banner('is-registered', 'check', 'Du bist angemeldet', 'Wir freuen uns auf dich!', leave('registered', 'Abmelden'))
        : status === 'waitlist' ? banner('is-waitlist', 'clock', 'Du stehst auf der Warteliste', 'Du rückst nach, sobald ein Platz frei wird.', leave('waitlist', 'Verlassen'))
        : ev.isFull ? `<button type="button" class="btn btn-secondary btn-block" onclick="${toggle('none')}">${svgIcon('clock', 15, 2)}<span>Auf die Warteliste setzen</span></button>`
        : `<button type="button" class="btn btn-primary btn-block" onclick="${toggle('none')}">${svgIcon('check', 15, 2.5)}<span>Verbindlich anmelden</span></button>`;
    const attendees = $('detail-modal-attendees-details');
    if (attendees) attendees.open = false;
    loadEventAttendees(ev.id);
}

async function openEventDetailModal(eventId) {
    let ev = appEvents.find(e => e.id === eventId);
    if (!ev) {
        await loadEventsData();
        ev = appEvents.find(e => e.id === eventId);
    }
    if (!ev) return;
    currentDetailEvent = ev;
    const modalBody = document.querySelector('.event-detail-body');
    if (modalBody) modalBody.scrollTop = 0;
    detailCard()?.classList.remove('detail-is-editing', 'detail-is-new');
    show('detail-edit-cover-placeholder', false);
    hideTypeSelector();
    showDetailCover(eventImage(ev), true);

    const typeIndicator = $('detail-modal-type-indicator');
    if (typeIndicator) {
        typeIndicator.innerHTML = ev.isPinned ? `${svgIcon('star', 13)}<span>Großevent & Highlight</span>` : '';
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
        else setTextWithTitle('detail-modal-info-time', eventTimeRange(ev) || 'Ganztägig');
        infoTime.style.display = isMultiDay ? 'none' : 'inline';
    }
    show('detail-modal-when-sep', !isMultiDay, 'inline');

    const location = typeof ev.location === 'string' ? ev.location.trim() : '';
    setTextWithTitle('detail-modal-info-where', location || 'Keine Angabe');
    const mapLink = $('detail-modal-map-link');
    if (mapLink) {
        const isPlace = location && !/^(online|zoom|teams|skype|meet|keine angabe)$/i.test(location);
        mapLink.href = isPlace ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}` : '#';
        mapLink.style.display = isPlace ? 'inline-flex' : 'none';
    }

    const creator = ev.createdByName?.trim() || '';
    const creatorEl = $('detail-creator-name');
    if (creatorEl) {
        creatorEl.textContent = ev.createdByName || 'Mitglied';
        creatorEl.title = creator || 'Mitglied';
    }
    show('detail-modal-organizer-pill', !!creator, 'inline-flex');

    const tags = $('detail-modal-tags');
    if (tags) {
        tags.innerHTML = Array.isArray(ev.targetGroups) ? ev.targetGroups.map(g => `<span class="event-tag event-tag-group">${escapeHtml(g)}</span>`).join(' ') : '';
        tags.style.display = tags.innerHTML ? 'flex' : 'none';
    }

    const description = ev.description?.trim();
    const descCard = $('detail-modal-desc-card');
    if (description) {
        $('detail-modal-description')?.replaceChildren(renderMarkdown(description));
        $('detail-modal-desc-wrap')?.classList.remove('is-clamped', 'is-expanded');
        show('detail-desc-toggle-btn', false);
        setDescriptionToggle(false);
    }
    descCard.style.display = description ? 'block' : 'none';

    show('detail-modal-reg-box', !!ev.requiresRegistration, 'block');
    if (ev.requiresRegistration) renderRegistrationSection(ev);

    const dutiesBox = $('detail-modal-duties-box');
    show(dutiesBox, !!ev.canAccessDutyPlan, 'block');
    if (ev.canAccessDutyPlan && dutiesBox) {
        const dutiesDetails = $('detail-modal-duties-details');
        if (dutiesDetails) dutiesDetails.open = false;
        show('detail-modal-add-duty-wrap', !!ev.canEdit, 'block');
        hideAddNewTaskForm();
        const duties = Array.isArray(ev.duties) ? ev.duties : [];
        // "2 von 3 besetzt": confirmed people and assigned groups count as filled
        const filled = duties.filter(d => d.status === 'confirmed' || (d.status === 'assigned' && (d.assignedGroup || d.assignedGroupName))).length;
        const tasks = new Set(duties.map(d => (d.roleName || 'Aufgabe').trim())).size;
        setText('detail-modal-duties-count', duties.length ? `${filled} von ${duties.length} besetzt · ${tasks} ${tasks === 1 ? 'Aufgabe' : 'Aufgaben'}` : 'Noch keine Aufgaben');
        const progress = $('detail-modal-duties-progress');
        if (progress) {
            progress.style.display = duties.length ? 'block' : 'none';
            progress.classList.toggle('is-complete', duties.length > 0 && filled === duties.length);
            progress.querySelector('.event-progress-bar').style.width = `${duties.length ? Math.round((filled / duties.length) * 100) : 0}%`;
        }
        renderGroupedDuties(duties, ev);
    }

    show('detail-btn-edit', !!ev.canEdit, 'inline-flex');
    show('detail-btn-delete', !!ev.canEdit, 'inline-flex');
    show('detail-modal-action-bar', !!ev.canEdit, 'flex');
    openModal('event-detail-modal');

    // Clamp long descriptions behind a "Mehr anzeigen" toggle
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
        setText('detail-attendees-label-text', registered.length ? 'Teilnehmer' : 'Noch niemand angemeldet');
        show('detail-attendees-count', registered.length > 0, 'inline-flex');
        // Overlapping avatar stack of the first attendees
        const stack = $('detail-attendees-stack');
        if (stack) {
            const shown = registered.slice(0, 5);
            stack.innerHTML = shown.map(att => renderAvatarWrap(att.userId, att.name, { wrapClass: 'avatar-stack-item' })).join('')
                + (registered.length > shown.length ? `<span class="avatar-stack-more">+${registered.length - shown.length}</span>` : '');
            stack.style.display = shown.length ? 'flex' : 'none';
        }
        const itemsEl = $('detail-attendees-items');
        if (!itemsEl) return;
        const canManage = currentDetailEvent && currentDetailEvent.canEdit;
        const row = (att, isWaitlist) => `
            <div class="event-attendee-row ${isWaitlist ? 'is-waitlist' : ''}">
                ${renderAvatarWrap(att.userId, att.name, { wrapClass: 'event-attendee-avatar' })}
                <span class="event-attendee-name">${escapeHtml(att.name)}</span>
                ${canManage ? `
                <button type="button" class="event-attendee-remove" onclick="window.removeEventAttendee('${eventId}', '${att.userId}')" title="${isWaitlist ? 'Von Warteliste entfernen' : 'Teilnehmer entfernen'}" aria-label="Entfernen">
                    ${svgIcon('x', 13, 2.5)}
                </button>` : ''}
            </div>`;
        itemsEl.innerHTML = registered.map(att => row(att, false)).join('')
            + (waitlist.length ? `<div class="event-attendees-sub">Warteliste · ${waitlist.length}</div>${waitlist.map(att => row(att, true)).join('')}` : '')
            || '<div class="event-attendees-empty">Sobald sich jemand anmeldet, erscheint die Person hier.</div>';
    } catch (err) {
        console.warn('Failed to load event attendees:', err);
    }
}

async function removeEventAttendee(eventId, userId) {
    if (!confirmAction('Möchtest du diesen Teilnehmer wirklich aus der Liste entfernen?')) return;
    await eventAction(`/events/${eventId}/attendees/${userId}`, 'DELETE', undefined, {
        success: 'Teilnehmer entfernt', successType: 'info', error: 'Fehler beim Entfernen des Teilnehmers', useServerError: false,
        after: () => loadEventAttendees(eventId)
    });
}

// --- Duty planner (tasks grouped by role) ---
function renderGroupedDuties(duties, ev) {
    const container = $('detail-modal-duties-sections');
    if (!container) return;
    if (!duties || duties.length === 0) {
        container.innerHTML = `<div class="duty-rows-empty">${ev.canEdit ? 'Lege Aufgaben an und frage Personen oder Gruppen dafür an.' : 'Für dieses Event sind keine Dienste eingetragen.'}</div>`;
        return;
    }
    const grouped = groupBy(duties, d => (d.roleName || 'Aufgabe').trim());
    container.innerHTML = [...grouped].map(([roleName, roleDuties]) => renderDutyTaskCard(roleName, roleDuties, ev)).join('');
}

// One compact row per task: name, people as status chips, small add/delete tools for managers
function renderDutyTaskCard(roleName, roleDuties, ev) {
    const canManage = ev.canEdit || roleDuties.some(d => d.canManageDuty);
    const encodedRoleName = encodeURIComponent(roleName);
    const assignees = roleDuties.filter(hasDutyAssignee);
    const openSlots = roleDuties.length - assignees.length;
    const chips = assignees.map(d => renderDutyAssigneeItem(d, ev)).join('')
        + (assignees.length === 0 || openSlots > 0
            ? `<button type="button" class="duty-chip is-open" ${canManage ? `onclick="window.openAssignDutyModalForRole('${encodedRoleName}')"` : 'disabled'}>${svgIcon(canManage ? 'plus' : 'user', 12, 2.5)}<span>${canManage ? 'Offen – zuweisen' : 'Offen'}</span></button>`
            : '');
    // Requests to me get the answer buttons right in the row
    const myRequest = roleDuties.find(d => d.status === 'requested' && isCurrentUser(d.requestedUser));
    const notes = roleDuties.filter(d => d.notes).map(d => `<div class="duty-row-note">${escapeHtml(d.notes)}</div>`).join('');
    return `
        <div class="duty-row">
            <div class="duty-row-head">
                <span class="duty-row-name">${escapeHtml(roleName)}</span>
                ${canManage ? `
                <div class="duty-row-tools">
                    ${assignees.length > 0 && openSlots === 0 ? `<button type="button" class="duty-tool" onclick="window.openAssignDutyModalForRole('${encodedRoleName}')" title="Person oder Gruppe hinzufügen" aria-label="Person oder Gruppe hinzufügen">${svgIcon('plus', 14, 2.5)}</button>` : ''}
                    <button type="button" class="duty-tool is-danger" onclick="window.deleteEntireDutyTask('${encodedRoleName}')" title="Aufgabe löschen" aria-label="Aufgabe löschen">${svgIcon('trash', 14)}</button>
                </div>` : ''}
            </div>
            <div class="duty-row-people">${chips}</div>
            ${myRequest ? `
            <div class="duty-row-request">
                <span>Du wurdest angefragt</span>
                <button type="button" class="btn btn-primary btn-tiny" onclick="window.respondToDutyRequest('${escapeHtml(myRequest.id)}', 'accept')">${svgIcon('check', 13, 2.5)}<span>Zusagen</span></button>
                <button type="button" class="btn btn-secondary btn-tiny" onclick="window.respondToDutyRequest('${escapeHtml(myRequest.id)}', 'decline')">Ablehnen</button>
            </div>` : ''}
            ${notes}
        </div>`;
}

// Person / group chip with its status colour (confirmed, requested, declined, group)
function renderDutyAssigneeItem(d, ev) {
    const canRemove = ev.canEdit || d.canManageDuty;
    let cls = 'is-confirmed';
    let avatar = '';
    let name = '';
    let state = '';
    if (d.status === 'assigned' && (d.assignedGroupName || d.assignedGroup)) {
        cls = 'is-group';
        avatar = `<span class="duty-chip-icon">${svgIcon('users', 12, 2.5)}</span>`;
        name = d.assignedGroupName || d.assignedGroup;
        state = 'Gruppe';
    } else if (d.status === 'requested' || d.status === 'declined') {
        cls = d.status === 'requested' ? 'is-requested' : 'is-declined';
        avatar = renderAvatarWrap(d.requestedUser, d.requestedUserName || 'P', { wrapClass: 'duty-chip-avatar' });
        name = isCurrentUser(d.requestedUser) ? 'Du' : (d.requestedUserName || 'Person');
        state = d.status === 'requested' ? 'angefragt' : 'abgelehnt';
    } else {
        avatar = renderAvatarWrap(d.assignedUser, d.assignedUserName || 'P', { wrapClass: 'duty-chip-avatar' });
        name = isCurrentUser(d.assignedUser) ? 'Du' : (d.assignedUserName || 'Eingeteilt');
        state = '';
    }
    return `
        <span class="duty-chip ${cls}" id="duty-slot-${escapeHtml(d.id)}" title="${escapeHtml(state ? `${name} · ${state}` : name)}">
            ${avatar}
            <span class="duty-chip-name">${escapeHtml(name)}</span>
            ${state ? `<span class="duty-chip-state">${state}</span>` : `<span class="duty-chip-check">${svgIcon('check', 11, 3)}</span>`}
            ${canRemove ? `<button type="button" class="duty-chip-remove" onclick="window.removeDutyAssignee('${escapeHtml(d.id)}')" title="Eintrag entfernen" aria-label="Eintrag entfernen">${svgIcon('x', 11, 2.5)}</button>` : ''}
        </span>`;
}

function setNewTaskFormVisible(visible) {
    show('detail-btn-add-duty', !visible, 'inline-flex');
    show('duty-new-task-form', visible, 'block');
    const input = $('duty-new-task-name');
    if (!input) return;
    input.value = '';
    if (visible) input.focus();
}
const hideAddNewTaskForm = () => setNewTaskFormVisible(false);

async function submitAddNewTask() {
    if (!currentDetailEvent) return;
    const input = $('duty-new-task-name');
    const roleName = input?.value?.trim();
    if (!roleName) {
        showToast('Bitte einen Namen für die Aufgabe eingeben', 'warning');
        input?.focus();
        return;
    }
    await eventAction(`/events/${currentDetailEvent.id}/duties`, 'POST', { roleName }, {
        before: hideAddNewTaskForm, success: `Aufgabe "${roleName}" hinzugefügt!`, error: 'Fehler beim Anlegen der Aufgabe'
    });
}

// --- Assign duty pop-up (persons / groups) ---
function openAssignDutyModalForRole(encodedRoleName) {
    setValue('assign-duty-role-encoded', encodedRoleName);
    setValue('assign-duty-replace-id', '');
    setText('subtitle-assign-duty', `Aufgabe: ${decodeURIComponent(encodedRoleName)}`);
    setValue('assign-duty-search-input', '');
    switchAssignDutyTab('user');
    openModal('assign-duty-modal');
}

function switchAssignDutyTab(type) {
    setValue('assign-duty-active-tab', type);
    $('assign-tab-user')?.classList.toggle('is-active', type === 'user');
    $('assign-tab-group')?.classList.toggle('is-active', type === 'group');
    const search = $('assign-duty-search-input');
    if (search) search.placeholder = type === 'user' ? 'Person suchen...' : 'Gruppe suchen...';
    renderAssignDutyModalList(search ? search.value : '');
}

const pickerOption = ({ name, subtitle, badgeHtml, btnText, btnClass, onclick }) => `
    <div class="duty-picker-option" onclick="${onclick}">
        <div class="duty-picker-option-left">
            ${badgeHtml}
            <div class="duty-picker-option-info">
                <span class="duty-picker-option-name">${escapeHtml(name || '')}</span>
                ${subtitle ? `<span class="duty-picker-option-sub">${escapeHtml(subtitle)}</span>` : ''}
            </div>
        </div>
        <button type="button" class="btn ${btnClass} duty-picker-btn-action">${escapeHtml(btnText)}</button>
    </div>`;

async function renderAssignDutyModalList(filterText = '') {
    const listEl = $('assign-duty-popup-list');
    if (!listEl) return;
    const isUserTab = (inputValue('assign-duty-active-tab') || 'user') === 'user';
    const term = (filterText || '').trim().toLowerCase();
    const matches = text => !term || (text || '').toLowerCase().includes(term);
    const notice = text => `<div style="padding: 14px; font-size: 0.8rem; color: var(--text-secondary); text-align: center;">${text}</div>`;
    listEl.innerHTML = notice('Wird geladen...');
    await loadEventCandidates();
    if (isUserTab) {
        const matched = (Array.isArray(eventCandidatesCache) ? eventCandidatesCache : []).filter(c => matches(c.name) || (term && matches(c.email)));
        listEl.innerHTML = matched.length === 0 ? notice('Keine passende Person gefunden.') : matched.map(c => {
            const name = c.name || c.email || 'Mitglied';
            return pickerOption({
                name,
                subtitle: c.email || '',
                badgeHtml: renderAvatarWrap(c.id, name, { style: 'width: 36px; height: 36px; font-size: 0.8rem;' }),
                btnText: 'Anfragen',
                btnClass: 'btn-primary',
                onclick: `window.selectDutyAssignee({ targetUserId: '${escapeHtml(c.id)}', sendEmail: true })`
            });
        }).join('');
    } else {
        const groups = Array.isArray(eventGroupsCache) && eventGroupsCache.length > 0 ? eventGroupsCache : groupList();
        const matched = groups.filter(g => matches(g.name || g.id));
        listEl.innerHTML = matched.length === 0 ? notice('Keine passende Gruppe gefunden.') : matched.map(g => pickerOption({
            name: g.name || g.id,
            subtitle: 'Gruppe fest einteilen',
            badgeHtml: '<div class="duty-assignee-group-badge" style="width: 34px; height: 34px; font-size: 0.95rem;">👥</div>',
            btnText: 'Zuweisen',
            btnClass: 'btn-secondary',
            onclick: `window.selectDutyAssignee({ targetGroupId: '${escapeHtml(g.id || g.name || g.id)}' })`
        })).join('');
    }
}

function selectDutyAssignee(assignData) {
    const encodedRoleName = inputValue('assign-duty-role-encoded');
    const replaceDutyId = inputValue('assign-duty-replace-id');
    closeModal('assign-duty-modal');
    if (currentDetailEvent && encodedRoleName) assignToDutyRole(currentDetailEvent.id, encodedRoleName, assignData, replaceDutyId);
}

async function assignToDutyRole(eventId, encodedRoleName, assignData, replaceDutyId = '') {
    if (!eventId) return;
    const roleName = decodeURIComponent(encodedRoleName);
    // Fill an existing open slot of this task before creating a new one
    const slotId = replaceDutyId || (Array.isArray(currentDetailEvent?.duties) ? currentDetailEvent.duties.find(d => (d.roleName || '').trim() === roleName.trim() && d.status === 'open')?.id : null);
    await eventAction(slotId ? `/events/duties/${slotId}/assign` : `/events/${eventId}/duties`, 'POST', slotId ? { ...assignData, sendEmail: true } : { roleName, ...assignData, sendEmail: true }, {
        success: assignData.targetGroupId ? 'Gruppe erfolgreich eingeteilt!' : 'Dienstanfrage versendet & E-Mail übermittelt!',
        error: 'Fehler beim Zuweisen'
    });
}

async function deleteEntireDutyTask(encodedRoleName) {
    if (!currentDetailEvent) return;
    const roleName = decodeURIComponent(encodedRoleName);
    if (!confirmAction(`Möchtest du die gesamte Aufgabe "${roleName}" mit allen Einträgen wirklich löschen?`)) return;
    try {
        const duties = (currentDetailEvent.duties || []).filter(d => (d.roleName || '').trim() === roleName.trim());
        if (duties.length === 0) return;
        await Promise.all(duties.map(d => api(`/events/duties/${d.id}`, 'DELETE')));
        showToast(`Aufgabe "${roleName}" gelöscht`, 'info');
        await loadEventsData();
        refreshDetailEvent(true);
    } catch {
        showToast('Fehler beim Löschen der Aufgabe', 'error');
    }
}

async function removeDutyAssignee(dutyId) {
    if (!dutyId || !confirmAction('Diesen Eintrag wirklich entfernen?')) return;
    const ev = currentDetailEvent;
    const roleName = ev?.duties?.find(d => d.id === dutyId)?.roleName;
    const isOnlySlot = (ev?.duties?.filter(d => (d.roleName || '').trim() === (roleName || '').trim()) || []).length === 1;
    await eventAction(`/events/duties/${dutyId}`, 'DELETE', undefined, {
        // Keep the task as an empty role so it doesn't vanish with its last entry
        before: async () => { if (isOnlySlot && roleName && ev?.id) await api(`/events/${ev.id}/duties`, 'POST', { roleName }); },
        success: 'Eintrag entfernt', successType: 'info', error: 'Fehler beim Entfernen'
    });
}

async function toggleEventRegistration(eventId, currentStatus) {
    if (!currentUser) return;
    const cancel = currentStatus === 'registered' || currentStatus === 'waitlist';
    await eventAction(`/events/${eventId}/register`, 'POST', { action: cancel ? 'cancel' : 'register' }, {
        success: data => cancel ? t('events_unregistered_success', 'Erfolgreich abgemeldet') : data.isWaitlist ? t('events_waitlist_success', 'Auf die Warteliste gesetzt') : t('events_registered_success', 'Erfolgreich verbindlich angemeldet!'),
        successType: data => cancel ? 'info' : data.isWaitlist ? 'warning' : 'success',
        error: 'Aktion fehlgeschlagen',
        after: () => { if (currentDetailEvent?.id === eventId) openEventDetailModal(eventId); }
    });
}

async function deleteEvent(eventId) {
    if (!confirmAction(t('events_delete_confirm', 'Möchtest du dieses Event wirklich löschen?'))) return;
    await eventAction(`/events/${eventId}`, 'DELETE', undefined, {
        success: t('events_deleted_success', 'Event gelöscht'), error: 'Löschen fehlgeschlagen', networkError: 'Fehler beim Löschen des Events', after: () => {}
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
    if (!blob) return showToast('Fehler beim Zuschneiden des Bildes.', 'error');
    setButtonLoading('btn-confirm-event-crop', true, 'Wird gespeichert...');
    try {
        const token = await getToken();
        const res = await fetch(`${API}/events/upload-image`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: toFormData({ image: new File([blob], 'event-cover-16-9.jpg', { type: 'image/jpeg' }) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || 'Upload fehlgeschlagen', 'error');
        setValue('detail-edit-image-url', data.url);
        showDetailCover(data.url);
        show('detail-edit-cover-placeholder', false);
        closeModal('event-crop-modal');
        showToast('Eventbild im 16:9-Format übernommen!', 'success');
    } catch (e) {
        console.error('Crop upload error:', e);
        showToast('Fehler beim Speichern des Eventbildes', 'error');
    } finally {
        setButtonLoading('btn-confirm-event-crop', false, null);
    }
}

// --- Calendar subscription (WebCal feed) ---
let cachedCalendarFeed = null;
const fallbackFeedUrl = () => `${location.protocol === 'https:' ? 'https:' : 'http:'}//${location.host}/api/events/calendar.ics?token=${encodeURIComponent(localStorage.getItem('token') || '')}`;

async function fetchPersonalCalendarFeed(force = false) {
    if (cachedCalendarFeed && !force) return cachedCalendarFeed;
    try {
        const res = await api('/user/calendar-feed');
        if (res.ok) return (cachedCalendarFeed = await res.json());
    } catch (err) {
        console.warn('Failed to load personal calendar feed:', err);
    }
    const url = fallbackFeedUrl();
    return { feedUrl: url, webcalUrl: url.replace(/^https?:/, 'webcal:'), calendarToken: '' };
}

const personalFeedUrl = async () => (await fetchPersonalCalendarFeed())?.feedUrl || cachedCalendarFeed?.feedUrl || fallbackFeedUrl();

async function loadPersonalCalendarFeedSettings(force = false) {
    const feed = await fetchPersonalCalendarFeed(force);
    ['user-cal-feed-url', 'admin-cal-feed-url', 'super-admin-events-feed-url'].forEach(id => setValue(id, feed.feedUrl));
}

async function copyPersonalCalendarFeedUrl() {
    navigator.clipboard.writeText(await personalFeedUrl())
        .then(() => showToast('Kalender-URL in die Zwischenablage kopiert!', 'success'))
        .catch(() => showToast('Fehler beim Kopieren der Kalender-URL', 'error'));
}

async function resetCalendarFeedToken() {
    if (!confirmAction('Möchtest du wirklich einen neuen Kalender-Link generieren? Dein bisheriger Kalender-Link wird dadurch ungültig und du musst den Kalender in deinen Apps neu abonnieren.')) return;
    try {
        const res = await api('/user/calendar-feed/reset', 'POST');
        if (!res.ok) return showToast('Fehler beim Zurücksetzen des Links', 'error');
        cachedCalendarFeed = await res.json();
        await loadPersonalCalendarFeedSettings(true);
        showToast('Neuer Kalender-Link erfolgreich generiert!', 'success');
    } catch {
        showToast('Verbindungsfehler beim Zurücksetzen', 'error');
    }
}

// --- Event system settings ---
async function loadEventSystemSettings() {
    try {
        const res = await api('/events/settings');
        if (!res.ok) return;
        const data = await res.json();
        const allowMember = $('super-admin-events-allow-member-creation');
        if (allowMember) allowMember.checked = data.allowMemberCreation !== false;
        setValue('super-admin-events-default-duties', Array.isArray(data.defaultDuties) ? data.defaultDuties.join(', ') : '');
        setValue('super-admin-events-feed-url', cachedCalendarFeed?.feedUrl || fallbackFeedUrl());
    } catch (err) {
        console.warn('Failed to load event system settings:', err);
    }
}

async function saveEventSystemSettings() {
    const payload = {
        allowMemberCreation: isChecked('super-admin-events-allow-member-creation'),
        defaultDuties: inputValue('super-admin-events-default-duties').split(',').map(s => s.trim()).filter(Boolean)
    };
    try {
        const res = await api('/events/settings', 'PATCH', payload);
        showToast(res.ok ? 'Event-Einstellungen erfolgreich gespeichert!' : 'Fehler beim Speichern der Event-Einstellungen', res.ok ? 'success' : 'error');
    } catch {
        showToast('Verbindungsfehler', 'error');
    }
}

// --- Detail modal: inline edit mode (create & edit) ---
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
    if (groupList().length === 0) loadSystemGroups().then(() => populateDetailEditTargetGroups(selectedGroups));
    show('detail-modal-action-bar', true, 'flex');
    setText('detail-btn-save-text', ev ? 'Speichern' : 'Veröffentlichen');
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
        showToast('Bitte gib einen Titel ein', 'warning');
        return $('detail-edit-title')?.focus();
    }
    if (!date) {
        showToast('Bitte gib ein Datum ein', 'warning');
        return $('detail-edit-date')?.focus();
    }
    if (isMultiDay && payload.endDate && payload.endDate < date) return showToast('Das Enddatum darf nicht vor dem Startdatum liegen', 'warning');

    const saveBtn = $('detail-btn-save');
    if (saveBtn) saveBtn.disabled = true;
    setText('detail-btn-save-text', 'Wird gespeichert...');
    try {
        const eventId = currentDetailEvent ? currentDetailEvent.id : null;
        const res = await api(eventId ? `/events/${eventId}` : '/events', eventId ? 'PATCH' : 'POST', payload);
        const saved = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(saved.error || 'Fehler beim Speichern', 'error');
        showToast(eventId ? 'Erfolgreich aktualisiert!' : (isRecurring ? `${recurringCount} Termine erfolgreich erstellt!` : 'Erfolgreich veröffentlicht!'), 'success');
        detailCard()?.classList.remove('detail-is-editing', 'detail-is-new');
        hideTypeSelector();
        await loadEventsData();
        const reopenId = eventId || saved.id || saved._id || saved.event?.id || saved.event?._id;
        if (reopenId) openEventDetailModal(reopenId);
        else closeModal('event-detail-modal');
    } catch (err) {
        console.error('saveDetailEditMode error:', err);
        showToast('Verbindungsfehler beim Speichern', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
        setText('detail-btn-save-text', currentDetailEvent ? 'Speichern' : 'Veröffentlichen');
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
    setText('detail-modal-title', type === 'event' ? 'Neues Event' : 'Neuer Termin');
    show('detail-modal-organizer-pill', false);
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
}

function setDetailEditType(type) {
    const canManage = canManageEvents();
    const isTermin = canManage && type === 'termin';
    setValue('detail-edit-type', isTermin ? 'termin' : 'event');
    syncTypeSelector(canManage);
    $('detail-type-card-termin')?.classList.toggle('is-active', isTermin);
    $('detail-type-card-event')?.classList.toggle('is-active', !isTermin);
    setText('detail-type-desc-text', isTermin
        ? 'Regulärer Termin (z. B. Bistro, Gebetstreff, Probe) – erscheint im Terminkalender.'
        : 'Besonderes Event (z. B. Jugendtreff, Konzert, Fest) – mit Titelbild & Programm.');
    show('detail-edit-pinned-wrap', canManage && !isTermin, 'flex');
    show('detail-edit-recurring-toggle-wrap', canManage && isTermin && !currentDetailEvent, 'inline-flex');
}

function toggleDetailMultiDay(isMultiDay) {
    show('detail-field-end-date', isMultiDay, 'flex');
    show('detail-when-time-row', !isMultiDay, 'grid');
    show('detail-multiday-hint', isMultiDay, 'flex');
    const dateLabel = document.querySelector('label[for="detail-edit-date"]');
    if (dateLabel) dateLabel.textContent = isMultiDay ? 'Startdatum' : 'Datum';
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
        ? '<span style="font-size:0.78rem; color:var(--text-secondary);">Öffentlich für alle Mitglieder</span>'
        : groupList().map(g => {
            const name = g.name || g.id;
            return `
                <button type="button" class="detail-group-chip ${selectedGroups.includes(name) || selectedGroups.includes(g.id) ? 'is-selected' : ''}" data-group="${escapeHtml(name)}" onclick="this.classList.toggle('is-selected')">
                    <span>👥 ${escapeHtml(name)}</span>
                </button>`;
        }).join('');
}

function autoResizeDetailTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(300, Math.max(85, textarea.scrollHeight)) + 'px';
}

Object.assign(window, {
    switchEventsSubTab, respondToDutyRequest, openEventDetailModal, toggleDetailDescription, removeEventAttendee, submitAddNewTask,
    hideAddNewTaskForm, openAssignDutyModalForRole, switchAssignDutyTab, selectDutyAssignee, deleteEntireDutyTask, removeDutyAssignee,
    toggleEventRegistration, confirmEventCrop, copyPersonalCalendarFeedUrl, resetCalendarFeedToken, saveEventSystemSettings,
    enterDetailEditMode, cancelDetailEditMode, saveDetailEditMode, openNewEventDetailModal, setDetailEditType, toggleDetailMultiDay,
    toggleDetailRegFields, autoResizeDetailTextarea,
    showAddNewTaskForm: () => setNewTaskFormVisible(true),
    handleEventsSearchInput: setEventsSearch,
    clearEventsSearch: () => {
        setValue('events-search-input', '');
        setEventsSearch('');
    },
    toggleShowPastEvents: () => {
        showPastEvents = !showPastEvents;
        renderEvents();
    },
    filterAssignDutyModalList: renderAssignDutyModalList,
    deleteCurrentEventFromDetail: () => {
        if (!currentDetailEvent) return;
        const eventId = currentDetailEvent.id;
        closeModal('event-detail-modal');
        deleteEvent(eventId);
    },
    resetEventCropZoom: () => eventCropper?.setZoom(1),
    cancelEventCrop: () => closeModal('event-crop-modal'),
    copyCalendarFeedUrl: copyPersonalCalendarFeedUrl,
    openWebCalDirectly: async () => { window.location.href = (await personalFeedUrl()).replace(/^https?:/, 'webcal:'); },
    openGoogleCalendarSubscription: async () => window.open(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(await personalFeedUrl())}`, '_blank', 'noopener,noreferrer'),
    downloadIcsFile: async () => window.open(await personalFeedUrl(), '_blank'),
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
