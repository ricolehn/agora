const express = require('express');
const { instanceLanguage, normalizeLanguage, SUPPORTED_LANGUAGES, translate, translator, userLanguage, requestLanguage } = require('../i18n');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  context,
  sseClients,
  broadcastDataUpdate,
  churchLogoFile,
  logoUpload,
  verifyToken,
  verifyAdmin,
  verifySuperAdmin,
  protectedActionRateLimit,
  buildSmtpTransport,
  configFile,
  profilesDir,
  newPersonRecord
} = require('../context');
const { deleteAccountData } = require('../accountDeletion');
const { normalizePublicUrl } = require('../notify');

const {
  DEFAULT_SYSTEM_STATE,
  getStateValue,
  upsertStateValue,
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
  resolveUserPermissions,
  SYSTEM_PERMISSIONS
} = require('../pocketbase');

const {
  hasSvgExtension,
  isSafeSvg
} = require('../svgValidation');

const {
  getVapidPublicKey,
  sendPushToUser
} = require('../pushNotifications');

const { isFcmEnabled, getClientConfig } = require('../fcmNotifications');

const router = express.Router();

router.get('/api/status', (req, res) => {
  res.json({ setupMode: context.setupMode });
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
    appName: ${JSON.stringify(appName)}
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
  res.agoraUserId = req.user.uid || req.user.id;
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

router.post('/api/admin/bootstrap-super-admin', verifyToken, async (req, res) => {
  try {
    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    let ownerUid = system?.ownerUid || system?.superAdminUid || null;
    let createdNow = false;

    if (!ownerUid) {
      ownerUid = req.user.uid;
      createdNow = true;
      await upsertStateValue(context.appConfig, 'system', { ...system, ownerUid, superAdminUid: ownerUid });
    }

    const isOwner = ownerUid === req.user.uid;
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
  } catch (error) {
    console.error('Failed to bootstrap owner:', error);
    res.status(500).json({ error: 'Failed to bootstrap owner' });
  }
});

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
    smtp: smtpResponse,
    usesPocketBase: true
  });
});

router.put('/api/admin/system-config', verifyToken, verifyAdmin, async (req, res) => {
  try {
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

    const newConfig = {
      ...context.appConfig,
      appName,
      publicUrl,
      defaultLanguage,
      smtp
    };

    await fs.promises.writeFile(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
    context.appConfig = newConfig;
    context.transporter = buildSmtpTransport(newConfig.smtp || null);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update system config:', error);
    res.status(500).json({ error: 'Failed to update system config' });
  }
});

router.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
      const resolved = resolveUserPermissions(userGroupIds, groups);

      return {
        uid: u.id,
        id: u.id,
        email: isPlaceholder ? '' : (u.email || ''),
        rawEmail: u.email || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unbekannt',
        admin: u.admin === true || isOwner,
        owner: isOwner,
        superAdmin: isOwner,
        pays: u.pays !== false,
        groups: userGroupIds,
        groupObjects: userGroupObjects,
        permissions: resolved.permissions,
        canManageFinances: resolved.canManageFinances,
        canViewFinances: resolved.canViewFinances,
        canManageRegistrationCode: resolved.canManageRegistrationCode === true,
        canAccessAi: resolved.canAccessAi,
        canParticipateMentoring: resolved.canParticipateMentoring,
        canManageMentoring: resolved.canManageMentoring,
        canManageEvents: resolved.canManageEvents === true,
        isApprovedMentor: approvedMentorUserIds.has(u.id),
        emailNotifications: u.emailNotifications !== false,
        isClaimed,
        memberSince,
        status
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Failed to list admin users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/api/admin/permissions', verifyToken, verifyAdmin, (req, res) => {
  const lang = requestLanguage(req);
  res.json(SYSTEM_PERMISSIONS.map((p) => ({ ...p, name: translate(lang, p.name), description: translate(lang, p.description) })));
});

router.get('/api/admin/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const groups = await listGroupRecords(context.appConfig);
    const users = await listUserRecords(context.appConfig);

    const formatted = groups.map(g => {
      const memberCount = users.filter(u => Array.isArray(u.groups) && (u.groups.includes(g.id) || u.groups.includes(g.name))).length;
      return {
        id: g.id,
        name: g.name,
        permissions: Array.isArray(g.permissions) ? g.permissions : [],
        memberCount
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Failed to list groups:', error);
    res.status(500).json({ error: error.message || 'Failed to list groups' });
  }
});

router.post('/api/admin/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Failed to create group:', error);
    res.status(500).json({ error: error.message || 'Failed to create group' });
  }
});

router.put('/api/admin/groups/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
    if (name !== undefined && !name) return res.status(400).json({ error: 'The group name must not be empty.' });
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : undefined;
    const group = await updateGroupRecord(context.appConfig, id, { name, permissions });
    broadcastDataUpdate();
    res.json(group);
  } catch (error) {
    console.error('Failed to update group:', error);
    res.status(500).json({ error: error.message || 'Failed to update group' });
  }
});

router.delete('/api/admin/groups/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteGroupRecord(context.appConfig, id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete group:', error);
    res.status(500).json({ error: error.message || 'Failed to delete group' });
  }
});

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

router.put('/api/admin/users/:uid/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    if (await blockOwnerChange(req, res, uid)) return;
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    await updateUserRecord(context.appConfig, uid, { groups });
    broadcastDataUpdate();
    res.json({ success: true, groups });
  } catch (error) {
    console.error('Failed to update user groups:', error);
    res.status(500).json({ error: error.message || 'Failed to update user groups' });
  }
});

