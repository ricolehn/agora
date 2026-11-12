const express = require('express');
const { notifyUsers, financeManagers, originOf } = require('../notify');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const {
  context,
  dbRateLimit,
  authRateLimit,
  protectedActionRateLimit,
  verifyToken,
  verifyAdmin,
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
  normalizeDataPath,
  listRequestRecords,
  listPeopleRecords,
  loginUser,
  getFeeState,
  updateFeeResetState,
  updateFeeSchedule
} = require('../pocketbase');

const {
  parseDay,
  monthIndexOf,
  normalizeFeeResets,
  describeFeeResets,
  checkNewFeeReset,
  withLogEntry
} = require('../feeReset');

const {
  feesInMonth,
  feeScheduleVersion,
  withFeeChange,
  withoutFeeChange,
  withFeeLogEntry,
  checkFeeChange,
  checkFeeRemoval,
  describeFeeSchedule
} = require('../feeSchedule');

const { feeResetImpact, feeChangeImpact } = require('../derivedData');

const { toDateStr } = require('../utils/date');


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

    // The version this write is based on, checked again in the write queue (an empty one included: records from
    // before the version field)
    const updated = await upsertPeopleRecord(context.appConfig, id, nextValue, existing ? existing.updated || '' : null);
    broadcastDataUpdate();
    res.json({ value: updated.data, version: updated.updated });
  } catch (error) {
    console.error('Transaction endpoint error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Transaction failed' });
  }
});

// --- CALDERA: a fresh start for all fee accounts on a chosen day (feeReset.js) ---
// Open fees are dropped on that day, credit is carried over, and from then on months and payments count anew. Every
// signed-in member may read the days (their own fee account counts from one). Setting or taking back a day is for
// system admins only - not for treasurers - and needs the day a second time (typed in the dialog) and the admin's
// own password: no stray tap, replayed request or session left open starts it.

// Who set what and the logs of changes: for those who see the finances or run the instance
const isFeeInsider = (user) => user?.admin === true || user?.canViewFinances === true;

function feeResetAnswer(state, user) {
  const today = toDateStr(new Date());
  const insider = isFeeInsider(user);
  return {
    today,
    resets: describeFeeResets(state.resets, today, { withDetails: insider }),
    ...(insider ? { log: state.log } : {})
  };
}

// A call that is refused with a reason for the admin (anything else that goes wrong only says that it failed)
const refuse = (status, message) => Object.assign(new Error(message), { status, refused: true });
const noSuchFeeReset = () => refuse(404, 'There is no fresh start on this day.');

/** The day of a confirmed call, or null after answering why it is not confirmed. */
async function confirmedFeeResetDay(req, res) {
  const date = parseDay(req.body?.date);
  if (!date) {
    res.status(400).json({ error: 'Please choose a valid day for the fresh start.' });
    return null;
  }
  if (req.body?.confirmDate !== date) {
    res.status(400).json({ error: 'Please confirm the day by entering it again.' });
    return null;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    res.status(400).json({ error: 'Please confirm with your password.' });
    return null;
  }
  try {
    await loginUser(req.user.rawEmail || req.user.email, password);
  } catch (error) {
    // Only a sign-in that is turned down says the password is wrong; a database that does not answer says it failed
    if (!(error?.status >= 400 && error.status < 500)) throw error;
    res.status(403).json({ error: 'The password is not correct.' });
    return null;
  }
  return date;
}

function answerFeeResetError(res, error, fallback) {
  if (error.refused) return res.status(error.status).json({ error: error.message });
  console.error(`${fallback}:`, error);
  return res.status(500).json({ error: fallback });
}

const actingAdmin = (user) => ({
  by: String(user.uid || user.id || ''),
  byName: user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim()
});

// The fresh starts of a fee state, as feeResetAnswer reads them
const freshStartsOf = (fees) => ({ resets: fees.resets, log: fees.resetLog });

router.get('/api/fee-reset', dbRateLimit, verifyToken, async (req, res) => {
  try {
    res.json(feeResetAnswer(freshStartsOf(await getFeeState(context.appConfig)), req.user));
  } catch (error) {
    answerFeeResetError(res, error, 'The fresh start could not be loaded.');
  }
});

// What a day would change (or taking one back), in numbers, before anything is confirmed
router.get('/api/admin/fee-reset/preview', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const today = toDateStr(new Date());
    const [fees, people] = await Promise.all([getFeeState(context.appConfig), listPeopleRecords(context.appConfig)]);
    let date;
    if (req.query.remove === '1') {
      date = parseDay(req.query.date);
      if (!date || !fees.resets.some((reset) => reset.date === date)) throw noSuchFeeReset();
    } else {
      const check = checkNewFeeReset(fees.resets, req.query.date, today);
      if (check.error) throw refuse(check.status, check.error);
      date = check.date;
    }
    res.json(feeResetImpact(people.map((record) => record.data), fees.settings, fees.resets, date, today, fees.schedule));
  } catch (error) {
    answerFeeResetError(res, error, 'The fresh start could not be loaded.');
  }
});

