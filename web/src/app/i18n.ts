// Texts and formats. English (locales/en.json) is the source language and always complete; other languages are
// translations that may lag behind: missing texts fall back to English. Users get their system language by default.
//
// t(key, fallback, params) reads the loaded texts reactively: used in JSX, a text follows a change of the language.
import { createSignal } from 'solid-js';
import en from '../locales/en.json';
import { flushNow } from './flush';

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];
const BASE_LANGUAGE: Lang = 'en';

// Translations other than English are loaded when chosen (one file each, added by contributors as JSON)
const translationFiles = import.meta.glob<{ default: Record<string, string> }>(['../locales/*.json', '!../locales/en.json']);

const storedLang = (() => {
  try {
    return localStorage.getItem('app_lang') || 'system';
  } catch {
    return 'system';
  }
})();

const [translations, setTranslations] = createSignal<Record<string, string>>(en as Record<string, string>);
const [uiLangSignal, setUiLang] = createSignal<Lang>(BASE_LANGUAGE);
const [langSetting, setLangSetting] = createSignal<string>(storedLang);

/** The language shown ('en' | 'de'). */
export const uiLang = uiLangSignal;
/** The chosen setting: 'system' or a language. */
export { langSetting };
export const uiLocale = () => (uiLang() === 'de' ? 'de-DE' : 'en-GB');

// Untranslated texts are left empty (or missing) in a translation: those keep the English text
const withTranslation = (base: Record<string, string>, own: Record<string, string> | null) => ({
  ...base,
  ...Object.fromEntries(Object.entries(own || {}).filter(([, text]) => typeof text === 'string' && text.trim()))
});

