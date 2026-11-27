// The system settings in the browser (system admins): creating an account the new person signs in with, a group with
// a permission that opens what it allows, the group filter and the search, a new password, an account without a fee,
// the community's name, deleting an account, and members kept out.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PASSWORD } = require('../instance');
const { skipReason, startApp, until } = require('./harness');

const NEW_PASSWORD = 'Another-Passwort-2';
const panel = page => page.locator('#sys-panel-accounts');
/** The row of [name] in the accounts table. */
const row = (page, name) => panel(page).locator('tbody tr', { hasText: name });
const rowNames = page => panel(page).locator('tbody tr').allInnerTexts();

describe('system settings (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('the owner creates an account (the form wants a name); the new person signs in with it', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await panel(owner.page).getByRole('button', { name: 'New User' }).click();
    const dialog = owner.page.locator('#create-user-modal');
    // The browser itself asks for the name (the fields are required) and the dialog stays
    await dialog.getByRole('button', { name: 'Create User' }).click();
    assert.equal(await owner.page.locator('#new-user-first-name:invalid').count(), 1);
    assert.equal(await dialog.isVisible(), true);
    await owner.page.locator('#new-user-first-name').fill('Nora');
    await owner.page.locator('#new-user-last-name').fill('New');
    await owner.page.locator('#new-user-email').fill('nora@test.local');
    await owner.page.locator('#new-user-password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Create User' }).click();
    await owner.toast('User created successfully');
    await row(owner.page, 'nora@test.local').getByText('Nora New').waitFor();

    const nora = await app.signIn('nora');
    await nora.page.locator('header').getByText('Testgemeinde').waitFor();
  });

  test('a group with a permission: given to an account, it opens what it allows; the group filters the table', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await owner.page.locator('#nc-new-group-name').fill('Choir');
    await owner.page.locator('#nc-new-group-name').press('Enter');
    await owner.toast('Group created successfully');
    const group = owner.page.locator('#nc-groups-list > div', { hasText: 'Choir' });
    await group.getByRole('button', { name: 'Manage Group' }).click();
    await owner.page.getByRole('checkbox', { name: /Manage songbook/ }).check();
    await owner.page.locator('#manage-group-modal').getByRole('button', { name: 'Save' }).click();
    await owner.toast('Group updated successfully');

    await row(owner.page, 'Nora New').locator('td[title="Assign Groups"]').click();
    await owner.page.locator('#assign-group-checklist').getByRole('checkbox', { name: /Choir/ }).check();
    await owner.page.locator('#assign-group-modal').getByRole('button', { name: 'Save' }).click();
    await owner.toast('User groups updated successfully');
    await row(owner.page, 'Nora New').getByText('Choir').waitFor();

    await group.click();
    await until(async () => (await rowNames(owner.page)).length === 1, 'only the group\'s members');
    assert.match((await rowNames(owner.page))[0], /Nora New/);
    await owner.page.getByRole('button', { name: 'Clear filter' }).click();
    await until(async () => (await rowNames(owner.page)).length > 1, 'all accounts again');

    // Songs are added through the add button, which only those who manage the songbook have
    const nora = await app.signIn('nora');
    await nora.go('/songbook');
    await nora.page.locator('#desktop-fab').waitFor();
    const max = await app.signIn('max');
    await max.go('/songbook');
    assert.equal(await max.page.locator('#desktop-fab').isVisible(), false);
  });

  test('the search finds an account by its name', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await owner.page.locator('#accounts-search').fill('Mia');
    await until(async () => (await rowNames(owner.page)).length === 1, 'one account to match');
    assert.match((await rowNames(owner.page))[0], /Mia Test/);
  });

  test('a new password from the owner: it needs six characters; the person signs in with it', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await row(owner.page, 'Nora New').getByRole('button', { name: 'Reset Password' }).click();
    const dialog = owner.page.locator('#reset-password-modal');
    await owner.page.locator('#reset-password-new').fill('short');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await owner.toast('Password must be at least 6 characters long.');
    await owner.page.locator('#reset-password-new').fill(NEW_PASSWORD);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await owner.toast('Password changed successfully');

    await app.signIn('nora', { password: NEW_PASSWORD });
  });

  test('an account without a fee: the person\'s finances say so', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await row(owner.page, 'Nora New').locator('select').selectOption('no');
    await owner.toast('Payment status updated');

    const nora = await app.signIn('nora', { password: NEW_PASSWORD });
    await nora.go('/finances');
    await nora.page.locator('#user-finances-status-card').getByText('User account', { exact: true }).waitFor();
  });

  test('the community\'s new name shows in the header, after a reload too', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await owner.page.locator('#sys-subtab-btn-config').click();
    await until(() => owner.page.url().endsWith('/system/config'), 'the address of the page');
    const name = owner.page.locator('#super-admin-app-name');
    await until(async () => (await name.inputValue()) === 'Testgemeinde', 'the stored configuration');
    await name.fill('Gemeinde am See');
    await owner.page.getByRole('button', { name: 'Save Advanced System Configuration' }).click();
    await owner.toast('System configuration saved');
    await owner.page.locator('header').getByText('Gemeinde am See').waitFor();
    await owner.go('/system/config');
    await owner.page.locator('header').getByText('Gemeinde am See').waitFor();
    assert.equal(await owner.page.locator('#sys-panel-config').isVisible(), true);
  });

  test('a deleted account can no longer sign in', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system');
    await row(owner.page, 'Nora New').getByRole('button', { name: 'Delete' }).click();
    await owner.toast('User deleted successfully');
    await until(async () => (await row(owner.page, 'Nora New').count()) === 0, 'the row to go');

    const visitor = await app.visit();
    // The sign-in form reports the refusal (and logs it)
    visitor.expectProblems(/^console error: Error: Failed to authenticate\./);
    await visitor.page.locator('#login-email').fill('nora@test.local');
    await visitor.page.locator('#login-password').fill(NEW_PASSWORD);
    await visitor.page.locator('#login-password').press('Enter');
    await visitor.page.locator('#auth-error').getByText('Login failed: Failed to authenticate.').waitFor();
  });

  test('members do not reach the system settings', async () => {
    const max = await app.signIn('max');
    await max.go('/system');
    await until(() => !max.page.url().includes('/system'), 'the way out of the system settings');
    assert.equal(await max.page.locator('#sys-panel-accounts').count(), 0);
  });
});
