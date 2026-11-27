// Appointments and events in the browser: creating both kinds, the search, registering up to the capacity and the
// waiting list, the participants, editing, the duty plan (a request and its answer), the public link with a guest's
// registration, deleting, and a save the server refuses.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

/** A day [days] from today as YYYY-MM-DD (the events stay upcoming whenever the tests run). */
const inDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** Opens the editor through the add button: managers pick [kind] from its menu, everyone else gets an event. */
async function newEvent(session, kind) {
  await session.go('/events');
  await session.page.locator('#desktop-fab').click();
  if (kind) await session.page.locator('#fabMenu').getByRole('button', { name: new RegExp(kind) }).click();
  await session.page.locator('#detail-edit-title').waitFor();
}
async function publish(session, { title, date, time = '18:00', registration, places }) {
  const { page } = session;
  await page.locator('#detail-edit-title').fill(title);
  await page.locator('#detail-edit-date').fill(date);
  await page.locator('#detail-edit-start-time').fill(time);
  if (registration) await page.locator('label[for="detail-edit-requires-reg"]').click();
  if (places) await page.locator('#detail-edit-max-participants').fill(String(places));
  await page.getByRole('button', { name: 'Publish' }).last().click();
  await session.toast('Published successfully!');
  // The new event opens
  await page.locator('#detail-modal-title').getByText(title).waitFor();
}
/** Opens [title] from the list of [tab] ('Appointments' or 'Events'). */
async function openEvent(session, title, tab = 'Events') {
  await session.go('/events');
  await session.page.getByRole('tab', { name: tab }).click();
  await session.page.locator('main').getByText(title, { exact: true }).filter({ visible: true }).first().click();
  await session.page.locator('#detail-modal-title').getByText(title).waitFor();
}
const page$ = session => session.page.locator('#event-detail-modal');