/** The language a setting resolves to: 'system' follows the browser / OS, unsupported languages become English. */
export function resolveLanguage(lang: string): Lang {
  const wanted = lang === 'system' ? navigator.language || BASE_LANGUAGE : lang;
  const short = String(wanted).toLowerCase().split('-')[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(short) ? (short as Lang) : BASE_LANGUAGE;
}

const languageListeners = new Set<(lang: Lang) => void>();
/** Called after every language change (the session tells the server the language for push messages and e-mails). */
export function onLanguageChange(fn: (lang: Lang) => void) {
  languageListeners.add(fn);
  return () => languageListeners.delete(fn);
}

export async function loadLanguage(lang: string): Promise<void> {
  try {
    const resolved = resolveLanguage(lang);
    let own: Record<string, string> | null = null;
    if (resolved !== BASE_LANGUAGE) {
      const file = translationFiles[`../locales/${resolved}.json`];
      own = file ? await file().then(m => m.default).catch(e => (console.warn(`Translation ${resolved} not loaded:`, e), null)) : null;
    }
    setTranslations(withTranslation(en as Record<string, string>, own));
    setUiLang(resolved);
    setLangSetting(lang);
    flushNow();
    document.documentElement.lang = resolved;
    try {
      localStorage.setItem('app_lang', lang);
    } catch {
      /* private mode */
    }
    for (const fn of languageListeners) fn(resolved);
  } catch (e) {
    console.error('Failed to load translation:', e);
  }
}

/** The text of [key] in the current language; [fallback] (the English text) when the key is unknown. */
export function t(key: string, fallback = '', params: Record<string, string | number> | null = null): string {
  const all = translations();
  let str = all[key] !== undefined ? all[key] : fallback;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
export const escapeHtml = (text: unknown) => (text ? String(text).replace(/[&<>"']/g, m => HTML_ESCAPES[m]) : '');

/**
 * For the few texts that contain markup (<strong>, <br>): the text as HTML for innerHTML, its parameters escaped.
 * Use only with keys whose English text contains tags.
 */
export function tHtml(key: string, fallback = '', params: Record<string, string | number> | null = null): string {
  const escaped = params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeHtml(v)])) : null;
  return t(key, fallback, escaped);
}

// Pages rendered before any data (a shared event for visitors) wait for the texts
export const languageReady = loadLanguage(storedLang);

// --- Formats follow the UI language ---
const intlCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
export function intlFormatter<T extends typeof Intl.NumberFormat | typeof Intl.DateTimeFormat>(Ctor: T, options: object): InstanceType<T> {
  const key = Ctor.name + uiLocale() + JSON.stringify(options);
  if (!intlCache.has(key)) intlCache.set(key, new (Ctor as any)(uiLocale(), options));
  return intlCache.get(key) as InstanceType<T>;
}
const localeFormatter = (Ctor: typeof Intl.NumberFormat | typeof Intl.DateTimeFormat, options: object) => ({
  format: (value: any) => intlFormatter(Ctor, options).format(value)
});
export const currencyFormatter = localeFormatter(Intl.NumberFormat, { style: 'currency', currency: 'EUR' });
export const dateFormatter = localeFormatter(Intl.DateTimeFormat, { day: '2-digit', month: '2-digit', year: 'numeric' });
export const monthYearFormatter = localeFormatter(Intl.DateTimeFormat, { month: 'long', year: 'numeric' });
export const dateTimeFormatter = localeFormatter(Intl.DateTimeFormat, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** An amount with the euro sign where the language puts it ("50,00 €" / "€50.00"). */
export const euro = (amount: unknown) => {
  const num = parseFloat(String(amount));
  return currencyFormatter.format(Number.isNaN(num) ? 0 : num);
};

/** A day as text (31.12.2026 / 31/12/2026); only real ISO dates take the fast path. */
export function formatDateFast(dateInput: unknown): string {
  if (!dateInput) return '';
  const str = String(dateInput);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return [str.slice(8, 10), str.slice(5, 7), str.slice(0, 4)].join(uiLang() === 'en' ? '/' : '.');
  const d = new Date(dateInput as string);
  return Number.isNaN(d.getTime()) ? t('no_date', 'No date') : dateFormatter.format(d);
}

const utcDate = (day: string) => new Date(`${day}T00:00:00Z`);
export const longDayText = (day: string) => intlFormatter(Intl.DateTimeFormat, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(day));
export const longDateText = (day: string) => intlFormatter(Intl.DateTimeFormat, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(day));
export const monthText = (month: string) => intlFormatter(Intl.DateTimeFormat, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(`${month}-01`));

// Keys are the status texts the server computes (backend/derivedData.js). They are fixed protocol values that
// released apps compare against, so they stay German on the wire; users see them translated.
const STATUS_TEXT_KEYS: Record<string, [string, string]> = {
  'Dauerauftrag läuft': ['status_standing_order_active', 'Standing order is active'],
  'Dauerauftrag läuft für den Beitrag': ['status_standing_order_active', 'Standing order is active'],
  'Dauerauftrag aktiv': ['status_standing_order_active', 'Standing order is active'],
  'Alles in Ordnung': ['status_all_ok', 'All good'],
  'Zahlung überfällig': ['status_payment_overdue', 'Payment overdue'],
  'Keine Zahlungen': ['status_no_payments', 'No payments'],
  'läuft diesen Monat ab': ['status_expires_this_month', 'expires this month'],
  'läuft nächsten Monat ab': ['status_expires_next_month', 'expires next month']
};
export function translateStatusText(text: unknown): string {
  if (!text) return '';
  const clean = String(text).trim();
  if (STATUS_TEXT_KEYS[clean]) return t(...STATUS_TEXT_KEYS[clean]);
  const overdue = clean.match(/(\d+)\s+Monat[e]?\s+überfällig/);
  if (overdue) return overdue[1] === '1' ? t('status_one_month_overdue', '1 month overdue') : t('status_months_overdue', '{months} months overdue', { months: overdue[1] });
  const left = clean.match(/noch\s+(\d+)\s+Monat[e]?/);
  if (left) return left[1] === '1' ? t('status_one_month_left', '1 month left') : t('status_months_left', '{months} months left', { months: left[1] });
  return String(text);
}

export type MemberStatus = 'vollverdiener' | 'geringverdiener' | 'keinverdiener' | 'pausiert';
export function getStatusLabels(withEmoji = false): Record<MemberStatus, string> {
  const labels: Record<MemberStatus, string> = {
    vollverdiener: t('member_status_full', '💼 Full earner'),
    geringverdiener: t('member_status_low', '📉 Low earner'),
    keinverdiener: t('member_status_none', '🎓 Non-earner'),
    pausiert: t('member_status_paused', '⏸️ Paused')
  };
  if (!withEmoji) for (const k in labels) labels[k as MemberStatus] = labels[k as MemberStatus].replace(/^[💼📉🎓⏸️\s]+/u, '').trim();
  return labels;
}
