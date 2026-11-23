const express = require('express');
const { instanceLanguage, normalizeLanguage, SUPPORTED_LANGUAGES, translate, translator, userLanguage, requestLanguage } = require('../i18n');
const { cleanCcli } = require('../songbook');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { context, churchLogoFile, configFile, profilesDir, dataDir } = require('../context');
const { sseClients, broadcastDataUpdate } = require('../liveUpdates');
const { logoUpload } = require('../uploads');
const { verifyToken, verifyAdmin } = require('../auth');
const { protectedActionRateLimit } = require('../rateLimits');
const { buildSmtpTransport } = require('../runtime');
const { newPersonRecord } = require('../dataPaths');
const { deleteAccountData } = require('../accountDeletion');
const { normalizePublicUrl } = require('../notify');
const { wantsNotification } = require('../notificationPrefs');

const {
  DEFAULT_SYSTEM_STATE,
  ownerClaim,
  updateSystemState,
  getStateValue,
  updateUserRecord,
  listUserRecords,
  listPeopleRecords,
  listGroupRecords,
  listMentorRecords,
  createGroupRecord,
  updateGroupRecord,
  deleteGroupRecord,
  registerUser,
  upsertPeopleRecord,
  adminResetUserPassword,
  getUserRecord,
  upsertPushSubscription,
  deletePushSubscription,
  upsertFcmToken,
  deleteFcmToken,
  isPlaceholderEmail,
  listEvents,
  updateEventRecord
} = require('../pocketbase');
const { SYSTEM_PERMISSIONS, permissionFlags, resolveUserPermissions } = require('../permissions');

const {
  hasSvgExtension,
  isSafeSvg
} = require('../svgValidation');

const {
  getVapidPublicKey,
  sendPushToUser
} = require('../pushNotifications');

const { isFcmEnabled, getClientConfig } = require('../fcmNotifications');

const features = require('../features');
const { route } = require('./http');
const { fullName } = require('../utils/names');

const router = express.Router();

router.get('/api/status', (req, res) => {
  // setupMode: no configuration yet (the setup page is open). ready: the server answers everything; until then a
  // configured instance is starting or upgrading its database (updating)
  res.json({
    setupMode: context.setupMode,
    ready: !context.setupMode && context.phase === 'ready',
    updating: context.phase === 'updating',
    // The versions of the API this server answers (docs/API_V2.md); v1 (/api/...) stays for every app version
    apiVersions: [1, 2],
    // Why the start is still being tried (the cleanup after the database upgrade did not get through yet)
    ...(context.startProblem && context.phase !== 'ready' ? { problem: context.startProblem } : {})
  });
});

router.get('/assets/config.js', async (req, res) => {
  let ready = true;
  try {
    await context.runtimeReady;
  } catch {
    ready = false;
  }

  // Not set up yet: the default name, so the page still loads
  const appName = ready && !context.setupMode && context.appConfig?.appName ? context.appConfig.appName : 'Agora';
  const jsConfig = `
export const config = {
    apiBaseUrl: window.location.origin + "/api",
    appName: ${JSON.stringify(appName)},
    features: ${JSON.stringify({ polls: features.polls })}
};
`;
  res.setHeader('Content-Type', 'application/javascript');
  // A renamed app has to show up on the next load
  res.setHeader('Cache-Control', 'no-cache');
  res.send(jsConfig);
});

