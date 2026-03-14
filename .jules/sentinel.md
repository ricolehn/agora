
## 2024-05-24 - Unrestricted File Uploads via Multer
**Vulnerability:** The `/api/upload` endpoint for receipts allowed any file type (including `.html`, `.sh`) and had no file size limit because `multer` was configured only with a `storage` engine.
**Learning:** By default, Express/Multer does not enforce file size constraints or type validation. Statically serving these uploaded files via `res.sendFile()` implicitly trusts the unvalidated extension, enabling Stored XSS. Additionally, omitting `limits.fileSize` introduces a DoS risk by allowing disk space exhaustion.
**Prevention:** Always configure `multer` with a `fileFilter` to strictly whitelist allowed MIME types and extensions. Always define `limits: { fileSize: MAX_BYTES }`. Always wrap `upload.single()` inside the route handler rather than as top-level middleware to securely catch and format `multer` errors without leaking stack traces.
