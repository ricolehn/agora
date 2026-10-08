const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  context,
  verifyToken,
  protectedActionRateLimit,
  profileUpload,
  profilesDir,
  verifyAdmin
} = require('../context');
const { notifyUsers, adminUsers, originOf } = require('../notify');
const { buildReport, storeReport, listReports, resolveReport } = require('../contentReports');

const { listGroupRecords } = require('../pocketbase');

const router = express.Router();

router.post('/api/profile/picture', protectedActionRateLimit, verifyToken, (req, res) => {
  profileUpload.single('picture')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 5MB)' });
      }
      return res.status(400).json({ error: uploadError.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
      const uid = req.user.uid;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      const destPath = path.join(profilesDir, `${uid}.jpg`);
      await fs.promises.writeFile(destPath, req.file.buffer);
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to save profile picture:', err);
      res.status(500).json({ error: 'Failed to save profile picture' });
    }
  });
});

router.get('/api/profile/picture/:uid', protectedActionRateLimit, verifyToken, (req, res) => {
  const uid = req.params.uid;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
    return res.status(400).send('Invalid user ID');
  }
  const normalizedProfilesDir = path.resolve(profilesDir);
  const filePath = path.resolve(path.join(normalizedProfilesDir, `${uid}.jpg`));

  if (path.relative(normalizedProfilesDir, filePath).startsWith('..')) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }

  // Lists render one avatar per member and re-render on every update: let the browser keep the answer
  // (picture or "none") for a few minutes. The uploader refreshes their own entry right after an upload.
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(204).end();
  }
});

router.get('/api/groups', verifyToken, async (req, res) => {
  try {
    const groups = await listGroupRecords(context.appConfig);
    res.json(groups.map(g => ({
      id: g.id,
      name: g.name
    })));
  } catch (error) {
    console.error('Failed to list groups:', error);
    res.status(500).json({ error: error.message || 'Failed to list groups' });
  }
});

// Report an AI reply or a chat message (Google Play AIGC / UGC policies); admins are notified
router.post('/api/reports', protectedActionRateLimit, verifyToken, async (req, res) => {
  const { report, error } = buildReport(req.body, req.user);
  if (error) return res.status(400).json({ error });
  try {
    await storeReport(context.appConfig, report);
    adminUsers(context.appConfig).then((admins) => notifyUsers(context.appConfig, admins.filter((u) => u.id !== req.user?.uid), 'reports', {
      origin: originOf(req),
      push: (tr) => ({ title: report.type === 'ai' ? tr('Reported AI answer') : tr('Reported chat message'), body: report.reason || report.content.slice(0, 120), data: { url: '/#settings' } }),
      email: (tr) => ({
        subject: report.type === 'ai' ? tr('Reported AI answer') : tr('Reported chat message'),
        heading: report.type === 'ai' ? tr('Reported AI answer') : tr('Reported chat message'),
        lines: [tr('Some content was reported and is waiting for your review.')],
        rows: [[tr('Reason'), report.reason || '–']],
        actionLabel: tr('Review reports'),
        path: '/#settings',
        accent: '#dc2626'
      })
    })).catch((err) => console.warn('[Notify] report:', err.message));
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Failed to store report:', err);
    res.status(500).json({ error: 'The report could not be saved.' });
  }
});

router.get('/api/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
  try {
    res.json({ reports: await listReports(context.appConfig) });
  } catch (err) {
    res.status(500).json({ error: 'Reports could not be loaded.' });
  }
});

router.post('/api/admin/reports/:id/resolve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const report = await resolveReport(context.appConfig, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: 'The report could not be updated.' });
  }
});

module.exports = router;
