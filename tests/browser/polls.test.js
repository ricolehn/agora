// Anonymous polls in the browser: starting one, voting (a choice is needed; the own choice stays on the device),
// the result once a poll with three votes ends, the secret result of one with fewer, deleting (also one the server
// refuses, and one deleted elsewhere while it is open), a refused start.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

/** Starts a poll through the add button: [question], [answers] (more than two adds fields), ending after [ends]. */
async function startPoll(page, question, answers, ends = '3 days') {
  await page.locator('#desktop-fab').click();
  await page.locator('#poll-question').fill(question);
  for (let i = 2; i < answers.length; i++) await page.locator('#poll-add-option').click();
  const fields = page.locator('#poll-options input');
  for (const [i, answer] of answers.entries()) await fields.nth(i).fill(answer);
  await page.locator('#poll-create-modal').getByRole('button', { name: ends, exact: true }).click();
  await page.locator('#poll-submit').click();
}
const card = (page, question) => page.locator('#polls-list').getByRole('button', { name: new RegExp(question) });

/** Opens [question] and votes for [answer]. */
async function vote(session, question, answer) {
  await session.go('/polls');
  await card(session.page, question).click();
  await session.page.locator('#poll-detail-modal label', { hasText: answer }).click();
  await session.page.locator('#poll-vote-btn').click();
  await session.toast('Your vote was counted anonymously.');
}

describe('polls (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a member starts a poll with three answers; it shows as running and as theirs', async () => {
    const max = await app.signIn('max');
    await max.go('/polls');
    await startPoll(max.page, 'Where shall we meet?', ['Hall', 'Garden', 'Café']);
    await max.toast('Poll started');
    const text = await card(max.page, 'Where shall we meet?').innerText();
    assert.match(text, /Running/);
    assert.match(text, /Yours/);
  });

  test('voting needs a choice; the vote counts, the choice stays on this device, the result waits for the end', async () => {
    const mia = await app.signIn('mia');
    await mia.go('/polls');
    await card(mia.page, 'Where shall we meet?').click();
    await mia.page.locator('#poll-vote-btn').click();
    await mia.toast('Please choose an answer.');
    await mia.page.locator('#poll-detail-modal label', { hasText: 'Garden' }).click();
    await mia.page.locator('#poll-vote-btn').click();
    await mia.toast('Your vote was counted anonymously.');
    const dialog = mia.page.locator('#poll-detail-modal');
    await dialog.getByText('You have voted.', { exact: false }).waitFor();
    assert.match(await dialog.innerText(), /Your choice \(only saved on this device\): Garden/);
  });

  test('with three votes, ending the poll shows the result, the most chosen answer first', async () => {
    await vote(await app.signIn('owner'), 'Where shall we meet?', 'Garden');
    await vote(await app.signIn('treasurer'), 'Where shall we meet?', 'Hall');
    const max = await app.signIn('max');
    await max.go('/polls');
    await card(max.page, 'Where shall we meet?').click();
    await max.page.getByRole('button', { name: 'End now' }).click();
    const dialog = max.page.locator('#poll-detail-modal');
    await dialog.getByText('67% · 2').waitFor();
    const rows = await dialog.locator('text=/\\d+% · \\d+/').allInnerTexts();
    assert.deepEqual(rows, ['67% · 2', '33% · 1', '0% · 0']);
    await max.page.keyboard.press('Escape');
    await max.page.getByRole('tab', { name: 'Finished' }).click();
    assert.match(await card(max.page, 'Where shall we meet?').innerText(), /Garden/);
  });

  test('a poll ended with fewer than three votes keeps its result secret', async () => {
    const max = await app.signIn('max');
    await max.go('/polls');
    await startPoll(max.page, 'Tea or coffee?', ['Tea', 'Coffee'], '1 day');
    await max.toast('Poll started');
    await vote(await app.signIn('mia'), 'Tea or coffee?', 'Tea');
    await max.go('/polls');
    await card(max.page, 'Tea or coffee?').click();
    await max.page.getByRole('button', { name: 'End now' }).click();
    await max.page.locator('#poll-detail-modal').getByText('Too few votes', { exact: false }).waitFor();
  });

  test('the one who started a poll deletes it', async () => {
    const max = await app.signIn('max');
    await max.go('/polls');
    await max.page.getByRole('tab', { name: 'Finished' }).click();
    await card(max.page, 'Tea or coffee?').click();
    await max.page.locator('#poll-detail-modal').getByRole('button', { name: 'Delete' }).click();
    await max.toast('Poll deleted');
    await until(async () => (await card(max.page, 'Tea or coffee?').count()) === 0, 'the poll to go');
  });

  test('a poll deleted elsewhere while it is open here: the dialog closes with a note', async () => {
    const { http } = app;
    const poll = await http.ok(http.call('mia', 'POST', '/api/polls', { title: 'Picnic on Sunday?', options: ['Yes', 'No'], multiple: false, endsAt: Date.now() + 3 * 86400000 }));
    const max = await app.signIn('max');
    await max.go('/polls');
    await card(max.page, 'Picnic on Sunday?').click();
    await max.page.locator('#poll-detail-modal label', { hasText: 'Yes' }).waitFor();
    await http.ok(http.call('mia', 'DELETE', `/api/polls/${poll.id}`));
    await max.toast('This poll was deleted.');
    await until(async () => !(await max.page.locator('#poll-detail-modal').isVisible()), 'the dialog to close');
    assert.equal(await card(max.page, 'Picnic on Sunday?').count(), 0);
  });

  test('a deletion the server refuses: the poll leaves at once and comes back with the reason', async () => {
    const { http } = app;
    await http.ok(http.call('max', 'POST', '/api/polls', { title: 'Choir on Friday?', options: ['Yes', 'No'], multiple: false, endsAt: Date.now() + 3 * 86400000 }));
    const max = await app.signIn('max');
    await max.go('/polls');
    max.expectProblems(/^500 DELETE \/api\/polls\//);
    let answer = null;
    await max.page.route('**/api/polls/*', async route => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await new Promise(resolve => (answer = resolve));
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not deleted' }) });
    });
    await card(max.page, 'Choir on Friday?').click();
    await max.page.locator('#poll-detail-modal').getByRole('button', { name: 'Delete' }).click();
    await until(async () => (await card(max.page, 'Choir on Friday?').count()) === 0, 'the poll to leave at once');
    await until(async () => !(await max.page.locator('#poll-detail-modal').isVisible()), 'the dialog to close at once');
    await until(() => answer !== null, 'the deletion to be asked');
    answer();
    await max.toast('Not deleted');
    await card(max.page, 'Choir on Friday?').waitFor();
  });

  test('a start the server refuses shows its reason, and the dialog stays', async () => {
    const max = await app.signIn('max');
    await max.go('/polls');
    max.expectProblems(/^500 POST \/api\/polls$/);
    await max.page.route('**/api/polls', route =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not right now' }) }) : route.fallback()
    );
    await startPoll(max.page, 'Refused?', ['Yes', 'No']);
    await max.toast('Not right now');
    assert.equal(await max.page.locator('#poll-question').inputValue(), 'Refused?');
  });
});