router.get('/api/stream', verifyToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Lets broadcasts address single users (private mentoring updates)
  res.agoraUserId = req.user.uid;
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

router.post('/api/admin/bootstrap-super-admin', verifyToken, route('Failed to bootstrap owner', async (req, res) => {
  // Without a recorded owner only an admin takes it over, never a member (pocketbase.js ownerClaim) - decided and
  // written in one step: two admins at the same moment cannot both become the owner
  let claimed = null;
  await updateSystemState(context.appConfig, (system) => {
    claimed = ownerClaim(system, req.user);
    return claimed.claim ? { ...system, ownerUid: claimed.ownerUid, superAdminUid: claimed.ownerUid } : null;
  });
  const { ownerUid, claim: createdNow } = claimed;

  const isOwner = ownerUid !== null && ownerUid === req.user.uid;
  if (isOwner) {
    await updateUserRecord(context.appConfig, req.user.uid, { admin: true, owner: true, superAdmin: true, pays: true });
  }

  res.json({
    isOwner,
    ownerUid,
    isSuperAdmin: isOwner,
    superAdminUid: ownerUid,
    createdNow
  });
}));

router.get('/api/admin/system-config', verifyToken, verifyAdmin, async (req, res) => {
  if (!context.appConfig) {
    return res.status(404).json({ error: 'No config found' });
  }

  let smtpResponse = null;
  if (context.appConfig.smtp) {
    smtpResponse = { ...context.appConfig.smtp, pass: '***' };
  }

  res.json({
    appName: context.appConfig.appName,
    publicUrl: context.appConfig.publicUrl || '',
    defaultLanguage: instanceLanguage(),
    supportedLanguages: SUPPORTED_LANGUAGES,
    ccliLicense: context.appConfig.ccliLicense || '',
    smtp: smtpResponse,
    usesPocketBase: true
  });
});

router.put('/api/admin/system-config', verifyToken, verifyAdmin, route('Failed to update system config', async (req, res) => {
  const appName = String(req.body?.appName || '').trim();
  if (!appName) {
    return res.status(400).json({ error: 'Missing required config fields' });
  }

  let smtp = null;
  if (req.body?.smtp && typeof req.body.smtp === 'object' && String(req.body.smtp.host || '').trim()) {
    let pass = String(req.body.smtp.pass || '');
    if (pass === '***' && context.appConfig.smtp?.pass) {
      pass = context.appConfig.smtp.pass;
    }

    smtp = {
      host: String(req.body.smtp.host || '').trim(),
      port: Number.isFinite(Number(req.body.smtp.port)) ? parseInt(req.body.smtp.port, 10) : 465,
      secure: req.body.smtp.secure === true,
      user: String(req.body.smtp.user || '').trim(),
      pass: pass
    };
  }

  // Address of the app for links in e-mails (recommended; otherwise the request's host is used)
  let publicUrl = context.appConfig.publicUrl || '';
  if (req.body?.publicUrl !== undefined) {
    publicUrl = normalizePublicUrl(req.body.publicUrl);
    if (publicUrl === null) {
      return res.status(400).json({ error: 'The app address must start with http:// or https://.' });
    }
  }

  // Language for members without an own setting (push, e-mail) and for suggested defaults
  let defaultLanguage = instanceLanguage();
  if (req.body?.defaultLanguage !== undefined) {
    defaultLanguage = normalizeLanguage(req.body.defaultLanguage);
    if (!defaultLanguage) {
      return res.status(400).json({ error: 'Unsupported language.' });
    }
  }

  // CCLI licence number of the church (shown with every song of the songbook)
  let ccliLicense = context.appConfig.ccliLicense || '';
  if (req.body?.ccliLicense !== undefined) {
    ccliLicense = cleanCcli(req.body.ccliLicense);
    if (ccliLicense === null) {
      return res.status(400).json({ error: 'The CCLI licence number consists of digits only.' });
    }
  }

  const newConfig = {
    ...context.appConfig,
    appName,
    publicUrl,
    defaultLanguage,
    ccliLicense,
    smtp
  };

  await fs.promises.writeFile(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
  context.appConfig = newConfig;
  context.transporter = buildSmtpTransport(newConfig.smtp || null);
  broadcastDataUpdate();
  res.json({ success: true });
}));

router.get('/api/admin/users', verifyToken, verifyAdmin, route('Failed to list users', async (req, res) => {
  const users = await listUserRecords(context.appConfig);
  const people = await listPeopleRecords(context.appConfig);
  const groups = await listGroupRecords(context.appConfig);
  const approvedMentors = await listMentorRecords(context.appConfig, 'status = "approved"').catch(() => []);
  const approvedMentorUserIds = new Set(approvedMentors.map(m => m.user));
  const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
  const ownerUid = system?.ownerUid || system?.superAdminUid || null;

  const formatted = users.map((u) => {
    const isOwner = u.id === ownerUid || u.owner === true || u.superAdmin === true;
    const isPlaceholder = isPlaceholderEmail(u.email);
    const isClaimed = !isPlaceholder;
    const linkedPerson = people.find(p => p.uid === u.id || (p.data && p.data.uid === u.id));
    const memberSince = linkedPerson?.memberSince || linkedPerson?.data?.memberSince || '';
    const status = linkedPerson?.status || linkedPerson?.data?.status || '';
    const userGroupIds = Array.isArray(u.groups) ? u.groups : (u.groups ? [String(u.groups)] : []);
    const userGroupObjects = userGroupIds.map(gid => {
      const match = groups.find(g => g.id === gid || g.name === gid);
      return match ? { id: match.id, name: match.name, permissions: match.permissions } : { id: gid, name: gid, permissions: [] };
    });
    const { permissions } = resolveUserPermissions(userGroupIds, groups);

    return {
      uid: u.id,
      id: u.id,
      email: isPlaceholder ? '' : (u.email || ''),
      rawEmail: u.email || '',
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      name: fullName(u) || 'Unbekannt',
      admin: u.admin === true || isOwner,
      owner: isOwner,
      superAdmin: isOwner,
      pays: u.pays !== false,
      groups: userGroupIds,
      groupObjects: userGroupObjects,
      permissions,
      ...permissionFlags({ permissions }),
      isApprovedMentor: approvedMentorUserIds.has(u.id),
      emailNotifications: u.emailNotifications !== false,
      isClaimed,
      memberSince,
      status
    };
  });

  res.json(formatted);
}));

router.get('/api/admin/permissions', verifyToken, verifyAdmin, (req, res) => {
  const lang = requestLanguage(req);
  res.json(SYSTEM_PERMISSIONS.map((p) => ({ ...p, name: translate(lang, p.name), description: translate(lang, p.description) })));
});

router.get('/api/admin/groups', verifyToken, verifyAdmin, route('Failed to list groups', async (req, res) => {
  const groups = await listGroupRecords(context.appConfig);
  const users = await listUserRecords(context.appConfig);
  res.json(groups.map((g) => ({
    id: g.id,
    name: g.name,
    permissions: Array.isArray(g.permissions) ? g.permissions : [],
    memberCount: users.filter((u) => Array.isArray(u.groups) && (u.groups.includes(g.id) || u.groups.includes(g.name))).length
  })));
}));

router.post('/api/admin/groups', verifyToken, verifyAdmin, route('Failed to create group', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required.' });

  const existingGroups = await listGroupRecords(context.appConfig);
  if (existingGroups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'A group with this name already exists.' });
  }

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const group = await createGroupRecord(context.appConfig, { name, permissions });
  broadcastDataUpdate();
  res.json(group);
}));

