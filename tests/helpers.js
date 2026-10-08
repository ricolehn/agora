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

module.exports = { REPO_ROOT, BACKEND_DIR, backendRequire, tempDir, withEnv };
