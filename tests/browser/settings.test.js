// The own settings in the browser: a profile picture (cropped and saved), the own password, the registration code a
// new person registers with, the notification channels, the personal calendar link, and deleting the own account.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PASSWORD } = require('../instance');
const { pngImage, skipReason, startApp, until } = require('./harness');

const NEW_PASSWORD = 'Another-Passwort-2';
/** A switch of the app (a checkbox drawn as a slider): clicked where it is drawn. */
const flip = (page, name) => page.getByRole('switch', { name, exact: true }).locator('xpath=..').click();

describe('settings (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a new profile picture is cropped, saved and shown in the header', async () => {
    const max = await app.signIn('max');
    await max.go('/settings/profile');
    const avatar = max.page.locator('header button[aria-haspopup="menu"] img');
    assert.equal(await avatar.count(), 0, 'the initials at first');
    await max.page.locator('#profile-pic-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: pngImage(320, 240) });
    const crop = max.page.getByRole('dialog', { name: 'Crop Profile Picture' });
    await crop.getByRole('button', { name: 'Save' }).click();
    await max.toast('Profile picture saved!');
    await avatar.waitFor();
  });

  test('the own password: a wrong old one is refused; afterwards only the new one signs in', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/settings/password');
    // The refused change is logged
    mia.expectProblems(/^console error: Error: The password is not correct\./);
    await mia.page.locator('#old-password').fill('not-my-password');
    await mia.page.locator('#new-password').fill(NEW_PASSWORD);
    await mia.page.getByRole('button', { name: 'Change Password' }).click();
    await mia.toast('Error changing password: The password is not correct.');
    await mia.page.locator('#old-password').fill(PASSWORD);
    await mia.page.getByRole('button', { name: 'Change Password' }).click();
    await mia.toast('Password changed – please sign in again.');
    await mia.page.locator('#login-email').waitFor();

    await app.signIn('mia', { password: NEW_PASSWORD });
  });

  test('the registration code: a wrong one is refused; with the current one a new person registers and is signed in', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/settings');
    const shown = owner.page.getByText(/^(\d{6}|------)$/);
    const before = await shown.textContent();
    await owner.page.getByRole('button', { name: 'Generate new code' }).click();
    const code = await until(async () => {
      const text = (await shown.textContent()).trim();
      return text !== before && /^\d{6}$/.test(text) && text;
    }, 'the new code');

    const visitor = await app.visit();
    // The refused registration is logged
    visitor.expectProblems(/^console error: Error: Invalid registration code\./);
    const { page } = visitor;
    await page.locator('#btn-show-register').click();
    await page.locator('#reg-code').fill(code === '123456' ? '654321' : '123456');
    await page.locator('#reg-email').fill('lena@test.local');
    await page.locator('#reg-firstname').fill('Lena');
    await page.locator('#reg-lastname').fill('Test');
    await page.locator('#reg-pass1').fill(PASSWORD);
    await page.locator('#reg-pass2').fill(PASSWORD);
    await page.locator('#register-form').getByRole('button', { name: 'Register' }).click();
    await page.locator('#auth-error').getByText('Invalid registration code.').waitFor();
    // What was typed stays
    assert.equal(await page.locator('#reg-email').inputValue(), 'lena@test.local');
    await page.locator('#reg-code').fill(code);
    await page.locator('#register-form').getByRole('button', { name: 'Register' }).click();
    await page.locator('header button[aria-haspopup="menu"]').waitFor({ timeout: 15000 });
  });

  test('notifications: e-mail turned off stays off after a reload', async () => {
    const max = await app.signIn('max');
    await max.go('/settings/notifications');
    const email = max.page.getByRole('switch', { name: 'E-mail', exact: true });
    const before = await email.isChecked();
    await flip(max.page, 'E-mail');
    await max.toast('Notification settings saved');
    await max.go('/settings/notifications');
    assert.equal(await email.isChecked(), !before);
    // Back as it was
    await flip(max.page, 'E-mail');
    await until(async () => (await email.isChecked()) === before, 'the switch back');
  });

  test('the calendar link delivers the own dates; a renewed link ends the old one', async () => {
    const max = await app.signIn('max');
    await max.go('/settings/calendar');
    const field = max.page.locator('#user-cal-feed-url');
    const first = await until(() => field.inputValue(), 'the calendar link');
    const feed = await fetch(first);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), /^BEGIN:VCALENDAR/);
    await max.page.getByRole('button', { name: 'Renew link' }).click();
    await max.toast('New calendar link successfully generated!');
    const second = await until(async () => {
      const value = await field.inputValue();
      return value !== first && value;
    }, 'the new link');
    assert.equal((await fetch(second)).status, 200);
    assert.notEqual((await fetch(first)).status, 200, 'the old link no longer works');
  });

  test('deleting the own account needs the password; then the person is signed out for good', async () => {
    await app.http.account('paula', 'Paula');
    const paula = await app.signIn('paula');
    await paula.go('/settings/account');
    await paula.page.getByRole('button', { name: 'Delete account', exact: true }).click();
    await paula.page.getByRole('button', { name: 'Delete account permanently' }).click();
    await paula.toast('Please enter your password to confirm.');
    await paula.page.locator('#delete-account-password').fill(PASSWORD);
    await paula.page.getByRole('button', { name: 'Delete account permanently' }).click();
    await paula.page.locator('#login-email').waitFor();

    const visitor = await app.visit();
    visitor.expectProblems(/^console error: Error: Failed to authenticate\./);
    await visitor.page.locator('#login-email').fill('paula@test.local');
    await visitor.page.locator('#login-password').fill(PASSWORD);
    await visitor.page.locator('#login-password').press('Enter');
    await visitor.page.locator('#auth-error').getByText('Login failed: Failed to authenticate.').waitFor();
  });
});