router.put('/api/admin/groups/:id', verifyToken, verifyAdmin, route('Failed to update group', async (req, res) => {
  const { id } = req.params;
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'The group name must not be empty.' });
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : undefined;
  const previousName = (await listGroupRecords(context.appConfig)).find((g) => g.id === id)?.name;
  const group = await updateGroupRecord(context.appConfig, id, { name, permissions });
  // Events keep their target groups by name: they move along, so the group keeps seeing them (editing such an
  // event used to drop the unknown old name, and the event was then visible to everyone)
  if (previousName && group.name !== previousName) {
    for (const ev of await listEvents(context.appConfig)) {
      if (Array.isArray(ev.targetGroups) && ev.targetGroups.includes(previousName)) {
        await updateEventRecord(context.appConfig, ev.id, { targetGroups: ev.targetGroups.map((g) => (g === previousName ? group.name : g)) });
      }
    }
  }
  broadcastDataUpdate();
  res.json(group);
}));

router.delete('/api/admin/groups/:id', verifyToken, verifyAdmin, route('Failed to delete group', async (req, res) => {
  await deleteGroupRecord(context.appConfig, req.params.id);
  broadcastDataUpdate();
  res.json({ success: true });
}));

// True (and answered with 403) when a non-owner admin tries to change the owner's account
async function blockOwnerChange(req, res, uid) {
  if (req.user?.owner === true) return false;
  const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
  const ownerUid = system?.ownerUid || system?.superAdminUid || null;
  const target = uid === ownerUid ? null : await getUserRecord(context.appConfig, uid).catch(() => null);
  if (uid === ownerUid || target?.owner === true || target?.superAdmin === true) {
    res.status(403).json({ error: 'Only the owner can change the owner account.' });
    return true;
  }
  return false;
}

