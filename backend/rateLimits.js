// How often one address may ask, per kind of request (express-rate-limit).
const { rateLimit } = require('express-rate-limit');

const MINUTE = 60 * 1000;

/** At most [max] requests per [windowMs] from one address; [error]: what the answer says once that is reached. */
const rateLimitOf = (windowMs, max, error) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  ...(error ? { message: { error } } : {})
});

const logoAssetRateLimit = rateLimitOf(MINUTE, 120);
const pageRateLimit = rateLimitOf(MINUTE, 240);
const setupRateLimit = rateLimitOf(15 * MINUTE, 100, 'Too many setup requests. Please try again in a few minutes.');
const authRateLimit = rateLimitOf(15 * MINUTE, 100, 'Too many sign-in attempts. Please wait a moment.');
const dbRateLimit = rateLimitOf(MINUTE, 180);
const protectedActionRateLimit = rateLimitOf(MINUTE, 300);
const adminRateLimit = rateLimitOf(MINUTE, 300);
const aiChatRateLimit = rateLimitOf(MINUTE, 20);

module.exports = {
  MINUTE,
  rateLimitOf,
  logoAssetRateLimit,
  pageRateLimit,
  setupRateLimit,
  authRateLimit,
  dbRateLimit,
  protectedActionRateLimit,
  adminRateLimit,
  aiChatRateLimit
};
