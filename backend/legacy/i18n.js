// Server texts (error messages, push, e-mail) are written in English in the code - the source language. A
// translation (locales/<lang>.json) maps the English text to the text in that language; anything not translated
// yet simply stays English, so new code never has to wait for translators.
//
// Which language: for answers to a request the language the app asks for (Accept-Language), then the user's
// stored language; for push and e-mail the recipient's stored language. Both fall back to the instance default
// (System configuration) and then to English.
const fs = require('fs');
const path = require('path');

const BASE_LANGUAGE = 'en';
const LOCALES_DIR = path.join(__dirname, 'locales');

// Translations are optional: an empty or missing entry keeps the English text, and a broken file only disables
// its own language (logged) instead of stopping the server
const catalogs = {};
for (const file of fs.existsSync(LOCALES_DIR) ? fs.readdirSync(LOCALES_DIR) : []) {
  if (!file.endsWith('.json')) continue;
  try {
    catalogs[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
  } catch (err) {
    console.warn(`[i18n] Translation ${file} ignored:`, err.message);
  }
}
const SUPPORTED_LANGUAGES = [BASE_LANGUAGE, ...Object.keys(catalogs).filter((lang) => lang !== BASE_LANGUAGE)];

/** 'de', 'de-DE', 'DE' -> 'de'; unsupported or empty -> null. */
function normalizeLanguage(value) {
  const short = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(short) ? short : null;
}

/** First supported language of an Accept-Language header ("de-DE,de;q=0.9,en;q=0.8"), by quality. */
function languageFromHeader(header) {
  const wanted = String(header || '').split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { lang: normalizeLanguage(tag), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.lang && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  return wanted[0]?.lang || null;
}

function instanceLanguage() {
  const { context } = require('./context');
  return normalizeLanguage(context.appConfig?.defaultLanguage) || BASE_LANGUAGE;
}

/** Language for push / e-mail to a user record. */
function userLanguage(user) {
  return normalizeLanguage(user?.language) || instanceLanguage();
}

/** Language for the answer to a request. */
function requestLanguage(req) {
  return languageFromHeader(req?.headers?.['accept-language']) || normalizeLanguage(req?.user?.language) || instanceLanguage();
}

/** The English [text] in [lang] with {placeholders} filled in. */
function translate(lang, text, params = null) {
  const translated = lang && lang !== BASE_LANGUAGE ? catalogs[lang]?.[text] : null;
  const template = typeof translated === 'string' && translated.trim() ? translated : text;
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (params && params[key] !== undefined ? String(params[key]) : match));
}

/** translate() bound to one language: tr('Hello {name}', { name }). */
const translator = (lang) => (text, params) => translate(lang, text, params);

/**
 * Middleware: the error / message texts of JSON answers are translated into the language of the request, so routes
 * just answer res.status(403).json({ error: 'Finance access required' }).
 */
function translateResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && (typeof body.error === 'string' || typeof body.message === 'string')) {
      const lang = requestLanguage(req);
      if (lang !== BASE_LANGUAGE) {
        body = { ...body };
        if (typeof body.error === 'string') body.error = translate(lang, body.error);
        if (typeof body.message === 'string') body.message = translate(lang, body.message);
      }
    }
    return json(body);
  };
  next();
}

module.exports = {
  catalogs,
  BASE_LANGUAGE,
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  languageFromHeader,
  instanceLanguage,
  userLanguage,
  requestLanguage,
  translate,
  translator,
  translateResponses
};