router.put('/api/admin/users/:uid/groups', verifyToken, verifyAdmin, route('Failed to update user groups', async (req, res) => {
  const { uid } = req.params;
  if (await blockOwnerChange(req, res, uid)) return;
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  await updateUserRecord(context.appConfig, uid, { groups });
  broadcastDataUpdate();
  res.json({ success: true, groups });
}));

router.post('/api/admin/users', verifyToken, verifyAdmin, route('Failed to create user', async (req, res) => {
  const { email, password, firstName, lastName, admin, pays, groups, status, memberSince } = req.body || {};
  const normalizedEmail = String(email || '').trim();
  const normalizedPassword = String(password || '');
  const normalizedFirst = String(firstName || '').trim();
  const normalizedLast = String(lastName || '').trim();

  if (!normalizedFirst || !normalizedLast) {
    return res.status(400).json({ error: 'First and last name required.' });
  }

  if (normalizedPassword && normalizedPassword.length < 6) {
    return res.status(400).json({ error: 'The password must be at least 6 characters long.' });
  }

  const hasRealCredentials = Boolean(normalizedEmail && normalizedPassword);

  const createdAuth = await registerUser({
    email: normalizedEmail,
    password: normalizedPassword,
    firstName: normalizedFirst,
    lastName: normalizedLast,
    admin: admin === true,
    owner: false,
    pays: pays !== false,
    groups: Array.isArray(groups) ? groups : [],
    isClaimed: hasRealCredentials
  }, context.appConfig);

  const userUid = createdAuth.user.id || createdAuth.user.uid;
  const name = `${normalizedFirst} ${normalizedLast}`.trim();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = String(memberSince || today).trim() || today;
  const memberStatus = String(status || 'vollverdiener').trim() || 'vollverdiener';

  const personKey = userUid;
  await upsertPeopleRecord(context.appConfig, personKey, {
    id: personKey,
    uid: userUid,
    name,
    status: memberStatus,
    memberSince: startDate,
    originalMemberSince: startDate,
    totalPaid: 0,
    pays: pays !== false,
    standingOrders: [],
    statusHistory: [{ status: memberStatus, startDate }]
  });

  broadcastDataUpdate();
  res.json({ success: true, user: createdAuth.user });
}));

router.put('/api/admin/users/:uid/admin', verifyToken, verifyAdmin, route('Failed to update admin role', async (req, res) => {
  const { uid } = req.params;
  const makeAdmin = req.body?.admin === true;
  const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
  const ownerUid = system?.ownerUid || system?.superAdminUid || null;

  if (uid === ownerUid && !makeAdmin) {
    return res.status(400).json({ error: 'The owner cannot lose administrator rights.' });
  }

  const isTargetOwner = uid === ownerUid;
  await updateUserRecord(context.appConfig, uid, {
    admin: isTargetOwner ? true : makeAdmin,
    owner: isTargetOwner,
    superAdmin: isTargetOwner
  });

  broadcastDataUpdate();
  res.json({ success: true });
}));

router.put('/api/admin/users/:uid/pays', verifyToken, verifyAdmin, route('Failed to update pays status', async (req, res) => {
  const { uid } = req.params;
  if (await blockOwnerChange(req, res, uid)) return;
  const pays = req.body?.pays !== false;

  await updateUserRecord(context.appConfig, uid, { pays });

  const people = await listPeopleRecords(context.appConfig);
  const linkedPerson = people.find(p => p.uid === uid || (p.data && p.data.uid === uid));
  if (pays) {
    if (linkedPerson) {
      const existingData = linkedPerson.data || {};
      existingData.pays = true;
      await upsertPeopleRecord(context.appConfig, linkedPerson.personKey, existingData);
    } else {
      const user = await getUserRecord(context.appConfig, uid);
      const name = fullName(user) || translate(instanceLanguage(), 'Member');
      const today = new Date().toISOString().slice(0, 10);
      const personKey = uid;
      await upsertPeopleRecord(context.appConfig, personKey, newPersonRecord(uid, name, today));
    }
  } else {
    if (linkedPerson) {
      const existingData = linkedPerson.data || {};
      existingData.pays = false;
      await upsertPeopleRecord(context.appConfig, linkedPerson.personKey, existingData);
    }
  }

  broadcastDataUpdate();
  res.json({ success: true, pays });
}));

