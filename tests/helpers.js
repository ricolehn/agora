// Shared helpers for the test suite (node:test, no extra dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

/** Loads a package from backend/node_modules (the tests live outside the backend package). */
const backendRequire = (name) => require(require.resolve(name, { paths: [BACKEND_DIR] }));

/** Fresh temporary directory, removed again when the test `t` finishes. */
function tempDir(t, prefix = 'agora-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Sets environment variables for the test `t` (undefined deletes one) and restores the old values afterwards. */
function withEnv(t, vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Lets `new Date()` / `Date.now()` return the given moment until the test `t` finishes (or `restore()` is
 * called); dates built from arguments keep working normally.
 */
function freezeTime(t, isoMoment) {
  const RealDate = global.Date;
  const frozen = new RealDate(isoMoment).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozen]));
    }
    static now() { return frozen; }
  }
  global.Date = FrozenDate;
  const restore = () => { global.Date = RealDate; };
  t.after(restore);
  return restore;
}

/** Asserts that [actual] has at least the fields of [expected] (new fields in [actual] do not break the test). */
function assertHas(actual, expected, message) {
  const assert = require('node:assert/strict');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual?.[key], value, `${message ? message + ': ' : ''}field "${key}"`);
}

module.exports = { REPO_ROOT, BACKEND_DIR, backendRequire, tempDir, withEnv, freezeTime, assertHas };
