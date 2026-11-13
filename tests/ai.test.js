// AI chat: what the server passes on from the provider's stream (backend/ai.js)
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { aiStreamEvents, addToolCallParts, reasoningKeyOf, aiEffortOf, AI_EFFORT_LEVELS } = require('../backend/ai');
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

describe('AI tool calls in the stream (backend/ai.js)', () => {
  const calls = (...chunks) => [...chunks.reduce((map, delta) => addToolCallParts(map, chunk(delta), ['expenses', 'events']), new Map()).values()];

  test('OpenAI: pieces by index - the name once, the arguments in parts, several calls side by side', () => {
    assert.deepEqual(calls(
      { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'expenses', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"from":' } }] },
      { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'events', arguments: '{}' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"2019"}' } }] }
    ), [{ id: 'call_a', name: 'expenses', arguments: '{"from":"2019"}' }, { id: 'call_b', name: 'events', arguments: '{}' }]);
  });

  test('whole calls without an index, arguments as an object, the name with every piece or in pieces', () => {
    assert.deepEqual(calls(
      { tool_calls: [{ id: 'x1', function: { name: 'expenses', arguments: { search: ['Blumen'] } } }] },
      { tool_calls: [{ id: 'x2', function: { name: 'events', arguments: '{}' } }] }
    ), [{ id: 'x1', name: 'expenses', arguments: '{"search":["Blumen"]}' }, { id: 'x2', name: 'events', arguments: '{}' }]);
    assert.deepEqual(calls(
      { tool_calls: [{ index: 0, id: 'c', function: { name: 'expenses', arguments: '{"a"' } }] },
      { tool_calls: [{ index: 0, function: { name: 'expenses', arguments: ':1}' } }] }
    ), [{ id: 'c', name: 'expenses', arguments: '{"a":1}' }]);
    assert.deepEqual(calls(
      { tool_calls: [{ index: 0, id: 'c', function: { name: 'exp' } }] },
      { tool_calls: [{ index: 0, function: { name: 'enses', arguments: '{}' } }] }
    ), [{ id: 'c', name: 'expenses', arguments: '{}' }]);
  });

  test('a chunk without tool calls changes nothing; the name of the thoughts is kept for the answer back', () => {
    assert.deepEqual(calls({ content: 'Hallo' }, { reasoning: 'x' }), []);
    assert.equal(reasoningKeyOf(chunk({ reasoning_content: 'a' })), 'reasoning_content');
    assert.equal(reasoningKeyOf(chunk({ reasoning: 'b', content: '' })), 'reasoning');
    assert.equal(reasoningKeyOf(chunk({ content: 'c' })), null);
  });
});

describe('AI effort levels (backend/ai.js)', () => {
  test('missing or unknown means medium; low has no lookups, high allows the most', () => {
    assert.equal(aiEffortOf({}), 'medium');
    assert.equal(aiEffortOf({ effort: 'hoch' }), 'medium');
    assert.equal(aiEffortOf({ effort: 'toString' }), 'medium');
    assert.equal(aiEffortOf({ effort: 'low' }), 'low');
    assert.equal(AI_EFFORT_LEVELS.low.lookups, 0);
    assert.ok(AI_EFFORT_LEVELS.medium.lookups < AI_EFFORT_LEVELS.high.lookups);
    for (const level of Object.values(AI_EFFORT_LEVELS)) assert.ok(level.chars <= level.total && Object.isFrozen(level));
  });
});
