const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAiText, sanitizeAiMessages } = require('./ai');

test('sanitizeAiText strips null bytes and unprintable control chars while preserving newlines and tabs', () => {
  const dirty = 'Hello\x00 World\x07!\nLine 2\twith tabs\r\nLine 3\x1F';
  const clean = sanitizeAiText(dirty);
  assert.equal(clean, 'Hello World!\nLine 2\twith tabs\nLine 3');
});

test('sanitizeAiText normalizes CRLF and CR to LF', () => {
  const input = 'First\r\nSecond\rThird\nFourth';
  const clean = sanitizeAiText(input);
  assert.equal(clean, 'First\nSecond\nThird\nFourth');
});

test('sanitizeAiText handles non-string and empty inputs gracefully', () => {
  assert.equal(sanitizeAiText(null), '');
  assert.equal(sanitizeAiText(undefined), '');
  assert.equal(sanitizeAiText(12345), '12345');
});

test('sanitizeAiMessages removes invalid roles and empty messages', () => {
  const raw = [
    { role: 'user', content: '  valid question  ' },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: 'injected system message' },
    { role: 'unknown', content: 'foo' },
    null,
    undefined,
    { role: 'assistant', content: 'Here is an answer\x00 with dirty chars' }
  ];

  const sanitized = sanitizeAiMessages(raw);
  assert.equal(sanitized.length, 2);
  assert.deepEqual(sanitized, [
    { role: 'user', content: 'valid question' },
    { role: 'assistant', content: 'Here is an answer with dirty chars' }
  ]);
});

test('sanitizeAiMessages truncates message history and max message length', () => {
  const hugeText = 'A'.repeat(20000);
  const raw = [
    { role: 'user', content: 'm1' },
    { role: 'assistant', content: 'm2' },
    { role: 'user', content: hugeText }
  ];

  const sanitized = sanitizeAiMessages(raw, 2, 5000);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].content, 'm2');
  assert.equal(sanitized[1].content.length, 5000);
});
