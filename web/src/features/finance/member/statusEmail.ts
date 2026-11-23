// The e-mail with a member's fee status (sent by the backend's /send-email), from the member's card: the status, paid
// until, and either "all settled", "standing order active" or the months and the amount overdue.
import { api } from '../../../app/api';
import { appName } from '../../../app/config';
import { findPerson, settings, users } from '../../../app/data';
import { escapeHtml, euro, getStatusLabels, monthYearFormatter, t, type MemberStatus } from '../../../app/i18n';
import { canManageFinances } from '../../../app/session';
import { attempt, showToast } from '../../../app/toast';
import { calculatePaidUntil } from '../../../lib/finance.js';
import { statusMetaOf } from '../common';

export async function sendStatusEmail(personId: string): Promise<void> {
  if (!canManageFinances()) return;
  const person = findPerson(personId);
  if (!person) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
  const email = person.uid && users().find(u => u.uid === person.uid)?.email;
  if (!email) return showToast(t('toast_no_email', 'No email address found for this person'), 'error');

  const app = appName();
  const meta = statusMetaOf(person);
  const status = person._currentStatus || person.status;
  const readableStatus = getStatusLabels(false)[status as MemberStatus] || status;
  // The server normally sends _paidUntil; without it the same rule is worked out here (lib/finance.js)
  const paidUntil: Date | null = person._paidUntil ? new Date(person._paidUntil) : calculatePaidUntil(person, settings());
  const paidUntilLabel = paidUntil ? monthYearFormatter.format(paidUntil) : t('never_paid', 'Never');
  const today = new Date();
  const overdueMonths = paidUntil ? Math.max(0, today.getFullYear() * 12 + today.getMonth() - (paidUntil.getFullYear() * 12 + paidUntil.getMonth())) : 0;
  const monthStr = overdueMonths === 1 ? t('email_status_one_month', 'one month') : t('email_status_n_months', '{count} months', { count: overdueMonths });
  const openAmount = euro(person._overdueAmount || 0);
  const box = (color: string, border: string, inner: string) =>
    `<div style="background-color: ${color}; border-left: 4px solid ${border}; padding: 15px; border-radius: 8px; margin-bottom: 25px;">${inner}</div>`;
  const okParagraph = (text: string) => `<p style="margin: 0; color: #15803D; font-size: 16px; font-weight: 600;">${text}</p>`;
  let customMessage: string;
  let customHtml: string;
  if (meta.isActiveStandingOrder) {
    customMessage = t('email_status_standing_order', 'Your standing order is active – so there is nothing else you need to do!');
    customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
  } else if (meta.isOverdue) {
    const overdueText = (months: string) => t('email_status_overdue', 'This means your fee is currently overdue for {months}.', { months });
    const amountText = t('email_status_open_amount', 'The total outstanding amount is {amount}.', { amount: openAmount });
    customMessage = `${overdueText(monthStr)}\n${amountText}`;
    customHtml = box(
      '#FEF2F2',
      '#EF4444',
      `<p style="margin: 0 0 5px 0; color: #B91C1C; font-size: 16px;">${overdueText(`<strong>${escapeHtml(monthStr)}</strong>`)}</p><p style="margin: 0; color: #B91C1C; font-size: 16px; font-weight: 600;">${escapeHtml(amountText)}</p>`
    );
  } else {
    customMessage = t('email_status_ok', 'Your fee account is fully settled. Thank you very much!');
    customHtml = box('#F0FDF4', '#22C55E', okParagraph(customMessage));
  }
  const paragraph = (margin: string, content: string, extra = ' line-height: 1.5;') => `<p style="margin: ${margin}; font-size: 16px;${extra}">${content}</p>`;
  const mail = {
    greeting: (name: string) => t('email_status_greeting', 'Hello {name},', { name }),
    intro: t('email_status_intro', 'here is a short update on the current status of your membership fees.'),
    tier: (value: string) => t('email_status_tier', 'Your fee category is currently set to {status}.', { status: value }),
    paidUntil: (date: string) => t('email_status_paid_until', 'According to our records, you have paid your fees up to and including {date}.', { date }),
    questions: t('email_status_questions', 'If you have any questions, feel free to get in touch at any time.'),
    regards: t('email_status_regards', 'Kind regards,'),
    signature: (name: string) => t('email_status_signature', 'Your {app} team', { app: name })
  };
  const text = `${mail.greeting(person.name || '')}\n\n${mail.intro}\n\n${mail.tier(`'${readableStatus}'`)}\n${mail.paidUntil(paidUntilLabel)}\n\n${customMessage}\n\n${mail.questions}\n\n${mail.regards}\n${mail.signature(app)}`;
  const html = `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
                    <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(app)}</h1>
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
                    ${paragraph('0', mail.signature(escapeHtml(app)), ' font-weight: 600; color: #2D3748;')}
                </div>
            </div>
        </div>`;
  await attempt(
    async () => {
      const res = await api('/send-email', 'POST', { to: email, subject: t('email_status_subject', 'Your membership fee status - {app}', { app }), text, html });
      if (res.ok) {
        showToast(t('toast_email_sent', 'Status email sent'));
      } else {
        showToast(t('toast_email_failed', 'Failed to send email'), 'error');
        console.error('Email API response not ok:', await res.text());
      }
    },
    t('toast_email_failed', 'Failed to send email'),
    { toast: 'error' }
  );
}