router.put('/api/admin/users/:uid/member-since', verifyToken, verifyAdmin, route('Failed to update memberSince', async (req, res) => {
  const { uid } = req.params;
  if (await blockOwnerChange(req, res, uid)) return;
  const memberSince = String(req.body?.memberSince || '').trim();
  if (!memberSince) {
    return res.status(400).json({ error: 'Date required.' });
  }

  const people = await listPeopleRecords(context.appConfig);
  const linkedPerson = people.find(p => p.uid === uid || (p.data && p.data.uid === uid));
  if (linkedPerson) {
    const existingData = linkedPerson.data || {};
    existingData.memberSince = memberSince;
    existingData.originalMemberSince = memberSince;
    if (Array.isArray(existingData.statusHistory) && existingData.statusHistory.length > 0) {
      existingData.statusHistory[0].startDate = memberSince;
    }
    await upsertPeopleRecord(context.appConfig, linkedPerson.personKey, existingData);
  } else {
    const user = await getUserRecord(context.appConfig, uid);
    const name = fullName(user) || translate(instanceLanguage(), 'Member');
    const personKey = uid;
    await upsertPeopleRecord(context.appConfig, personKey, newPersonRecord(uid, name, memberSince, user?.pays !== false));
  }

  broadcastDataUpdate();
  res.json({ success: true, memberSince });
}));

router.put('/api/admin/users/:uid/password', verifyToken, verifyAdmin, route('Resetting the password failed', async (req, res) => {
  const { uid } = req.params;
  if (await blockOwnerChange(req, res, uid)) return;
  const newPassword = String(req.body?.password || '');
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'The password must be at least 6 characters long.' });
  }

  await adminResetUserPassword(context.appConfig, uid, newPassword);
  res.json({ success: true, message: 'Password changed successfully.' });
}));

router.delete('/api/admin/users/:uid', verifyToken, verifyAdmin, route('Failed to delete user', async (req, res) => {
  const { uid } = req.params;
  const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
  const ownerUid = system?.ownerUid || system?.superAdminUid || null;

  if (uid === ownerUid) {
    return res.status(400).json({ error: 'The owner account cannot be deleted.' });
  }

  // By uid only (matching by name also deleted other members with the same name)
  const summary = await deleteAccountData(context.appConfig, uid, { profilesDir, dataDir });
  console.log(`[Account] Admin ${req.user.uid} deleted user ${uid}`, summary);

  broadcastDataUpdate();
  res.json({ success: true });
}));

router.post('/api/admin/logo', verifyToken, verifyAdmin, (req, res) => {
  logoUpload.single('logo')(req, res, async (uploadError) => {
    if (uploadError) {
      console.error('Multer error:', uploadError);
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Logo file too large (max 5MB)' });
      }
      return res.status(400).json({ error: 'Invalid logo upload: ' + uploadError.message });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No logo file uploaded' });
      }

      const originalName = req.file.originalname || '';
      const ext = path.extname(originalName).toLowerCase();
      const mimeType = (req.file.mimetype || '').toLowerCase();

      if (!hasSvgExtension(originalName)) {
        return res.status(400).json({ error: 'Only SVG files are allowed (Invalid extension)' });
      }
      if (!ext && mimeType && mimeType !== 'image/svg+xml') {
        return res.status(400).json({ error: 'Only SVG files are allowed (Invalid MIME type)' });
      }

      const content = req.file.buffer.toString('utf8');
      if (!isSafeSvg(content)) {
        return res.status(400).json({ error: 'Invalid SVG file (Contains invalid tags or scripts)' });
      }

      await fs.promises.writeFile(churchLogoFile, content, 'utf8');
      broadcastDataUpdate();
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to update logo:', error);
      let msg = error.message || 'Unknown error';
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        msg = 'Permission denied writing to data directory. Check Docker volume mount permissions.';
      }
      res.status(500).json({ error: 'Failed to update logo: ' + msg });
    }
  });
});

