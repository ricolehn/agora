function resolveTrustProxySetting(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'loopback, linklocal, uniquelocal';
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }

  return String(value).trim();
}

module.exports = {
  resolveTrustProxySetting
};
