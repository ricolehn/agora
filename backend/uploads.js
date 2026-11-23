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

module.exports = { upload, logoUpload, profileUpload, eventImageUpload };
