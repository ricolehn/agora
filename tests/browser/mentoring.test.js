// Mentoring in the browser: applying and being approved, contacting a mentor, the chat in both directions (the mentor
// sees a pseudonym, never the name), contacting again, the contact search, reporting, ending and reopening, blocking,
// a fully booked mentor, the review's filter and a list of mentors that failed to load.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
const chatMenu = async (page, entry) => {
  await page.locator('button[aria-label="Options"]:visible').first().click();
  await page.getByRole('menuitem', { name: entry }).click();
};
const firstThread = page => page.locator('#mentoring-threads-list [role="button"]:visible').first();
const messages = page => page.locator('#mentoring-threads-layout').innerText();

describe('mentoring (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a member applies as a mentor; a manager approves; the others find the mentor', async () => {
    const max = await app.signIn('max');
    await max.go('/mentoring');
    await max.page.locator('#mentor-apply-btn').click();
    await max.page.locator('#mentor-app-bio').fill('I listen and keep it to myself.');
    await max.page.locator('#mentor-app-max').fill('2');
    await max.page.locator('#btn-submit-mentor-app').click();
    await max.toast('Application submitted successfully!');

    const owner = await app.signIn('owner');
    await owner.go('/mentoring');
    await tab(owner.page, 'Applications');
    await owner.page.locator('#mentoring-review-list').getByText('Max Test').waitFor();
    await owner.page.locator('#mentoring-review-list').getByRole('button', { name: '✓ Approve' }).click();
    await owner.toast('Application approved successfully!');

    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await tab(mia.page, 'Find mentors');
    const card = mia.page.locator('#mentors-grid > div', { hasText: 'Max Test' });
    await card.getByRole('button', { name: 'Contact anonymously' }).waitFor();
    assert.match(await card.innerText(), /I listen and keep it to myself\./);
  });

  test('a member contacts the mentor; the mentor reads it under a pseudonym and answers; both see the conversation', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await tab(mia.page, 'Find mentors');
    await mia.page.getByRole('button', { name: 'Contact anonymously' }).click();
    await mia.page.locator('#mentor-contact-message').fill('Hello, may we talk?');
    await mia.page.locator('#btn-submit-mentor-contact').click();
    await mia.toast('Confidential request sent successfully!');
    await mia.page.locator('#mentoring-chat-input').waitFor();
    await until(async () => (await messages(mia.page)).includes('Hello, may we talk?'), 'the own message in the chat');

    const max = await app.signIn('max');
    await max.go('/mentoring');
    await firstThread(max.page).click();
    await until(async () => (await messages(max.page)).includes('Hello, may we talk?'), 'the message at the mentor');
    assert.doesNotMatch(await messages(max.page), /Mia/, 'the mentor never sees the name');
    await max.page.locator('#mentoring-chat-input').fill('Of course. When suits you?');
    await max.page.keyboard.press('Control+Enter');
    await until(async () => (await messages(max.page)).includes('Of course. When suits you?'), 'the answer at the mentor');
    // The open chat asks for new messages every few seconds
    await until(async () => (await messages(mia.page)).includes('Of course. When suits you?'), 'the answer at the member', 15000);
  });

  test('the mentor\'s card leads to the existing conversation instead of a second one', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await tab(mia.page, 'Find mentors');
    const card = mia.page.locator('#mentors-grid > div', { hasText: 'Max Test' });
    assert.equal(await card.getByRole('button', { name: 'Contact anonymously' }).count(), 0);
    await card.getByRole('button').last().click();
    await until(async () => (await messages(mia.page)).includes('Of course. When suits you?'), 'the existing conversation');
  });

  test('the contact search hides what does not match', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await firstThread(mia.page).waitFor();
    await mia.page.locator('#mentoring-threads-search-input').fill('nobody like this');
    await until(async () => (await mia.page.locator('#mentoring-threads-list [role="button"]:visible').count()) === 0, 'no contact to match');
    await mia.page.getByRole('button', { name: 'Clear search' }).click();
    await firstThread(mia.page).waitFor();
  });

  test('reporting, ending and reopening a conversation', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await firstThread(mia.page).click();
    await mia.page.locator('#mentoring-chat-input').waitFor();
    await chatMenu(mia.page, 'Report conversation');
    await mia.toast('Reported – thank you!');
    await chatMenu(mia.page, 'End conversation');
    await mia.toast('Conversation ended.');
    await mia.page.getByText('This conversation has ended.').waitFor();
    await mia.page.getByRole('button', { name: 'Reopen' }).click();
    await mia.toast('Conversation reopened.');
    await mia.page.locator('#mentoring-chat-input').waitFor();
  });

  test('the mentor blocks; only the mentor may reopen', async () => {
    const max = await app.signIn('max');
    await max.go('/mentoring');
    await firstThread(max.page).click();
    await max.page.locator('#mentoring-chat-input').waitFor();
    await chatMenu(max.page, 'Block');
    await max.toast('Conversation blocked.');
    await max.page.getByText('You blocked this conversation.').waitFor();
    assert.equal(await max.page.getByRole('button', { name: 'Reopen' }).count(), 1);

    const mia = await app.signIn('mia');
    await mia.go('/mentoring');
    await firstThread(mia.page).click();
    await mia.page.getByText('This conversation has been blocked.').waitFor();
    assert.equal(await mia.page.getByRole('button', { name: 'Reopen' }).count(), 0);
  });

  test('a fully booked mentor cannot be contacted', async () => {
    const { http } = app;
    const mila = await http.account('mila', 'Mila');
    const profile = await http.ok(http.call('mila', 'POST', '/api/mentoring/apply', { bio: 'An open ear', maxMentees: 1 }));
    await http.ok(http.call('owner', 'POST', `/api/mentoring/manage/${profile.mentor.id}/status`, { status: 'approved' }));
    await http.ok(http.call('treasurer', 'POST', '/api/mentoring/threads', { mentorId: mila }));
    const owner = await app.signIn('owner');
    await owner.go('/mentoring');
    await tab(owner.page, 'Find mentors');
    const full = owner.page.locator('#mentors-grid > div', { hasText: 'Mila Test' }).getByRole('button', { name: 'Fully booked' });
    await full.waitFor();
    assert.ok(await full.isDisabled());
  });

  test('the review filters by status: the approved mentor under "Approved", none left pending', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/mentoring');
    await tab(owner.page, 'Applications');
    const list = owner.page.locator('#mentoring-review-list');
    await list.getByText('No applications with status "Pending" found.').waitFor();
    await owner.page.locator('#mentor-review-filter').selectOption('approved');
    await list.getByText('Max Test').waitFor();
    assert.equal(await list.getByRole('button', { name: '✓ Approve' }).count(), 0);
    await owner.page.locator('#mentor-review-filter').selectOption('pending');
    await list.getByText('No applications with status "Pending" found.').waitFor();
  });

  test('mentors that failed to load say so; the next visit of "Find mentors" shows them', async () => {
    const mia = await app.signIn('mia');
    mia.expectProblems(/^500 GET \/api\/mentoring\/mentors/);
    let refuse = true;
    await mia.page.route('**/api/mentoring/mentors*', route =>
      refuse ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not now' }) }) : route.fallback()
    );
    await mia.go('/mentoring');
    await tab(mia.page, 'Find mentors');
    await mia.page.locator('#mentors-grid').getByText('Mentors could not be loaded.').waitFor();
    refuse = false;
    await tab(mia.page, 'Messages');
    await tab(mia.page, 'Find mentors');
    await mia.page.locator('#mentors-grid > div', { hasText: 'Max Test' }).waitFor();
  });
});
