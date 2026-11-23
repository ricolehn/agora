// Files people send: receipts (pictures or PDFs) and event pictures go to their folders under random names, the logo
// and profile pictures stay in memory for their routes to check and store.
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { uploadDir, eventImagesDir } = require('./context');

// Random, unguessable file names (the old "<name>-<date>-<n>" names could be enumerated and collided)
const randomFileName = (file) => `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, randomFileName(file))
});
const eventImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, eventImagesDir),
  filename: (req, file, cb) => cb(null, randomFileName(file))
});
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
const imageFileFilter = (errorMessage, { pdf = false } = {}) => (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const isImage = IMAGE_MIME_TYPES.includes(file.mimetype) && IMAGE_EXTENSIONS.includes(ext);
  const isPdf = pdf && file.mimetype === 'application/pdf' && ext === '.pdf';
  if (isImage || isPdf) {
    cb(null, true);
  } else {
    cb(new Error(errorMessage));
  }
};
// Receipts: pictures or PDFs (an invoice comes as a PDF; the apps offer both - a PDF was refused here)
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: imageFileFilter('Invalid file type. Only JPG, PNG, WEBP, GIF, HEIC, HEIF and PDF are allowed.', { pdf: true })
});
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});
const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG files are accepted for profile pictures.'));
    }
  }
});
const eventImageUpload = multer({
  storage: eventImageStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: imageFileFilter('Only image files (JPG, PNG, WebP, HEIC) are allowed.')
});

/**
 * The step of a route that takes the one file of the form field [field] through [uploader]: it answers a failed upload
 * itself (400) - with [tooLarge] for a file over the limit, the upload's own message ([failed] without one, or what
 * [failure] makes of the error) and [missing] when no file came - so the route's handler finds the file in req.file.
 * A step of its own: API v2 runs the old routes' steps in turn (v2/http.js runSteps).
 */
function receiveFile(uploader, field, { tooLarge, failed, missing, failure = (error) => error.message || failed }) {
  return (req, res, next) => uploader.single(field)(req, res, (error) => {
    if (error) {
      const tooBig = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? tooLarge : failure(error) });
    }
    if (!req.file) return res.status(400).json({ error: missing });
    next();
  });
}

module.exports = { upload, logoUpload, profileUpload, eventImageUpload, receiveFile };
