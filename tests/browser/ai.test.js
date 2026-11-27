// The AI chat in the browser, against a stand-in for an OpenAI-compatible service (Chat Completions, streamed): the
// owner sets the service up, a question streams its thoughts and its formatted answer, a suggestion asks at once, the
// service's error shows in the chat, "New chat" starts again, and members without the permission do not get there.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { skipReason, startApp, until } = require('./harness');

/** The stand-in: streams thoughts, then the answer; a question with "fail" in it gets an error answer instead. */
function startFakeAi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'stand-in' }] }));
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        return res.end();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      requests.push({ headers: req.headers, body });
      const question = [...(body.messages || [])].reverse().find(message => message.role === 'user')?.content || '';
      if (/fail/.test(question)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'The model is busy' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = [{ reasoning: 'Looking at the calendar.' }, { content: 'Nothing is **planned** ' }, { content: 'this week.' }];
      for (const delta of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(done => server.close(done)) })
    );
  });
}

const input = page => page.getByRole('textbox', { name: 'Enter a message for the AI' });
async function ask(page, question) {
  await input(page).fill(question);
  await page.getByRole('button', { name: 'Send message' }).click();
}

describe('AI chat (browser)', { skip: skipReason || false }, () => {
  let app;
  let ai;
  before(async () => {
    ai = await startFakeAi();
    app = await startApp();
  });
  after(async () => {
    await app?.close();
    await ai?.close();
  });
  afterEach(() => app.endTest());

  test('the owner sets up an OpenAI-compatible service', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system/ai');
    const { page } = owner;
    await page.locator('label[for="super-admin-ai-enabled"]').click();
    await page.locator('#super-admin-ai-provider').selectOption('custom');
    await page.locator('#super-admin-ai-base-url').fill(ai.url);
    await page.locator('#super-admin-ai-api-key').fill('sk-stand-in');
    await page.locator('#super-admin-ai-model').fill('stand-in');
    await page.getByRole('button', { name: 'Save AI Settings' }).click();
    await owner.toast('AI settings saved');
  });

  test('a question streams the thoughts and the formatted answer; the service gets the question with the key', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/ai');
    await owner.page.getByText('How can I help?').waitFor();
    await ask(owner.page, 'What is coming up this week?');
    const main = owner.page.locator('main');
    await main.getByText('this week.', { exact: false }).waitFor();
    assert.equal(await main.locator('strong', { hasText: 'planned' }).count(), 1, 'the answer is formatted');
    assert.match(await main.locator('details').first().textContent(), /Looking at the calendar\./);
    // The input is empty again for the next question
    assert.equal(await input(owner.page).inputValue(), '');

    const sent = ai.requests.at(-1);
    assert.equal(sent.headers.authorization, 'Bearer sk-stand-in');
    assert.equal(sent.body.model, 'stand-in');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.messages[0].role, 'system');
    assert.equal(sent.body.messages.at(-1).content, 'What is coming up this week?');
  });

  test('a suggestion asks at once; "New chat" starts again', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/ai');
    const asked = ai.requests.length;
    await owner.page.getByRole('button', { name: /Which requests are still open\?/ }).click();
    await owner.page.locator('main').getByText('this week.', { exact: false }).waitFor();
    assert.equal(ai.requests.length, asked + 1);
    assert.equal(ai.requests.at(-1).body.messages.at(-1).content, 'Which requests are still open?');
    await owner.page.getByRole('button', { name: 'New chat' }).click();
    await owner.page.getByText('How can I help?').waitFor();
    await until(async () => (await owner.page.locator('main').getByText('this week.', { exact: false }).count()) === 0, 'the old answer to go');
  });

  test('an error of the service shows in the chat', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/ai');
    // The chat logs what went wrong
    owner.expectProblems(/^console error: AI chat error:/);
    await ask(owner.page, 'Please fail now');
    await owner.page.locator('main').getByText(/^Error: .*The model is busy/).waitFor();
  });

  test('members without the permission do not get to the AI', async () => {
    const max = await app.signIn('max');
    await max.go('/hub');
    await max.page.locator('main').getByText('Questions about the community, appointments and finances').waitFor({ state: 'detached' });
    await max.go('/ai');
    await until(() => !max.page.url().endsWith('/ai'), 'the way out of the AI page');
  });
});
