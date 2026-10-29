// AI chat: what the server passes on from the provider's stream (backend/ai.js)
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { aiStreamEvents } = require('../backend/ai');
const chunk = delta => ({ choices: [{ delta }] });

describe('AI stream events (backend/ai.js)', () => {
  test('answer text is passed on as content', () => {
    assert.deepEqual(aiStreamEvents(chunk({ content: 'Hallo' })), [{ content: 'Hallo' }]);
  });

  test('the thought process arrives under every common name', () => {
    assert.deepEqual(aiStreamEvents(chunk({ reasoning_content: 'a' })), [{ reasoning: 'a' }], 'DeepSeek / vLLM / LM Studio');
    assert.deepEqual(aiStreamEvents(chunk({ reasoning: 'b' })), [{ reasoning: 'b' }], 'OpenRouter / Ollama');
    assert.deepEqual(aiStreamEvents(chunk({ thinking: 'c' })), [{ reasoning: 'c' }], 'local servers');
    assert.deepEqual(aiStreamEvents(chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'd' }, { type: 'reasoning.summary', summary: 'e' }] })), [{ reasoning: 'de' }], 'OpenRouter details');
  });

  test('thoughts and answer in one chunk keep their order, empty parts are left out', () => {
    assert.deepEqual(aiStreamEvents(chunk({ reasoning: 'x', content: 'y' })), [{ reasoning: 'x' }, { content: 'y' }]);
    assert.deepEqual(aiStreamEvents(chunk({ content: '', reasoning: null, role: 'assistant' })), []);
    assert.deepEqual(aiStreamEvents({ choices: [{ delta: {}, finish_reason: 'stop' }] }), []);
  });

  test('an error inside the stream is reported, not swallowed', () => {
    assert.deepEqual(aiStreamEvents({ error: { message: 'Rate limit reached' } }), [{ error: 'Rate limit reached' }]);
    assert.deepEqual(aiStreamEvents({ error: 'overloaded' }), [{ error: 'overloaded' }]);
  });

  test('anything else is ignored', () => {
    assert.deepEqual(aiStreamEvents(null), []);
    assert.deepEqual(aiStreamEvents('text'), []);
    assert.deepEqual(aiStreamEvents({}), []);
  });
});
