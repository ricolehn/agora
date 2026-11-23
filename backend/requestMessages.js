// What a member hears when the treasury decides on their finance request, and how its kind, its amount and the reason
// of a rejection read.
const { context } = require('./context');
const { translator, userLanguage, localeOf } = require('./i18n');
const { pushLine } = require('./eventTexts');
const { notifyUsers } = require('./notify');
const { getUserRecord } = require('./pocketbase');

// The kinds of finance request (English source texts, translated per recipient)
const REQUEST_TYPE_LABELS = { payment: 'Payment', expense: 'Expense', status: 'Status change', standing_order: 'Standing order' };

function requestAmountLabel(request, lang) {
  const tr = translator(lang);
  const data = request.data || {};
  if (request.type === 'status') return data.newStatus || '';
  const amount = Number.parseFloat(String(data.amount || '0').replace(',', '.'));
  const text = Number.isFinite(amount) ? amount.toLocaleString(localeOf(lang), { style: 'currency', currency: 'EUR' }) : String(data.amount || '');
  return request.type === 'standing_order' ? tr('{amount} / month', { amount: text }) : text;
}

// What the apps store as the reason of a rejection without one: a fixed value every app shows its own text for
const NO_REASON_GIVEN = 'Kein Grund angegeben';
/** The reason a rejection names ('' when none was given). */
const rejectionReasonText = (value) => {
  const text = String(value || '').trim();
  return text === NO_REASON_GIVEN ? '' : text;
};

// Push and e-mail to the member whose request was decided (kind "requests")
async function notifyRequestDecision(request, origin = '') {
  const author = request.userId ? await getUserRecord(context.appConfig, request.userId).catch(() => null) : null;
  if (!author) return;
  const approved = request.status === 'approved';
  // The apps store "Kein Grund angegeben" when no reason was given: no reason to name (it went out in German to all)
  const reason = rejectionReasonText(request.rejectionReason);
  // Texts in the author's language
  const texts = (tr) => {
    const type = tr(REQUEST_TYPE_LABELS[request.type] || 'Request');
    const amount = requestAmountLabel(request, userLanguage(author));
    const what = amount ? tr('{type} of {amount}', { type, amount }) : type;
    return { type, amount, what };
  };
  await notifyUsers(context.appConfig, [author], 'requests', {
    origin,
    // "Expense rejected" - "50,00 € · Reason: receipt missing"
    push: (tr) => {
      const { type, amount } = texts(tr);
      return {
        title: approved ? tr('{type} approved', { type }) : tr('{type} rejected', { type }),
        body: pushLine(amount, !approved && reason ? tr('Reason: {reason}', { reason }) : '')
          || (approved ? tr('Your request was approved') : tr('Your request was rejected')),
        data: { url: '/#requests' },
        tag: `agora-request-${request.id || ''}`
      };
    },
    email: (tr) => {
      const { type, amount, what } = texts(tr);
      const title = approved ? tr('Your request was approved') : tr('Your request was rejected');
      return {
        subject: title,
        heading: title,
        lines: [approved ? tr('Your {what} was approved by the treasury.', { what }) : tr('Your {what} was rejected by the treasury.', { what })],
        rows: [[tr('Kind'), type], ...(amount ? [[tr('Amount'), amount]] : []), [tr('Status'), approved ? tr('Approved') : tr('Rejected')], ...(!approved && reason ? [[tr('Reason'), reason]] : [])],
        actionLabel: tr('View my requests'),
        path: '/#user-finances',
        accent: approved ? '#059669' : '#dc2626'
      };
    }
  });
}

module.exports = { REQUEST_TYPE_LABELS, NO_REASON_GIVEN, rejectionReasonText, notifyRequestDecision };