router.post('/api/send-email', protectedActionRateLimit, verifyToken, verifyAdmin, route('Failed to send email', async (req, res) => {
  const { to, subject, text, html } = req.body;
  if (!to || !subject) {
    return res.status(400).json({ error: 'Missing required fields: to, subject' });
  }

  if (!context.transporter || !context.appConfig?.smtp?.user) {
    return res.status(500).json({ error: 'SMTP not configured' });
  }

  const info = await context.transporter.sendMail({
    from: `"${context.appConfig.appName}" <${context.appConfig.smtp.user}>`,
    to,
    subject,
    text,
    html
  });

  // The member also gets a push - only once the e-mail went out, and only if they want finance messages by push
  try {
    const allUsers = await listUserRecords(context.appConfig);
    const recipientUser = allUsers.find(u => u.email && u.email.toLowerCase() === String(to).toLowerCase());
    if (recipientUser && wantsNotification(recipientUser, 'finances', 'push')) {
      const tr = translator(userLanguage(recipientUser));
      sendPushToUser(context.appConfig, recipientUser.id, {
        title: subject || tr('New message'),
        body: text ? (text.length > 150 ? text.slice(0, 147) + '...' : text) : tr('You received a new notification.'),
        data: { url: '/' }
      }).catch(e => console.warn('[WebPush] Send-email push error:', e.message));
    }
  } catch (e) {
    console.warn('[WebPush] Error checking user for send-email push:', e.message);
  }

  console.log('Email sent: %s', info.messageId);
  res.status(200).json({ success: true, messageId: info.messageId });
}));

router.get('/api/push/vapid-public-key', verifyToken, route('Failed to retrieve VAPID key', async (req, res) => {
  const publicKey = await getVapidPublicKey(context.appConfig);
  res.json({ publicKey });
}));

router.post('/api/push/subscribe', verifyToken, route('Failed to save subscription', async (req, res) => {
  const { subscription, userAgent, installed } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription payload' });
  }
  const currentUid = req.user.uid;
  // Only the installed app (PWA) gets pushes, not a browser tab (iOS sends web push to home screen apps only anyway)
  await upsertPushSubscription(context.appConfig, currentUid, subscription, userAgent || req.headers['user-agent'] || '', installed === true);
  res.json({ success: true });
}));

router.post('/api/push/unsubscribe', verifyToken, route('Failed to unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint is required' });
  }
  // Only the own device: another person's subscription stays (the answer is the same, so it tells nothing)
  await deletePushSubscription(context.appConfig, endpoint, req.user.uid);
  res.json({ success: true });
}));

// The Android app initialises Firebase with this public client config, so each instance can use its own project
router.get('/api/push/fcm', verifyToken, (req, res) => {
  const enabled = isFcmEnabled();
  res.json({ enabled, config: enabled ? getClientConfig() : null });
});

router.post('/api/push/fcm/subscribe', verifyToken, route('Failed to save FCM token', async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string' || token.length > 4096) {
    return res.status(400).json({ error: 'Invalid FCM token' });
  }
  const currentUid = req.user.uid;
  await upsertFcmToken(context.appConfig, currentUid, token, typeof platform === 'string' && platform ? platform.slice(0, 32) : 'android');
  res.json({ success: true });
}));

router.post('/api/push/fcm/unsubscribe', verifyToken, route('Failed to unsubscribe', async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }
  const currentUid = req.user.uid;
  await deleteFcmToken(context.appConfig, token, currentUid);
  res.json({ success: true });
}));

router.post('/api/push/test', verifyToken, route('Failed to send test notification', async (req, res) => {
  const currentUid = req.user.uid;
  await sendPushToUser(context.appConfig, currentUid, {
    title: `${context.appConfig?.appName || 'Agora'} Test`,
    body: translate(requestLanguage(req), 'Push notifications are set up successfully!'),
    data: { url: '/' }
  });
  res.json({ success: true });
}));

module.exports = router;
