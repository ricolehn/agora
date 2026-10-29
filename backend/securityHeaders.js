function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
  // Links to other sites only learn the address of this server, not the page (folder names, event ids …)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Only enforce HSTS when connection is verified HTTPS to prevent locking out plain HTTP users
  if (req.secure || (req.headers && req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = {
  securityHeadersMiddleware
};
