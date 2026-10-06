const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePublicUrl, originOf, buildEmail } = require('./notify');

const fakeReq = (host, proto = 'https') => ({ get: (h) => (h === 'host' ? host : undefined), headers: { 'x-forwarded-proto': proto }, protocol: 'http' });

test('normalizePublicUrl accepts http(s) only and strips the trailing slash', () => {
  assert.equal(normalizePublicUrl('https://beta.example.org/'), 'https://beta.example.org');
  assert.equal(normalizePublicUrl(' https://example.org/app/ '), 'https://example.org/app');
  assert.equal(normalizePublicUrl(''), '');
  assert.equal(normalizePublicUrl('javascript:alert(1)'), null);
  assert.equal(normalizePublicUrl('https://user:pw@example.org'), null);
  assert.equal(normalizePublicUrl('not a url'), null);
});

test('originOf uses a plain request host and refuses forged ones', () => {
  assert.equal(originOf(fakeReq('agora.example.org')), 'https://agora.example.org');
  assert.equal(originOf(fakeReq('localhost:4001', 'http')), 'http://localhost:4001');
  assert.equal(originOf(fakeReq('evil.tld/phish?x=')), '');
  assert.equal(originOf(fakeReq('a b')), '');
  assert.equal(originOf(fakeReq('host', 'javascript')), 'http://host');
});

test('buildEmail escapes the content', () => {
  const { html, text } = buildEmail({ appName: 'Agora', recipientName: 'Max', heading: '<b>Hi</b>', lines: ['x < y'], rows: [['Von', '<script>']], url: 'https://a.org/#x' });
  assert.ok(!html.includes('<b>Hi</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(text.includes('https://a.org/#x'));
});
