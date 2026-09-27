const express = require('express');
const crypto = require('crypto');
const {
  context,
  setupRateLimit,
  authRateLimit,
  validateSetupPayload,
  saveOptionalLogo,
  setRuntimeConfig,
  setAuthCookie,
  clearAuthCookie,
  verifyToken
} = require('../context');

const {
  DEFAULT_SYSTEM_STATE,
  generatePocketBaseCredentials,
  registerUser,
  createGroupRecord,
  listGroupRecords,
  getStateValue,
  upsertStateValue,
  updateUserRecord,
  upsertPeopleRecord,
  loginUser,
  isPlaceholderEmail,
  listUserRecords,
  claimUserAccount,
  listPeopleRecords,
  updateOwnPassword,
  resolveUserPermissions
} = require('../pocketbase');

const router = express.Router();

router.post('/api/setup', setupRateLimit, async (req, res) => {
  if (!context.setupMode) {
    return res.status(403).json({ error: 'Setup already complete.' });
  }

  try {
    const { appName, smtp, logoSvg, adminUser } = validateSetupPayload(req.body || {});
    const newConfig = {
      appName,
      smtp,
      pocketbase: generatePocketBaseCredentials()
    };

    const fs = require('fs');
    await fs.promises.writeFile(require('../context').configFile, JSON.stringify(newConfig, null, 2), 'utf8');
    await saveOptionalLogo(logoSvg);
    await setRuntimeConfig(newConfig);

    const auth = await registerUser({
      email: adminUser.email,
      password: adminUser.password,
      firstName: adminUser.firstName,
      lastName: adminUser.lastName,
      admin: true,
      owner: true,
      pays: true
    }, newConfig);

    let adminGroup = null;
    const allManagementPermissions = [
      'manage_finances',
      'manage_registration_code',
      'access_ai',
      'manage_mentoring',
      'manage_events'
    ];
    try {
      const existingGroups = await listGroupRecords(newConfig);
      adminGroup = existingGroups.find(g => g.name === 'Admin');
      if (!adminGroup) {
        adminGroup = await createGroupRecord(newConfig, {
          name: 'Admin',
          permissions: allManagementPermissions
        });
      }
    } catch (gErr) {
      console.warn('Could not create default Admin group in setup:', gErr.message);
    }

    const system = await getStateValue(newConfig, 'system', DEFAULT_SYSTEM_STATE);
    await upsertStateValue(newConfig, 'system', { ...system, ownerUid: auth.user.id, superAdminUid: auth.user.id });
    const ownerGroups = adminGroup ? [adminGroup.id] : [];
    await updateUserRecord(newConfig, auth.user.id, { admin: true, owner: true, superAdmin: true, pays: true, groups: ownerGroups });

    const personKey = auth.user.id;
    const memberSinceDate = adminUser.memberSince || new Date().toISOString().slice(0, 10);
    const fullName = `${adminUser.firstName} ${adminUser.lastName}`.trim();
    await upsertPeopleRecord(newConfig, personKey, {
      id: personKey,
      uid: auth.user.id,
      name: fullName,
      status: 'vollverdiener',
      memberSince: memberSinceDate,
      originalMemberSince: memberSinceDate,
      totalPaid: 0,
      pays: true,
      standingOrders: [],
      statusHistory: [{ status: 'vollverdiener', startDate: memberSinceDate }]
    });

    setAuthCookie(req, res, auth.token);

    res.json({
      success: true,
      message: 'Setup completed successfully.',
      token: auth.token,
      user: auth.user
    });
  } catch (error) {
    console.error('Error saving configuration:', error);
    res.status(400).json({ error: error.message || 'Failed to save configuration.' });
  }
});

router.post('/api/auth/login', authRateLimit, async (req, res) => {
  if (context.setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await context.runtimeReady;
  } catch {
    return res.status(503).json({ error: 'PocketBase is still starting. Please try again.' });
  }

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password.' });
  }

  try {
    const auth = await loginUser(email, password);
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(context.appConfig);
    } catch { /* ignore */ }
    const groupPerms = resolveUserPermissions(auth.user?.groups, allGroups);
    if (auth.user) {
      auth.user.permissions = groupPerms.permissions;
      auth.user.canManageFinances = groupPerms.canManageFinances;
      auth.user.canViewFinances = groupPerms.canViewFinances;
      auth.user.canManageRegistrationCode = groupPerms.canManageRegistrationCode === true;
      auth.user.canAccessAi = groupPerms.canAccessAi;
      auth.user.canParticipateMentoring = groupPerms.canParticipateMentoring;
      auth.user.canManageMentoring = groupPerms.canManageMentoring;
      auth.user.canManageEvents = groupPerms.canManageEvents === true;
    }
    setAuthCookie(req, res, auth.token);
    res.json(auth);
  } catch (error) {
    res.status(401).json({ error: error.message || 'Login failed.' });
  }
});