describe('events (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a manager publishes an appointment and an event with registration; members find them, the search too', async () => {
    const owner = await app.signIn('owner');
    await newEvent(owner, 'New Appointment');
    await publish(owner, { title: 'Elders meeting', date: inDays(10) });
    await newEvent(owner, 'New Event');
    await publish(owner, { title: 'Summer party', date: inDays(20), registration: true, places: 2 });

    const max = await app.signIn('max');
    await max.go('/events');
    await max.page.getByRole('tab', { name: 'Appointments' }).click();
    await max.page.locator('main').getByText('Elders meeting').filter({ visible: true }).first().waitFor();
    await max.page.getByRole('tab', { name: 'Events' }).click();
    await max.page.locator('main').getByText('Summer party').filter({ visible: true }).first().waitFor();
    await max.page.locator('#events-search-input').fill('nothing like this');
    await until(async () => (await max.page.locator('main').getByText('Summer party').filter({ visible: true }).count()) === 0, 'the search to hide the event');
    await max.page.getByRole('button', { name: 'Clear search' }).click();
    await max.page.locator('main').getByText('Summer party').filter({ visible: true }).first().waitFor();
  });

  test('registering up to the capacity, then the waiting list; a free place moves the next one up', async () => {
    const max = await app.signIn('max');
    await openEvent(max, 'Summer party');
    await page$(max).getByRole('button', { name: 'Register' }).click();
    await max.toast('Registered successfully!');
    await page$(max).getByText('You are registered').waitFor();

    const mia = await app.signIn('mia');
    await openEvent(mia, 'Summer party');
    await page$(mia).getByRole('button', { name: 'Register' }).click();
    await mia.toast('Registered successfully!');

    const theo = await app.signIn('treasurer');
    await openEvent(theo, 'Summer party');
    await page$(theo).getByRole('button', { name: 'Join the waiting list' }).click();
    await theo.toast('Added to the waiting list');
    await page$(theo).getByText('You are on the waiting list').waitFor();

    await page$(max).getByRole('button', { name: 'Unregister' }).click();
    await max.toast('Unregistered');
    await openEvent(theo, 'Summer party');
    await page$(theo).getByText('You are registered').waitFor();
  });

  test('the manager sees the participants and removes one', async () => {
    const owner = await app.signIn('owner');
    await openEvent(owner, 'Summer party');
    // The participants are folded away under their summary
    await page$(owner).locator('summary', { hasText: 'Participants' }).click();
    await page$(owner).getByText('Mia Test').filter({ visible: true }).first().waitFor();
    await page$(owner).locator('button[aria-label="Remove"]').first().click();
    await owner.toast('Participant removed');
  });

  test('an edit shows for everyone', async () => {
    const owner = await app.signIn('owner');
    await openEvent(owner, 'Summer party');
    await page$(owner).getByRole('button', { name: 'Edit' }).click();
    await owner.page.locator('#detail-edit-title').fill('Summer party in the garden');
    await owner.page.getByRole('button', { name: 'Save' }).last().click();
    await owner.toast('Updated successfully!');
    const max = await app.signIn('max');
    await openEvent(max, 'Summer party in the garden');
  });

  test('the duty plan: the manager asks a member, who accepts on the start page', async () => {
    const owner = await app.signIn('owner');
    await openEvent(owner, 'Summer party in the garden');
    await owner.page.locator('#detail-modal-duties-details summary').click();
    await owner.page.locator('#detail-btn-add-duty').click();
    await owner.page.locator('#plan-entry-name').fill('Coffee');
    await owner.page.getByRole('button', { name: 'Ask a person or group' }).click();
    await owner.page.locator('#plan-who-search').fill('Mia');
    await owner.page.locator('#plan-who-list').getByText('Mia Test').click();
    await owner.page.locator('#plan-entry-modal').getByRole('button', { name: /^Add & ask/ }).click();
    await owner.toast('Duty request sent!');

    const mia = await app.signIn('mia');
    await mia.go('/');
    const request = mia.page.getByText('Open duty requests for you (1)');
    await request.waitFor({ timeout: 15000 });
    await mia.page.getByRole('button', { name: /Accept/ }).first().click();
    await mia.toast('Duty accepted! You are now assigned to this event.');
  });

  test('a public link: a visitor sees the event without an account and registers as a guest', async () => {
    const owner = await app.signIn('owner');
    await newEvent(owner, 'New Event');
    await publish(owner, { title: 'Open evening', date: inDays(25), registration: true });
    await page$(owner).getByRole('button', { name: 'Share' }).click();
    await owner.page.locator('label[for="event-share-public"]').click();
    const link = owner.page.locator('#event-share-link');
    await until(async () => (await link.inputValue()).includes('?share='), 'the public link');
    const url = new URL(await link.inputValue());

    const visitor = await app.visit();
    await visitor.go(url.pathname + url.search);
    await visitor.page.locator('#guest-event-title').getByText('Open evening').waitFor();
    await visitor.page.locator('#guest-reg-name').fill('Gina Guest');
    await visitor.page.getByLabel('E-mail address').fill('gina@example.org');
    await visitor.page.getByLabel('Age').fill('34');
    await visitor.page.getByRole('button', { name: 'Register' }).click();
    await visitor.toast('You are registered.');
    await visitor.page.getByText('Gina Guest is registered').waitFor();
  });

  test('deleting an event takes it away for everyone', async () => {
    const owner = await app.signIn('owner');
    await openEvent(owner, 'Open evening');
    await page$(owner).getByRole('button', { name: 'Delete' }).click();
    await owner.toast('Event deleted');
    const max = await app.signIn('max');
    await max.go('/events');
    await max.page.getByRole('tab', { name: 'Events' }).click();
    await max.page.locator('main').getByText('Summer party in the garden').filter({ visible: true }).first().waitFor();
    assert.equal(await max.page.locator('main').getByText('Open evening').filter({ visible: true }).count(), 0);
  });

  test('a save the server refuses shows its reason, and the editor stays open', async () => {
    const max = await app.signIn('max');
    await newEvent(max);
    max.expectProblems(/^500 POST \/api\/events$/);
    // The editor logs what went wrong
    max.expectProblems(/^console error: saveDetailEditMode error: Error: Not right now/);
    await max.page.route('**/api/events', route =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not right now' }) }) : route.fallback()
    );
    await max.page.locator('#detail-edit-title').fill('Refused');
    await max.page.locator('#detail-edit-date').fill(inDays(30));
    await max.page.getByRole('button', { name: 'Publish' }).last().click();
    await max.toast('Not right now');
    assert.equal(await max.page.locator('#detail-edit-title').inputValue(), 'Refused');
  });
});
