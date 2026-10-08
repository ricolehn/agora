const express = require('express');
const { notifyUsers, financeManagers, originOf } = require('../notify');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const {
  context,
  dbRateLimit,
  protectedActionRateLimit,
  verifyToken,
  uploadDir,
  dataDir,
  upload,
  verifyOptionalUser,
  readLogicalPath,
  writeLogicalPath,
  removeLogicalPath,
  broadcastDataUpdate
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
  normalizeDataPath
} = require('../pocketbase');


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
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'set', { origin: originOf(req) });
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to write data' });
  }
});

router.patch('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'patch', { origin: originOf(req) });
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
      return res.status(403).json({ error: 'Finance access rights required' });
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
      return res.status(403).json({ error: 'Finance access rights required' });
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
      return res.status(403).json({ error: 'Finance management rights required' });
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
    rememberReceiptOwner(req.file.filename, req.user.uid);
    res.json({ filename: req.file.filename });
  });
});

// Who uploaded which receipt: a member may only see receipts they uploaded themselves (a filename written into
// their own request is not proof - request data is written by the member)
const receiptOwnersFile = path.join(dataDir, 'receipt-owners.json');
let receiptOwners = null;

function loadReceiptOwners() {
  if (receiptOwners) return receiptOwners;
  try {
    receiptOwners = JSON.parse(fs.readFileSync(receiptOwnersFile, 'utf8')) || {};
  } catch {
    receiptOwners = {};
  }
  return receiptOwners;
}

function rememberReceiptOwner(filename, uid) {
  if (!filename || !uid) return;
  const owners = loadReceiptOwners();
  owners[filename] = uid;
  fs.promises.writeFile(receiptOwnersFile, JSON.stringify(owners), 'utf8')
    .catch((err) => console.warn('[Receipts] Could not store the uploader:', err.message));
}

const ownsReceipt = (user, filename) => loadReceiptOwners()[filename] === user.uid;

router.get('/api/receipts/:filename', protectedActionRateLimit, verifyToken, async (req, res) => {
  const filename = path.basename(String(req.params.filename || ''));
  const filePath = path.resolve(path.join(uploadDir, filename));
  if (!filePath.startsWith(path.resolve(uploadDir) + path.sep)) {
    return res.status(403).send('Forbidden');
  }
  const user = req.user;
  const allowed = user.canViewFinances || user.canManageFinances || user.admin || user.owner || ownsReceipt(user, filename);
  if (!allowed) return res.status(403).send('Forbidden');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Every member can trigger it (after filing a request): a few per quarter hour are enough
const notifyAdminsRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.post('/api/notify-admins', notifyAdminsRateLimit, verifyToken, async (req, res) => {
  try {
    const { reqType, personName } = req.body;
    if (!reqType || !personName) {
      return res.status(400).json({ error: 'Missing required fields: reqType, personName' });
    }

    const typeLabels = { payment: 'Payment', status: 'Status change', expense: 'Expense', standing_order: 'Standing order' };
    const typeOf = (tr) => (typeLabels[reqType] ? tr(typeLabels[reqType]) : reqType);
    // Admins, owner and treasurers (groups with manage_finances), each over the channels they chose and in their language
    const recipients = (await financeManagers(context.appConfig)).filter((u) => u.id !== req.user?.uid);
    await notifyUsers(context.appConfig, recipients, 'finances', {
      origin: originOf(req),
      push: (tr) => ({
        title: tr('Treasury: {type}', { type: typeOf(tr) }),
        body: tr('{name} filed a request.', { name: personName }),
        data: { url: '/#requests' }
      }),
      email: (tr) => ({
        subject: tr('New request: {type}', { type: typeOf(tr) }),
        heading: tr('New request to the treasury'),
        lines: [tr('{name} filed a request. Please review it in the app.', { name: personName })],
        rows: [[tr('Kind'), typeOf(tr)], [tr('From'), personName]],
        actionLabel: tr('Review the request'),
        path: '/#finances',
        accent: '#d97706'
      })
    });
    res.json({ success: true, notified: recipients.length });
  } catch (error) {
    console.error('Failed to notify finance managers:', error);
    res.status(500).json({ error: 'Failed to notify admins' });
  }
});

module.exports = router;