router.post('/api/admin/fee-reset', authRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const today = toDateStr(new Date());
    // What is wrong with the day itself is said before the password is asked for
    const early = checkNewFeeReset((await getFeeState(context.appConfig)).resets, req.body?.date, today);
    if (early.error) throw refuse(early.status, early.error);
    const date = await confirmedFeeResetDay(req, res);
    if (!date) return;
    const { by, byName } = actingAdmin(req.user);
    const at = Date.now();
    const state = await updateFeeResetState(context.appConfig, (current, schedule) => {
      const check = checkNewFeeReset(current.resets, date, today);
      if (check.error) throw refuse(check.status, check.error);
      // Kept with the day: what the month before it costs as it is set (the fees over time say what every month
      // costs, feeSchedule.js - a fresh start changes the price of none)
      const feesBefore = feesInMonth(schedule, monthIndexOf(date) - 1);
      return {
        resets: normalizeFeeResets([...current.resets, { date, feesBefore, setAt: at, setBy: by, setByName: byName }]),
        log: withLogEntry(current.log, { action: 'set', date, at, by, byName })
      };
    });
    console.log(`[Finance] Admin ${by} set a fresh start of the fee accounts for ${date}`);
    broadcastDataUpdate();
    res.json({ success: true, ...feeResetAnswer(state, req.user) });
  } catch (error) {
    answerFeeResetError(res, error, 'The fresh start could not be saved.');
  }
});

router.post('/api/admin/fee-reset/remove', authRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const known = (await getFeeState(context.appConfig)).resets;
    if (!known.some((reset) => reset.date === req.body?.date)) throw noSuchFeeReset();
    const date = await confirmedFeeResetDay(req, res);
    if (!date) return;
    const { by, byName } = actingAdmin(req.user);
    const state = await updateFeeResetState(context.appConfig, (current) => {
      if (!current.resets.some((reset) => reset.date === date)) throw noSuchFeeReset();
      return {
        resets: current.resets.filter((reset) => reset.date !== date),
        log: withLogEntry(current.log, { action: 'removed', date, at: Date.now(), by, byName })
      };
    });
    console.log(`[Finance] Admin ${by} took back the fresh start of the fee accounts for ${date}`);
    broadcastDataUpdate();
    res.json({ success: true, ...feeResetAnswer(state, req.user) });
  } catch (error) {
    answerFeeResetError(res, error, 'The fresh start could not be saved.');
  }
});

// --- CALDERA: the monthly fees over time (feeSchedule.js) ---
// Every change of the fees says from which month it counts; the months before keep the old fees. Every signed-in
// member may read what the months cost (their own fee account is charged it). Setting, editing or taking back a
// change is for system admins - like the fee settings before - and only as it was checked: a call names the version
// of the history its numbers were shown for, so nothing is saved on top of a change someone else made in between.

function feeAnswer(fees, user) {
  const today = toDateStr(new Date());
  const insider = isFeeInsider(user);
  return {
    today,
    ...describeFeeSchedule(fees.schedule, today, { withDetails: insider }),
    ...(insider ? { log: fees.log, version: feeScheduleVersion(fees.schedule) } : {})
  };
}

/**
 * The history a call asks for: { after, entry } - the fees over time with the change, and its line in the log - or
 * the refusal why not. [body]: { from, fees, replaces } (from null: the fees from the beginning; replaces: the month
 * of the change that is edited or moved), or { from, remove: true } to take the change of that month back.
 */
function wantedFees(schedule, body, today, who = {}) {
  if (body?.remove === true) {
    const check = checkFeeRemoval(schedule, body.from);
    if (check.error) throw refuse(check.status, check.error);
    return {
      after: withoutFeeChange(schedule, check.from),
      entry: { action: 'removed', from: check.from, fees: feesInMonth(schedule, check.from), movedFrom: null }
    };
  }
  const check = checkFeeChange(schedule, body, today);
  if (check.error) throw refuse(check.status, check.error);
  const { from, replaces } = check.change;
  const after = withFeeChange(schedule, { ...check.change, ...who });
  return {
    after,
    entry: { action: 'set', from, fees: from === null ? after.base : feesInMonth(after, from), movedFrom: replaces && replaces !== from ? replaces : null }
  };
}

router.get('/api/fees', dbRateLimit, verifyToken, async (req, res) => {
  try {
    res.json(feeAnswer(await getFeeState(context.appConfig), req.user));
  } catch (error) {
    answerFeeResetError(res, error, 'The fees could not be loaded.');
  }
});