router.post('/api/auth/register', authRateLimit, async (req, res) => {
  if (context.setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await context.runtimeReady;
  } catch {
    return res.status(503).json({ error: 'PocketBase is still starting. Please try again.' });
  }

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  const inviteCode = String(req.body?.inviteCode || '').trim();
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password.' });
  }
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Vorname und Nachname sind erforderlich.' });
  }

  try {
    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const validInviteCode = String(system?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode);
    if (!inviteCode || inviteCode !== validInviteCode) {
      return res.status(403).json({ error: 'Ungültiger Registrierungscode.' });
    }

    const normFirst = firstName.toLowerCase();
    const normLast = lastName.toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();

    const existingUsers = await listUserRecords(context.appConfig);
    const matchingUnclaimedUser = existingUsers.find((u) => {
      const uFirst = String(u.firstName || '').trim().toLowerCase();
      const uLast = String(u.lastName || '').trim().toLowerCase();
      const uName = String(u.name || '').trim().toLowerCase();
      const isUnclaimed = u.isClaimed === false || isPlaceholderEmail(u.email);
      if (!isUnclaimed) return false;
      return (uFirst === normFirst && uLast === normLast) || (uName === `${normFirst} ${normLast}`.trim());
    });

    let auth;
    if (matchingUnclaimedUser) {
      await claimUserAccount(context.appConfig, matchingUnclaimedUser.id, email, password);
      await updateUserRecord(context.appConfig, matchingUnclaimedUser.id, {
        firstName,
        lastName,
        name: fullName
      });
      auth = await loginUser(email, password);

      const people = await listPeopleRecords(context.appConfig);
      const linkedPerson = people.find(p => p.uid === matchingUnclaimedUser.id || (p.name && p.name.trim().toLowerCase() === fullName.toLowerCase()));
      if (linkedPerson) {
        if (!linkedPerson.uid || linkedPerson.uid !== matchingUnclaimedUser.id) {
          await upsertPeopleRecord(context.appConfig, linkedPerson.personKey, { ...(linkedPerson.data || {}), uid: matchingUnclaimedUser.id, name: fullName });
        }
      }
    } else {
      auth = await registerUser({ email, password, firstName, lastName, isClaimed: true }, context.appConfig);

      const personKey = auth.user.id;
      const today = new Date().toISOString().slice(0, 10);
      await upsertPeopleRecord(context.appConfig, personKey, {
        id: personKey,
        uid: auth.user.id,
        name: fullName,
        status: 'vollverdiener',
        memberSince: today,
        originalMemberSince: today,
        totalPaid: 0,
        pays: true,
        standingOrders: [],
        statusHistory: [{ status: 'vollverdiener', startDate: today }]
      });
    }

    const newCode = String(crypto.randomInt(100000, 1000000));
    await upsertStateValue(context.appConfig, 'system', { ...system, inviteCode: newCode });
    const { broadcastDataUpdate } = require('../context');
    broadcastDataUpdate();
    setAuthCookie(req, res, auth.token);
    res.json(auth);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Registration failed.' });
  }
});

router.get('/api/auth/me', authRateLimit, verifyToken, (req, res) => {
  setAuthCookie(req, res, req.authToken);
  res.json({ user: req.user, token: req.authToken });
});

router.post('/api/auth/logout', authRateLimit, (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});

router.post('/api/auth/password', authRateLimit, verifyToken, async (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const password = String(req.body?.password || '');

  if (!oldPassword) {
    return res.status(400).json({ error: 'Altes Passwort erforderlich.' });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    await updateOwnPassword(req.authToken, req.user.uid, oldPassword, password);
    clearAuthCookie(req, res);
    res.json({ success: true, loggedOut: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Failed to update password.' });
  }
});

module.exports = router;
