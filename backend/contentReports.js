// Reports of objectionable content (Google Play AI-generated content and user-generated content policies):
// users flag an AI reply or a chat message; admins get a push and can list the reports.
const crypto = require('crypto');
const systemStore = require('./db/stores/system');

const REPORT_TYPES = ['ai', 'chat'];
const MAX_TEXT = 4000;

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

/** Validated report from a request body, or an error message. */
function buildReport(body, user, now = Date.now()) {
  const type = String(body?.type || '');
  if (!REPORT_TYPES.includes(type)) return { error: 'Unknown kind of report.' };
  const content = clip(body?.content, MAX_TEXT).trim();
  if (!content) return { error: 'The reported message is missing.' };
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

// The reports are kept newest first, at most 500 (db/stores/system.js): storing and resolving run one after another,
// so a report filed while another one is resolved (or two at once) is not lost
async function storeReport(appConfig, report) {
  return systemStore.addReport(appConfig, report);
}

async function listReports(appConfig) {
  const list = await systemStore.listReports(appConfig);
  return Array.isArray(list) ? list : [];
}

async function resolveReport(appConfig, id) {
  return systemStore.resolveReports(appConfig, id);
}

module.exports = { REPORT_TYPES, buildReport, storeReport, listReports, resolveReport };
