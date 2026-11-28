// Prayer requests in the browser: sharing (with the name or anonymously), what the others see at once, the filter,
// extending and removing one's own, a moderator removing another's, a share and a removal the server refuses, a first
// load that fails and a later one that fails.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

/** Shares [text] through the add button's dialog ([duration]: the label of its choice; [anonymous]: the switch). */
async function share(page, text, { duration, anonymous = false } = {}) {
  await page.locator('#desktop-fab').click();
  await page.locator('#prayer-text').fill(text);
  if (duration) await page.getByRole('radio', { name: duration }).click();
  if (anonymous) await page.locator('label[for="prayer-anonymous"]').click();
  await page.locator('#prayer-submit').click();
}
const list = page => page.locator('#prayers-list');
const shown = (page, text) => list(page).getByText(text).count();

describe('prayer requests (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a member shares a request with the name; the others see it without reloading', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/prayers');
    const max = await app.signIn('max');
    await max.go('/prayers');
    await share(max.page, 'Please pray for my exam on Friday', { duration: '1 week' });
    await max.toast('Your prayer request has been shared');
    const card = list(max.page).getByRole('button', { name: /Please pray for my exam/ });
    await card.waitFor();
    assert.match(await card.innerText(), /Max Test/);
    assert.match(await card.innerText(), /until /);
    await list(mia.page).getByText('Please pray for my exam on Friday').waitFor({ timeout: 10000 });
  });

  test('anonymous: the others see no name', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/prayers');
    await share(mia.page, 'For my family, please', { anonymous: true });
    await mia.toast('Your prayer request has been shared');
    const max = await app.signIn('max');
    await max.go('/prayers');
    const text = list(max.page).getByText('For my family, please');
    await text.waitFor();
    const card = text.locator('xpath=ancestor::div[contains(@class, "grid")][1]');
    assert.match(await card.innerText(), /Anonymous/);
    assert.doesNotMatch(await card.innerText(), /Mia/);
  });

  test('a request needs three letters at least; the dialog stays open', async () => {
    const max = await app.signIn('max');
    await max.go('/prayers');
    await share(max.page, 'ab');
    await max.toast('Please write your request (at least 3 characters).');
    assert.ok(await max.page.locator('#prayer-text').isVisible());
  });

  test('"Mine" shows only one\'s own requests', async () => {
    const max = await app.signIn('max');
    await max.go('/prayers');
    await list(max.page).getByText('For my family, please').waitFor();
    await max.page.getByRole('tab', { name: 'Mine' }).click();
    await until(async () => (await shown(max.page, 'For my family, please')) === 0, 'the other member\'s request to go');
    assert.equal(await shown(max.page, 'Please pray for my exam on Friday'), 1);
  });

  test('one\'s own request: one more month, then done (and gone for the others too)', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/prayers');
    const max = await app.signIn('max');
    await max.go('/prayers');
    const card = () => list(max.page).getByRole('button', { name: /Please pray for my exam/ });
    await card().click();
    await max.page.getByRole('button', { name: 'One more month' }).click();
    await max.toast('Shown for another month');
    await card().click();
    await max.page.getByRole('button', { name: 'Done - remove' }).click();
    await max.toast('Removed - thank you for sharing');
    await until(async () => (await shown(max.page, 'Please pray for my exam on Friday')) === 0, 'the request to go');
    await until(async () => (await shown(mia.page, 'Please pray for my exam on Friday')) === 0, 'the request to go for the others', 15000);
  });

  test('a moderator removes another member\'s request', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/prayers');
    await list(owner.page).getByRole('button', { name: /For my family, please/ }).click();
    await owner.page.getByRole('button', { name: 'Remove', exact: true }).click();
    await owner.toast('Prayer request deleted');
    await until(async () => (await shown(owner.page, 'For my family, please')) === 0, 'the request to go');
  });

  test('a share the server refuses: its reason shows, and the text stays in the dialog', async () => {
    const max = await app.signIn('max');
    await max.go('/prayers');
    max.expectProblems(/^500 POST \/api\/prayers$/);
    await max.page.route('**/api/prayers', route =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not right now' }) }) : route.fallback()
    );
    await share(max.page, 'A request that does not get through');
    await max.toast('Not right now');
    assert.equal(await max.page.locator('#prayer-text').inputValue(), 'A request that does not get through');
  });

  test('a removal the server refuses: the request leaves at once and comes back with the reason', async () => {
    const { http } = app;
    await http.ok(http.call('max', 'POST', '/api/prayers', { text: 'Patience with my neighbours', anonymous: false, duration: 'week' }));
    const max = await app.signIn('max');
    await max.go('/prayers');
    max.expectProblems(/^500 DELETE \/api\/prayers\//);
    let answer = null;
    await max.page.route('**/api/prayers/*', async route => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      // The answer waits until the list has been looked at
      await new Promise(resolve => (answer = resolve));
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not deleted' }) });
    });
    await list(max.page).getByRole('button', { name: /Patience with my neighbours/ }).click();
    await max.page.getByRole('button', { name: 'Done - remove' }).click();
    await until(async () => (await shown(max.page, 'Patience with my neighbours')) === 0, 'the request to leave at once');
    await until(() => answer !== null, 'the removal to be asked');
    answer();
    await max.toast('Not deleted');
    await list(max.page).getByText('Patience with my neighbours').waitFor();
  });

  test('a first load that fails shows its reason; "Try again" brings the requests, a later failed one keeps them', async () => {
    const max = await app.signIn('max');
    max.expectProblems(/^500 GET \/api\/prayers$/);
    let refuse = 1;
    await max.page.route('**/api/prayers', route => {
      if (route.request().method() !== 'GET' || !refuse) return route.fallback();
      refuse -= 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The list is resting' }) });
    });
    await max.go('/prayers');
    await list(max.page).getByText('The list is resting').waitFor();
    await list(max.page).getByRole('button', { name: 'Try again' }).click();
    await list(max.page).getByText('Patience with my neighbours').waitFor();
    // Another visit of the tab asks again: refused, the list stays and the reason shows
    refuse = 1;
    await max.page.locator('#desktop-nav').getByRole('button', { name: 'Extras' }).click();
    await max.page.getByRole('button', { name: /Prayer requests/ }).click();
    await max.toast('The list is resting');
    assert.equal(await shown(max.page, 'Patience with my neighbours'), 1);
  });
});
