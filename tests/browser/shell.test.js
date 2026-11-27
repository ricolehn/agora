// The frame of the app in the browser: signing in and out, every page for every role, what the browser remembers,
// the profile menu with the keyboard.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

const PAGES = ['/', '/finances', '/finances/members', '/events', '/mentoring', '/prayers', '/polls', '/songbook', '/hub', '/settings',
  '/settings/profile', '/settings/appearance', '/settings/notifications', '/settings/calendar', '/settings/fees', '/settings/account', '/system', '/ai'];

describe('the app shell (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('signing in shows the app; signing out leaves no session behind and the next start asks to sign in at once', async () => {
    const { page, go } = await app.signIn('max');
    assert.equal(await page.evaluate(() => localStorage.getItem('agora-is-logged-in')), 'true');
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.locator('#login-email').waitFor();
    const stored = await page.evaluate(() => Object.keys(localStorage));
    assert.ok(!stored.includes('agora-is-logged-in') && !stored.includes('agora_auth_session'), `stored after signing out: ${stored}`);
    await go('/');
    // No loading screen first: nobody was signed in on this browser
    assert.equal(await page.locator('#loading-overlay').count(), 0);
    assert.ok(await page.locator('#login-email').isVisible());
  });

  for (const who of ['owner', 'treasurer', 'max']) {
    test(`every page opens without a problem for ${who}`, async () => {
      const session = await app.signIn(who);
      for (const route of PAGES) {
        await session.go(route);
        // Let the page load its data
        await session.page.waitForTimeout(400);
      }
    });
  }

  test('the theme and the language stay after a reload, and the loading screen shows instead of the sign-in', async () => {
    const { page, go } = await app.signIn('mia');
    await go('/settings/appearance');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.getByRole('radio', { name: 'Deutsch' }).click();
    await until(() => page.evaluate(() => document.documentElement.lang === 'de'), 'the German texts');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#login-email').isVisible(), false, 'the sign-in does not flash up while the session is restored');
    await page.locator('header button[aria-haspopup="menu"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'de');
    // Back to the defaults for the other tests of this account
    await go('/settings/appearance');
    await page.getByRole('radio', { name: 'System' }).first().click();
    await page.getByRole('radio', { name: 'English' }).click();
    await until(() => page.evaluate(() => document.documentElement.lang === 'en'), 'the English texts');
  });

  test('the profile menu: Enter opens it on its first entry, the arrows go round, Escape goes back to the button', async () => {
    const { page } = await app.signIn('max');
    const button = page.locator('header button[aria-haspopup="menu"]');
    await button.focus();
    await page.keyboard.press('Enter');
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
    await until(async () => (await focused()) === 'Settings', 'the focus on "Settings"');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'Sign out');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'Settings');
    await page.keyboard.press('Escape');
    await until(() => button.evaluate(el => el === document.activeElement), 'the focus back on the profile button');
    await until(async () => !(await page.locator('#profileDropdown').isVisible()), 'the menu to fade out');
  });

  test('back leads to the start page: moving between the tabs keeps one history entry (as the Android app does)', async () => {
    const { page } = await app.signIn('max');
    const nav = page.locator('#desktop-nav');
    await nav.getByRole('button', { name: 'Events' }).click();
    await until(() => page.url().endsWith('/events'), 'the events page');
    await nav.getByRole('button', { name: 'Mentoring' }).click();
    await until(() => page.url().endsWith('/mentoring'), 'the mentoring page');
    await page.goBack();
    await until(() => new URL(page.url()).pathname === '/', 'the start page');
  });
});