router.post('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
    const fullName = `${normalizedFirst} ${normalizedLast}`.trim();
    const today = new Date().toISOString().slice(0, 10);
    const startDate = String(memberSince || today).trim() || today;
    const memberStatus = String(status || 'vollverdiener').trim() || 'vollverdiener';

    const personKey = userUid;
    await upsertPeopleRecord(context.appConfig, personKey, {
      id: personKey,
      uid: userUid,
      name: fullName,
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
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(error.status || 400).json({ error: error.message || 'Failed to create user' });
  }
});

router.put('/api/admin/users/:uid/admin', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Failed to update admin role:', error);
    res.status(500).json({ error: 'Failed to update admin role' });
  }
});

router.put('/api/admin/users/:uid/pays', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
        const fullName = user ? (user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || translate(instanceLanguage(), 'Member')) : translate(instanceLanguage(), 'Member');
        const today = new Date().toISOString().slice(0, 10);
        const personKey = uid;
        await upsertPeopleRecord(context.appConfig, personKey, newPersonRecord(uid, fullName, today));
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
  } catch (error) {
    console.error('Failed to update pays status:', error);
    res.status(500).json({ error: 'Failed to update pays status' });
  }
});

router.put('/api/admin/users/:uid/member-since', verifyToken, verifyAdmin, async (req, res) => {
  try {
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
      const fullName = user ? (user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || translate(instanceLanguage(), 'Member')) : translate(instanceLanguage(), 'Member');
      const personKey = uid;
      await upsertPeopleRecord(context.appConfig, personKey, newPersonRecord(uid, fullName, memberSince, user?.pays !== false));
    }

    broadcastDataUpdate();
    res.json({ success: true, memberSince });
  } catch (error) {
    console.error('Failed to update memberSince:', error);
    res.status(500).json({ error: 'Failed to update memberSince' });
  }
});

router.put('/api/admin/users/:uid/password', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    if (await blockOwnerChange(req, res, uid)) return;
    const newPassword = String(req.body?.password || '');
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'The password must be at least 6 characters long.' });
    }

    await adminResetUserPassword(context.appConfig, uid, newPassword);
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Failed to reset user password:', error);
    res.status(error.status || 500).json({ error: error.message || 'Resetting the password failed' });
  }
});

router.delete('/api/admin/users/:uid', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;

    if (uid === ownerUid) {
      return res.status(400).json({ error: 'The owner account cannot be deleted.' });
    }

    // By uid only (matching by name also deleted other members with the same name)
    const summary = await deleteAccountData(context.appConfig, uid, { profilesDir });
    console.log(`[Account] Admin ${req.user.uid} deleted user ${uid}`, summary);

    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.post('/api/admin/logo', verifyToken, verifySuperAdmin, (req, res) => {
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

router.post('/api/send-email', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { to, subject, text, html } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ error: 'Missing required fields: to, subject' });
    }

    try {
      const allUsers = await listUserRecords(context.appConfig);
      const recipientUser = allUsers.find(u => u.email && u.email.toLowerCase() === String(to).toLowerCase());
      if (recipientUser) {
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

    console.log('Email sent: %s', info.messageId);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.get('/api/push/vapid-public-key', verifyToken, async (req, res) => {
  try {
    const publicKey = await getVapidPublicKey(context.appConfig);
    res.json({ publicKey });
  } catch (error) {
    console.error('Failed to get VAPID public key:', error);
    res.status(500).json({ error: 'Failed to retrieve VAPID key' });
  }
});

router.post('/api/push/subscribe', verifyToken, async (req, res) => {
  try {
    const { subscription, userAgent, installed } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription payload' });
    }
    const currentUid = req.user.uid || req.user.id;
    // Only the installed app (PWA) gets pushes, not a browser tab (iOS sends web push to home screen apps only anyway)
    await upsertPushSubscription(context.appConfig, currentUid, subscription, userAgent || req.headers['user-agent'] || '', installed === true);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save push subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

router.post('/api/push/unsubscribe', verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }
    await deletePushSubscription(context.appConfig, endpoint);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete push subscription:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// The Android app initialises Firebase with this public client config, so each instance can use its own project
router.get('/api/push/fcm', verifyToken, (req, res) => {
  const enabled = isFcmEnabled();
  res.json({ enabled, config: enabled ? getClientConfig() : null });
});

router.post('/api/push/fcm/subscribe', verifyToken, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || token.length > 4096) {
      return res.status(400).json({ error: 'Invalid FCM token' });
    }
    const currentUid = req.user.uid || req.user.id;
    await upsertFcmToken(context.appConfig, currentUid, token, typeof platform === 'string' && platform ? platform.slice(0, 32) : 'android');
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save FCM token:', error);
    res.status(500).json({ error: 'Failed to save FCM token' });
  }
});

router.post('/api/push/fcm/unsubscribe', verifyToken, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }
    const currentUid = req.user.uid || req.user.id;
    await deleteFcmToken(context.appConfig, token, currentUid);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete FCM token:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

router.post('/api/push/test', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    await sendPushToUser(context.appConfig, currentUid, {
      title: `${context.appConfig?.appName || 'Agora'} Test`,
      body: translate(requestLanguage(req), 'Push notifications are set up successfully!'),
      data: { url: '/' }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to send test push notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

module.exports = router;
