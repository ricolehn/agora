const test = require('node:test');
const assert = require('node:assert/strict');
const { securityHeadersMiddleware } = require('./securityHeaders');

test('sets required security headers on response object for plain HTTP requests', () => {
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  const req = { secure: false, headers: {} };
  securityHeadersMiddleware(req, res, next);

  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(headers['X-XSS-Protection'], '0');
  assert.equal(headers['Strict-Transport-Security'], undefined);
  assert.equal(nextCalled, true);
});

test('sets Strict-Transport-Security header when request is HTTPS via req.secure', () => {
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  const req = { secure: true, headers: {} };
  securityHeadersMiddleware(req, res, next);

  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(nextCalled, true);
});

test('sets Strict-Transport-Security header when request is HTTPS via x-forwarded-proto header', () => {
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  const req = { secure: false, headers: { 'x-forwarded-proto': 'https' } };
  securityHeadersMiddleware(req, res, next);

  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(nextCalled, true);
});
