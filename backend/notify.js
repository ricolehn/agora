// One way to notify people: push (web push + FCM) and/or e-mail, each only when the person wants this kind of
// message over that channel (notificationPrefs.js). E-mails share one template with the app name, a heading, a few
// lines, optional detail rows and a button into the app.
const { wantsNotification } = require('./notificationPrefs');
const { sendPushToUser } = require('./pushNotifications');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

/** '' for empty, the URL without trailing slash for http(s) URLs, null for anything else. */
function normalizePublicUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Base URL of the app for links in e-mails: the configured publicUrl (System-Konfiguration, recommended), otherwise
 * the host of the request that triggered the notification - only when it looks like a plain host name, so a forged
 * Host header cannot put arbitrary text into the links.
 */
function originOf(req) {
  const { context } = require('./context');
  const configured = normalizePublicUrl(context.appConfig?.publicUrl);
  if (configured) return configured;
  const host = String(req?.get?.('host') || '');
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return '';
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'http' || forwarded === 'https' ? forwarded : (req.protocol === 'http' ? 'http' : 'https');
  return `${protocol}://${host}`;
}

function buildEmail({ appName, recipientName, heading, lines = [], rows = [], actionLabel, url, accent = '#0891b2' }) {
  const name = appName || 'Agora';
  const greeting = recipientName ? `Hallo ${recipientName},` : 'Hallo,';
  const text = [greeting, '', heading, '', ...lines, ...rows.map(([label, value]) => `${label}: ${value}`), '', url ? `${actionLabel || 'In der App öffnen'}: ${url}` : '', '', `— ${name}`]
    .filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
  const rowHtml = rows.length ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:separate; border-spacing:0; margin:0 0 24px 0; border:1px solid #e2e8f0; border-radius:14px; overflow:hidden;">
        ${rows.map(([label, value], i) => `
        <tr>
          <td style="padding:12px 16px; font-size:14px; color:#64748b; font-weight:600; ${i ? 'border-top:1px solid #e2e8f0;' : ''} white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:12px 16px; font-size:14px; color:#0f172a; font-weight:600; text-align:right; ${i ? 'border-top:1px solid #e2e8f0;' : ''}">${escapeHtml(value)}</td>
        </tr>`).join('')}
      </table>` : '';
  const html = `
  <div style="margin:0; padding:32px 16px; background:#f1f5f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#0f172a;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:24px; overflow:hidden;">
      <div style="height:6px; background:linear-gradient(90deg, #06b6d4, #10b981);"></div>
      <div style="padding:28px 28px 8px 28px;">
        <div style="font-size:13px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:${accent};">${escapeHtml(name)}</div>
        <h1 style="margin:10px 0 0 0; font-size:22px; line-height:1.3; font-weight:800; color:#0f172a;">${escapeHtml(heading)}</h1>
      </div>
      <div style="padding:16px 28px 28px 28px;">
        <p style="margin:0 0 14px 0; font-size:15px; line-height:1.6; color:#334155;">${escapeHtml(greeting)}</p>
        ${lines.map((line) => `<p style="margin:0 0 14px 0; font-size:15px; line-height:1.6; color:#334155;">${escapeHtml(line)}</p>`).join('')}
        ${rowHtml}
        ${url ? `<a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 22px; border-radius:12px; background:${accent}; color:#ffffff; font-size:15px; font-weight:700; text-decoration:none;">${escapeHtml(actionLabel || 'In der App öffnen')}</a>` : ''}
      </div>
      <div style="padding:16px 28px; background:#f8fafc; border-top:1px solid #e2e8f0; font-size:12px; line-height:1.5; color:#94a3b8;">
        Diese Nachricht wurde automatisch von ${escapeHtml(name)} gesendet. Welche Nachrichten du per E-Mail bekommst, legst du in der App unter Einstellungen → Benachrichtigungen fest.
      </div>
    </div>
  </div>`;
  return { text, html };
}

/** Sends one e-mail if SMTP is set up; failures are logged, never thrown. */
async function sendNotificationEmail(user, { subject, heading, lines, rows, actionLabel, path, accent }, origin = '') {
  const { context } = require('./context');
  const appConfig = context.appConfig;
  if (!user?.email || !context.transporter || !appConfig?.smtp?.user) return false;
  try {
    const url = origin ? `${origin}${path || '/'}` : '';
    const { text, html } = buildEmail({
      appName: appConfig.appName,
      recipientName: user.firstName || user.name || '',
      heading: heading || subject, lines, rows, actionLabel, url, accent
    });
    await context.transporter.sendMail({
      from: `"${appConfig.appName || 'Agora'}" <${appConfig.smtp.user}>`,
      to: user.email,
      subject: `${subject} · ${appConfig.appName || 'Agora'}`,
      text,
      html
    });
    return true;
  } catch (err) {
    console.warn('[Mail] Notification e-mail failed:', err.message);
    return false;
  }
}

/**
 * Notifies [users] (user records) about something of [type]: push with [push] = { title, body, data } and an
 * e-mail with [email] = { subject, heading, lines, rows, actionLabel, path } - each only when wanted.
 */
async function notifyUsers(appConfig, users, type, { push, email, origin = '' }) {
  const list = (Array.isArray(users) ? users : [users]).filter((u) => u && u.id);
  const seen = new Set();
  await Promise.all(list.map(async (user) => {
    if (seen.has(user.id)) return;
    seen.add(user.id);
    const jobs = [];
    if (push && wantsNotification(user, type, 'push')) {
      jobs.push(sendPushToUser(appConfig, user.id, push).catch((err) => console.warn('[Push] failed:', err.message)));
    }
    if (email && wantsNotification(user, type, 'email')) {
      jobs.push(sendNotificationEmail(user, email, origin));
    }
    await Promise.all(jobs);
  }));
}

/** Everyone who decides on finance requests: admins, owner and members of a group with manage_finances. */
async function financeManagers(appConfig) {
  const { listUserRecords, listGroupRecords, resolveUserPermissions } = require('./pocketbase');
  const [users, groups] = await Promise.all([listUserRecords(appConfig), listGroupRecords(appConfig).catch(() => [])]);
  return users.filter((u) => u.admin === true || u.owner === true || u.superAdmin === true
    || resolveUserPermissions(u.groups, groups).canManageFinances);
}

/** Admins and the owner (reported content). */
async function adminUsers(appConfig) {
  const { listUserRecords } = require('./pocketbase');
  const users = await listUserRecords(appConfig);
  return users.filter((u) => u.admin === true || u.owner === true || u.superAdmin === true);
}

module.exports = {
  normalizePublicUrl,
  originOf,
  buildEmail,
  sendNotificationEmail,
  notifyUsers,
  financeManagers,
  adminUsers
};
