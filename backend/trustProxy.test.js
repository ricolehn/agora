const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTrustProxySetting } = require('./trustProxy');

test('defaults to local and private proxy ranges when TRUST_PROXY is unset', () => {
  assert.equal(resolveTrustProxySetting(undefined), 'loopback, linklocal, uniquelocal');
});

test('accepts boolean trust proxy values from the environment', () => {
  assert.equal(resolveTrustProxySetting('true'), true);
  assert.equal(resolveTrustProxySetting('false'), false);
});

test('accepts numeric hop counts from the environment', () => {
  assert.equal(resolveTrustProxySetting('1'), 1);
});

test('preserves explicit proxy range strings', () => {
  assert.equal(resolveTrustProxySetting('loopback, linklocal'), 'loopback, linklocal');
});
