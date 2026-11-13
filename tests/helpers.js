// Shared helpers for the test suite (node:test, no extra dependencies).
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
// The server the HTTP tests start. AGORA_TEST_SERVER=backend/legacy/server.js runs them against the frozen backend
// that an instance falls back to while its database upgrade waits (backend/legacy/README.md)
const SERVER_ENTRY = process.env.AGORA_TEST_SERVER ? path.resolve(REPO_ROOT, process.env.AGORA_TEST_SERVER) : path.join(BACKEND_DIR, 'server.js');

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

// --- Starting the real server (and PocketBase) for the tests over HTTP ---

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** Waits until [url] answers (asked every [every] ms); fails when one of [processes] has exited meanwhile. */
async function waitFor(url, label, processes, every = 250) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const crashed = processes.find((p) => p.exitCode !== null);
    if (crashed) throw new Error(`${label}: ${crashed.label} exited early (${crashed.exitCode})\n${crashed.log.join('')}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  throw new Error(`${label} did not come up: ${url}`);
}

function start(label, command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.label = label;
  child.log = [];
  // API_TEST_LOG=1 prints the server output (debugging a failing test)
  const keep = (chunk) => {
    child.log.push(chunk.toString());
    if (child.log.length > 200) child.log.shift();
    if (process.env.API_TEST_LOG) process.stderr.write(`[${label}] ${chunk}`);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return child;
}

/** Stops a process started with start() and waits until it is gone (its port is free again). */
function stop(child) {
  // Stopped already: a process ended by a signal keeps exitCode null (its 'exit' does not come again)
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

module.exports = { REPO_ROOT, BACKEND_DIR, SERVER_ENTRY, backendRequire, tempDir, withEnv, freezeTime, assertHas, freePort, waitFor, start, stop };
