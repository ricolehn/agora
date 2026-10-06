// Reports of objectionable content (Google Play AI-generated content and user-generated content policies):
// users flag an AI reply or a chat message; admins get a push and can list the reports.
const crypto = require('crypto');
const { getStateValue, upsertStateValue } = require('./pocketbase');

const REPORT_TYPES = ['ai', 'chat'];
const MAX_STORED_REPORTS = 500;
const MAX_TEXT = 4000;

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

/** Validated report from a request body, or an error message. */
function buildReport(body, user, now = Date.now()) {
  const type = String(body?.type || '');
  if (!REPORT_TYPES.includes(type)) return { error: 'Unbekannte Art der Meldung.' };
  const content = clip(body?.content, MAX_TEXT).trim();
  if (!content) return { error: 'Die gemeldete Nachricht fehlt.' };
  return {
    report: {
      id: crypto.randomUUID(),
      type,
      content,
      reason: clip(body?.reason, 500).trim(),
      prompt: type === 'ai' ? clip(body?.prompt, MAX_TEXT).trim() : '',
      threadId: type === 'chat' ? clip(body?.threadId, 64) : '',
      reportedBy: user?.uid || user?.id || '',
      reporterName: user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '',
      created: now,
      status: 'open'
    }
  };
}

async function storeReport(appConfig, report) {
  const list = await getStateValue(appConfig, 'content_reports', []);
  const next = [report, ...(Array.isArray(list) ? list : [])].slice(0, MAX_STORED_REPORTS);
  await upsertStateValue(appConfig, 'content_reports', next);
  return report;
}

async function listReports(appConfig) {
  const list = await getStateValue(appConfig, 'content_reports', []);
  return Array.isArray(list) ? list : [];
}

async function resolveReport(appConfig, id) {
  const list = await listReports(appConfig);
  const next = list.map(r => (r.id === id ? { ...r, status: 'resolved', resolved: Date.now() } : r));
  await upsertStateValue(appConfig, 'content_reports', next);
  return next.find(r => r.id === id) || null;
}

module.exports = { REPORT_TYPES, buildReport, storeReport, listReports, resolveReport };
