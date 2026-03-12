const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resolveDataDirectory, resolvePocketBaseDirectory, resolveFrontendDirectory } = require('./pathConfig');

test('resolveDataDirectory defaults to the persistent /app/data-compatible path', () => {
  assert.equal(resolveDataDirectory({ env: {} }), path.join(__dirname, '..', 'data'));
});

test('resolveDataDirectory honors DATA_DIR overrides', () => {
  assert.equal(resolveDataDirectory({ env: { DATA_DIR: '/tmp/nova-data' } }), '/tmp/nova-data');
});

test('resolvePocketBaseDirectory honors POCKETBASE_DIR overrides', () => {
  assert.equal(resolvePocketBaseDirectory({
    env: { POCKETBASE_DIR: '/tmp/nova-db' }
  }), '/tmp/nova-db');
});

test('resolvePocketBaseDirectory honors DB_DIR overrides', () => {
  assert.equal(resolvePocketBaseDirectory({
    env: { DB_DIR: '/tmp/nova-db' }
  }), '/tmp/nova-db');
});

test('resolvePocketBaseDirectory uses bundled /app/db when available', () => {
  assert.equal(resolvePocketBaseDirectory({
    env: {},
    existsSync: (candidate) => candidate === path.join(__dirname, '..', 'db')
  }), path.join(__dirname, '..', 'db'));
});

test('resolvePocketBaseDirectory falls back to the data directory for local development', () => {
  assert.equal(resolvePocketBaseDirectory({
    env: {},
    existsSync: () => false
  }), path.join(__dirname, '..', 'data', 'pocketbase'));
});

test('resolveFrontendDirectory prefers FRONTEND_DIR overrides', () => {
  assert.equal(resolveFrontendDirectory({
    env: { FRONTEND_DIR: '/tmp/nova-html' }
  }), '/tmp/nova-html');
});

test('resolveFrontendDirectory uses bundled /app/html when available', () => {
  assert.equal(resolveFrontendDirectory({
    env: {},
    existsSync: (candidate) => candidate === path.join(__dirname, '..', 'html')
  }), path.join(__dirname, '..', 'html'));
});

test('resolveFrontendDirectory falls back to the repository root for local development', () => {
  assert.equal(resolveFrontendDirectory({
    env: {},
    existsSync: () => false
  }), path.join(__dirname, '..'));
});
