// The start page in the browser: the greeting with the first name and nothing coming up, an overdue fee right after
// the greeting (a tap leads to the finances), what comes up next with the own registration and the own duties, new
// mentoring messages for the mentor, and a new event arriving live without a reload.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

/** A day [days] from today as YYYY-MM-DD. */
const inDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const top = async locator => (await locator.boundingBox()).y;

describe('start page (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('the greeting names the person; with nothing planned the page says so', async () => {
    const mia = await app.signIn('mia');
    await mia.page.locator('#home-greeting-title').getByText(/, Mia 👋$/).waitFor();
    await mia.page.locator('#home-upcoming').getByText('Nothing coming up right now', { exact: false }).waitFor();
    assert.equal(await mia.page.locator('#user-duties-home-card').count(), 0);
  });

  test('an overdue fee comes right after the greeting; a tap leads to the finances', async () => {
    // Members since January 2025 who never paid
    const mia = await app.signIn('mia');
    const fee = mia.page.locator('#user-status-card');
    await fee.getByText('open', { exact: false }).waitFor();
    assert.ok((await top(mia.page.locator('#home-greeting-title'))) < (await top(fee)), 'below the greeting');
    assert.ok((await top(fee)) < (await top(mia.page.locator('#home-upcoming'))), 'before what comes up');
    await fee.getByRole('button').click();
    await mia.page.locator('#user-finances-status-card').waitFor();
    await until(() => mia.page.url().endsWith('/finances'), 'the finances\' address');
  });

  test('what comes up next with the own registration, a tap opens it; the own duty below', async () => {
    const { http } = app;
    const party = await http.ok(http.call('owner', 'POST', '/api/events', { title: 'Summer party', date: inDays(3), startTime: '18:00', requiresRegistration: true }));
    await http.ok(http.call('max', 'POST', `/api/events/${party.event?.id || party.id}/register`, {}));
    await http.ok(http.call('owner', 'POST', '/api/events', {
      title: 'Clean-up', date: inDays(5), startTime: '09:00', eventType: 'termin', duties: [{ roleName: 'Coffee', assignedUser: http.uids.max }]
    }));

    const max = await app.signIn('max');
    const next = max.page.locator('#home-upcoming');
    const card = next.getByRole('button', { name: /Summer party/ });
    await card.waitFor();
    assert.match(await card.innerText(), /Registered/);
    await max.page.locator('#user-duties-home-card').getByText('Coffee').waitFor();
    await card.click();
    await max.page.locator('#detail-modal-title').getByText('Summer party').waitFor();
  });

  test('new mentoring messages show for the mentor; a tap opens the conversation', async () => {
    const { http } = app;
    const profile = await http.ok(http.call('max', 'POST', '/api/mentoring/apply', { bio: 'An open ear', maxMentees: 2 }));
    await http.ok(http.call('owner', 'POST', `/api/mentoring/manage/${profile.mentor.id}/status`, { status: 'approved' }));
    await http.ok(http.call('mia', 'POST', '/api/mentoring/threads', { mentorId: http.uids.max, message: 'Hello, may we talk?' }));

    const max = await app.signIn('max');
    const messages = max.page.locator('#user-mentoring-home-card');
    await messages.getByText('Hello, may we talk?').waitFor();
    await messages.getByText('Hello, may we talk?').click();
    await until(() => max.page.url().includes('/mentoring'), 'the mentoring page');
    await until(async () => (await max.page.locator('#mentoring-threads-layout').innerText()).includes('Hello, may we talk?'), 'the conversation');
  });

  test('a new event arrives live, without a reload', async () => {
    const mia = await app.signIn('mia');
    await mia.page.locator('#home-upcoming').getByRole('button', { name: /Summer party/ }).waitFor();
    await app.http.ok(app.http.call('owner', 'POST', '/api/events', { title: 'Choir rehearsal', date: inDays(1), startTime: '19:30', eventType: 'termin' }));
    await mia.page.locator('#home-upcoming').getByRole('button', { name: /Choir rehearsal/ }).waitFor({ timeout: 15000 });
  });
});
