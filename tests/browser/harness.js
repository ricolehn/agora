// The browser tests: the built web app served by the backend, driven in Chromium through Playwright as the people of
// the test community (tests/instance.js: owner, treasurer, max, mia). Every file starts its own instance. A session
// keeps what goes wrong on its page - script errors, console errors, answers of 500 and above - and endTest() fails the
// test when there was any, so every test also checks that nothing broke on the way.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../helpers');
const { PASSWORD, hasPocketBase, makeRoot, startPocketBase, startBackend, httpClient, setUpCommunity, stop } = require('../instance');

const WEB_DIR = path.join(REPO_ROOT, 'web');
// The build under test: web/dist, or AGORA_WEB_BUILD (e.g. a development build, whose Solid reports its diagnostics)
const BUILD_DIR = process.env.AGORA_WEB_BUILD ? path.resolve(REPO_ROOT, process.env.AGORA_WEB_BUILD) : path.join(WEB_DIR, 'dist');
let playwright = null;
try {
  playwright = require(require.resolve('playwright', { paths: [WEB_DIR] }));
} catch {
  /* the web app's dependencies are not installed */
}

/** Why the browser tests cannot run here ('' when they can). */
const skipReason = !hasPocketBase
  ? 'set POCKETBASE_BIN to run the browser tests'
  : !playwright
    ? 'install the web app (cd web && npm ci) to run the browser tests'
    : !fs.existsSync(path.join(BUILD_DIR, 'index.html'))
      ? `build the web app first (cd web && npm run build): there is no ${path.relative(REPO_ROOT, BUILD_DIR)}/index.html`
      : '';
// In CI a missing piece is a failure, not a skip
if (skipReason && process.env.REQUIRE_BROWSER === '1') throw new Error(`REQUIRE_BROWSER=1, but: ${skipReason}`);

// The toasts a page shows, in order (the same text twice in a row counts once)
const RECORD_TOASTS = `
  window.__toasts = [];
  new MutationObserver(() => {
    const text = document.getElementById('toast')?.textContent?.trim();
    if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
  }).observe(document, { subtree: true, childList: true, characterData: true });
`;

/** Waits until [check]() is truthy (it may be async) and returns its value; fails with [message] after [timeout] ms. */
async function until(check, message = 'the condition', timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
}

/**
 * An instance that serves the build, with the community and [seed](http) on top (http: tests/instance.js
 * httpClient, signed in as owner, treasurer, max and mia), and one browser for its sessions.
 */
async function startApp({ seed } = {}) {
  const root = makeRoot('agora-browser-');
  const pocketbase = await startPocketBase(root);
  const backend = await startBackend(root, pocketbase.port, { env: { FRONTEND_DIR: BUILD_DIR, NODE_ENV: 'production', TZ: 'Europe/Berlin' } });
  const http = httpClient(backend.base);
  await setUpCommunity(http);
  if (seed) await seed(http);
  const browser = await playwright.chromium.launch();
  const open = new Set();
  let addresses = 0;

  /** A fresh browser window (its own cookies and storage) on the app's start page, signed out. */
  async function visit({ viewport = { width: 1100, height: 900 }, locale = 'en-US' } = {}) {
    addresses += 1;
    // Each window has an address of its own: the server's rate limits count per address
    const context = await browser.newContext({ viewport, locale, timezoneId: 'Europe/Berlin', extraHTTPHeaders: { 'X-Forwarded-For': `10.250.${addresses >> 8}.${addresses & 255}` } });
    await context.addInitScript(RECORD_TOASTS);
    const page = await context.newPage();
    page.on('dialog', dialog => void dialog.accept());
    const problems = [];
    page.on('pageerror', err => problems.push(`script error: ${err.message}`));
    page.on('console', message => {
      // The browser reports failed requests itself; the answers are checked below (a 401 before signing in is normal)
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console error: ${message.text()}`);
    });
    page.on('response', res => {
      if (res.status() >= 500) problems.push(`${res.status()} ${res.request().method()} ${res.url().replace(backend.base, '')}`);
    });
    const session = {
      page,
      problems,
      /** Opens [route] (e.g. '/events') and waits until the page has settled. */
      async go(route) {
        await page.goto(backend.base + route, { waitUntil: 'load' });
        await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 15000 });
      },
      /** The toasts shown so far. */
      toasts: () => page.evaluate(() => window.__toasts),
      /** Waits for a toast that contains [text]. */
      toast: text => until(async () => (await session.toasts()).some(shown => shown.includes(text)), `a toast with "${text}"`),
      /** Problems that the test brings about on purpose (a refused request it fakes) are not counted. */
      expectProblems(pattern) {
        session.expected.push(pattern);
      },
      expected: [],
      close: () => context.close()
    };
    open.add(session);
    await session.go('/');
    return session;
  }

  /** A window of its own, signed in through the sign-in form as [who] (an account of the community, e.g. 'max'). */
  async function signIn(who, options) {
    const session = await visit(options);
    const { page } = session;
    await page.locator('#login-email').fill(`${who}@test.local`);
    await page.locator('#login-password').fill(PASSWORD);
    await page.locator('#login-password').press('Enter');
    await page.locator('header button[aria-haspopup="menu"]').waitFor({ timeout: 15000 });
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 15000 });
    return session;
  }

  /** After each test: no window may have had a problem it did not expect; then all of them close. */
  async function endTest() {
    const found = [];
    for (const session of open) {
      const unexpected = session.problems.filter(problem => !session.expected.some(pattern => pattern.test(problem)));
      found.push(...unexpected);
      await session.close().catch(() => {});
    }
    open.clear();
    assert.deepEqual(found, [], 'problems on the page');
  }

  async function close() {
    await browser.close();
    await stop(backend.process);
    await stop(pocketbase.process);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  return { base: backend.base, http, visit, signIn, endTest, close };
}

module.exports = { skipReason, startApp, until };
