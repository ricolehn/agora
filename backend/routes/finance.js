const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  context,
  dbRateLimit,
  protectedActionRateLimit,
  verifyToken,
  uploadDir,
  upload,
  verifyOptionalUser,
  readLogicalPath,
  writeLogicalPath,
  removeLogicalPath,
  broadcastDataUpdate,
  escapeHtml,
  userWantsNotification
} = require('../context');

const {
  aggregateStats
} = require('../stats');

const {
  getPaginatedTransactions
} = require('../transactions');

const {
  getPeopleRecord,
  upsertPeopleRecord,
  listUserRecords,
  normalizeDataPath
} = require('../pocketbase');

const {
  sendPushToAdmins
} = require('../pushNotifications');

const router = express.Router();

router.get('/api/db', dbRateLimit, async (req, res) => {
  if (context.setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await context.runtimeReady;
    const authState = await verifyOptionalUser(req);
    const result = await readLogicalPath(req.query.path, {
      orderByChild: req.query.orderByChild,
      equalTo: req.query.equalTo
    }, authState?.user || null);

    if (req.query.raw === '1') {
      return res.json(result);
    }
    return res.json(result.value);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to read data' });
  }
});

router.put('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'set');
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to write data' });
  }
});

router.patch('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'patch');
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to update data' });
  }
});

router.delete('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await removeLogicalPath(req.body?.path, req.user);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to delete data' });
  }
});

router.get('/api/stats', dbRateLimit, verifyToken, async (req, res) => {
  try {
    if (!req.user.canViewFinances) {
      return res.status(403).json({ error: 'Finanzzugriffsrechte erforderlich' });
    }
    const stats = await aggregateStats(context.appConfig);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch stats' });
  }
});

router.get('/api/transactions', dbRateLimit, verifyToken, async (req, res) => {
  try {
    if (!req.user.canViewFinances) {
      return res.status(403).json({ error: 'Finanzzugriffsrechte erforderlich' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = parseInt(req.query.perPage, 10) || 150;
    const search = req.query.search || '';
    const transactions = await getPaginatedTransactions(context.appConfig, page, perPage, search);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch transactions' });
  }
});

router.post('/api/db/transaction', dbRateLimit, verifyToken, async (req, res) => {
  try {
    const targetPath = normalizeDataPath(req.body?.path);
    const [root, id] = targetPath.split('/');
    if (root !== 'people' || !id) {
      return res.status(400).json({ error: 'Only people transactions are supported.' });
    }

    const existing = await getPeopleRecord(context.appConfig, id);
    const currentVersion = existing?.updated || null;
    if ((req.body?.currentVersion || null) !== currentVersion) {
      return res.status(409).json({ error: 'Conflict' });
    }

    const nextValue = req.body?.value;
    if (!req.user.canManageFinances) {
      return res.status(403).json({ error: 'Finanzverwaltungsrechte erforderlich' });
    }

    const updated = await upsertPeopleRecord(context.appConfig, id, nextValue, currentVersion);
    broadcastDataUpdate();
    res.json({ value: updated.data, version: updated.updated });
  } catch (error) {
    console.error('Transaction endpoint error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Transaction failed' });
  }
});

router.post('/api/upload', protectedActionRateLimit, verifyToken, (req, res) => {
  upload.single('receipt')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }
      return res.status(400).json({ error: error.message || 'File upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({ filename: req.file.filename });
  });
});

router.get('/api/receipts/:filename', protectedActionRateLimit, verifyToken, (req, res) => {
  const filePath = path.resolve(path.join(uploadDir, req.params.filename));
  const normalizedUploadDir = path.resolve(uploadDir);

  if (!filePath.startsWith(normalizedUploadDir + path.sep)) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

router.post('/api/notify-admins', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const { reqType, personName } = req.body;
    if (!reqType || !personName) {
      return res.status(400).json({ error: 'Missing required fields: reqType, personName' });
    }

    const typeLabels = { payment: 'Zahlung', status: 'Status', expense: 'Ausgabe', standing_order: 'Dauerauftrag' };
    const reqTypeLabel = typeLabels[reqType] || reqType;

    sendPushToAdmins(context.appConfig, {
      title: `Kasse: ${reqTypeLabel}`,
      body: `${personName} hat einen Antrag eingereicht.`,
      data: { url: '/#requests' }
    }).catch(err => console.warn('[WebPush] Failed sending push to admins:', err.message));

    const allUsers = await listUserRecords(context.appConfig);
    const adminEmails = allUsers
      .filter((record) => (record.admin === true || record.owner === true || record.superAdmin === true) && record.email && userWantsNotification(record, 'finances'))
      .map((record) => record.email);

    if (adminEmails.length === 0) {
      return res.status(200).json({ message: 'No admins found to notify' });
    }

    if (!context.transporter || !context.appConfig?.smtp?.user) {
      return res.status(200).json({ skipped: true, message: 'SMTP not configured' });
    }

    const info = await context.transporter.sendMail({
      from: `"${context.appConfig.appName}" <${context.appConfig.smtp.user}>`,
      to: adminEmails,
      subject: `Neue Anfrage bei ${context.appConfig.appName}`,
      text: `Eine neue Anfrage (${reqTypeLabel}) von ${personName} wurde eingereicht.\n\nBitte prüfe die Anfrage in der App.`,
      html: `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
            <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
              <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(context.appConfig.appName)}</h1>
            </div>
            <div style="padding: 40px 30px;">
              <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; color: #1A202C;">Neue Anfrage</h2>
              <p style="margin: 0 0 15px 0; font-size: 16px; line-height: 1.5;">Eine neue Anfrage vom Typ <strong style="color: #14B8A6;">${escapeHtml(reqTypeLabel)}</strong> wurde eingereicht.</p>
              <p style="margin: 0 0 25px 0; font-size: 16px; line-height: 1.5;">Person: <strong style="color: #4A5568;">${escapeHtml(personName)}</strong></p>
              <div style="background-color: #F1F5F9; border-left: 4px solid #94A3B8; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
                  <p style="margin: 0; color: #475569; font-size: 16px;">Bitte prüfe die Anfrage in der App.</p>
              </div>
            </div>
          </div>
        </div>
      `
    });

    console.log('Admin notification sent successfully: %s', info.messageId);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('Error notifying admins:', error);
    res.status(500).json({ error: 'Failed to notify admins' });
  }
});

module.exports = router;
