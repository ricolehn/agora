const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  context,
  verifyToken,
  protectedActionRateLimit,
  profileUpload,
  profilesDir
} = require('../context');

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

  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'no-store');
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

module.exports = router;