// What a change would do, in numbers, before anything is saved: who owes more or less today, and which months
// cost something else. The version in the answer goes back with the call that saves it
router.post('/api/admin/fees/preview', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const today = toDateStr(new Date());
    const [fees, people] = await Promise.all([getFeeState(context.appConfig), listPeopleRecords(context.appConfig)]);
    const { after, entry } = wantedFees(fees.schedule, req.body, today);
    res.json({
      from: entry.from,
      remove: entry.action === 'removed',
      movedFrom: entry.movedFrom,
      ...feeChangeImpact(people.map((record) => record.data), fees.resets, fees.schedule, after, today),
      version: feeScheduleVersion(fees.schedule)
    });
  } catch (error) {
    answerFeeResetError(res, error, 'The fees could not be loaded.');
  }
});

async function changeFees(req, res, body) {
  try {
    const today = toDateStr(new Date());
    const { by, byName } = actingAdmin(req.user);
    const at = Date.now();
    let saved = null;
    const state = await updateFeeSchedule(context.appConfig, (current) => {
      if (typeof body.version !== 'string' || !body.version) throw refuse(400, 'Please check the change of the fees before saving it.');
      if (body.version !== feeScheduleVersion(current.schedule)) throw refuse(409, 'The fees were changed in the meantime. Please check them again.');
      const { after, entry } = wantedFees(current.schedule, body, today, { setAt: at, setBy: by, setByName: byName });
      saved = entry;
      return { schedule: after, log: withFeeLogEntry(current.log, { ...entry, at, by, byName }) };
    });
    console.log(`[Finance] Admin ${by} ${saved.action === 'removed' ? 'took back' : 'set'} the fees from ${saved.from || 'the beginning'}`);
    broadcastDataUpdate();
    res.json({ success: true, ...feeAnswer(state, req.user) });
  } catch (error) {
    answerFeeResetError(res, error, 'The fees could not be saved.');
  }
}

router.post('/api/admin/fees', protectedActionRateLimit, verifyToken, verifyAdmin, (req, res) => (
  changeFees(req, res, { from: req.body?.from, fees: req.body?.fees, replaces: req.body?.replaces, version: req.body?.version })
));

router.post('/api/admin/fees/remove', protectedActionRateLimit, verifyToken, verifyAdmin, (req, res) => (
  changeFees(req, res, { from: req.body?.from, remove: true, version: req.body?.version })
));

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

// Writes one after another, each through a temporary file: two uploads at once used to write the file in parallel
// (an older state could win, or a half-written file be read after a restart)
let receiptOwnersWrite = Promise.resolve();
function rememberReceiptOwner(filename, uid) {
  if (!filename || !uid) return;
  const owners = loadReceiptOwners();
  owners[filename] = uid;
  receiptOwnersWrite = receiptOwnersWrite.then(async () => {
    const temp = `${receiptOwnersFile}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(owners), 'utf8');
    await fs.promises.rename(temp, receiptOwnersFile);
  }).catch((err) => console.warn('[Receipts] Could not store the uploader:', err.message));
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
    const { reqType } = req.body || {};
    const typeLabels = { payment: 'Payment', status: 'Status change', expense: 'Expense', standing_order: 'Standing order' };
    if (!typeLabels[reqType]) {
      return res.status(400).json({ error: 'Unknown request type' });
    }
    // Only about a request the member really just filed, with the name stored in it - the text comes from the
    // server, never from the caller (anyone could otherwise send any name to every treasurer)
    const uid = req.user.uid || req.user.id;
    const recent = Date.now() - 15 * 60 * 1000;
    const filed = (await listRequestRecords(context.appConfig, { orderByChild: 'userId', equalTo: uid }))
      .filter((r) => r.status === 'pending' && r.type === reqType && Number(r.timestamp || r.requestKey) >= recent)
      .sort((a, b) => Number(b.timestamp || b.requestKey) - Number(a.timestamp || a.requestKey))[0];
    if (!filed) return res.json({ success: true, notified: 0 });
    const personName = filed.personName || req.user.name || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
    const typeOf = (tr) => tr(typeLabels[reqType]);
    // Admins, owner and treasurers (groups with manage_finances), each over the channels they chose and in their language
    const recipients = (await financeManagers(context.appConfig)).filter((u) => u.id !== req.user?.uid);
    await notifyUsers(context.appConfig, recipients, 'finances', {
      origin: originOf(req),
      // "New request: Payment" - "From Ben Fischer"
      push: (tr) => ({
        title: tr('New request: {type}', { type: typeOf(tr) }),
        body: tr('From {name}', { name: personName }),
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
