// The finances in the browser: a member's requests (a payment the treasurer approves, an expense with its receipt
// rejected with a reason the member reads, a status change), the treasurer's bookings (a payment from the fee list,
// a donation, an expense) with the balance, the history and its search, the report as a PDF, the fees only a system
// admin changes, and a booking the server refuses.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

// The smallest PDF a receipt can be
const RECEIPT = { name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };

/** Opens the own finances page and there the request dialog of [action] ('Report a payment', 'Get refunded', ...). */
async function openRequest(session, action) {
  await session.go('/finances');
  await session.page.getByRole('button', { name: action, exact: true }).click();
  await session.page.locator('#user-request-modal').waitFor();
}
async function submitRequest(session) {
  await session.page.locator('#btn-submit-request').click();
  await session.toast('Request sent successfully');
}
/** The treasurer opens the open request of [name] on the finances overview. */
async function openOpenRequest(session, name) {
  await session.go('/finances');
  await session.page.locator('#admin-requests-inline').getByRole('button', { name: new RegExp(name) }).first().click();
  await session.page.locator('#request-detail-modal').waitFor();
}
const myRequests = page => page.locator('#user-requests-list');
const history = page => page.locator('#history-page-list');
/** A booking through the action button of the finances tab ('Record donation' or 'Book expense'). */
async function fab(page, item) {
  await page.locator('#desktop-fab').click();
  await page.locator('#fabMenu').getByRole('button', { name: new RegExp(item) }).click();
}

describe('finances (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('a member reports a payment: the form says what is missing; the treasurer approves; the member sees it booked', async () => {
    const max = await app.signIn('max');
    await openRequest(max, 'Report a payment');
    await max.page.locator('#btn-submit-request').click();
    await max.toast('Please fill out all fields.');
    await max.page.locator('#req-amount').fill('a lot');
    await max.page.locator('#btn-submit-request').click();
    await max.toast('Invalid amount. Please enter it like 1500 or 1,500.00.');
    await max.page.locator('#req-amount').fill('25');
    await max.page.locator('#req-note').fill('November fee');
    await submitRequest(max);
    await myRequests(max.page).getByText('Under review').waitFor();

    const theo = await app.signIn('treasurer');
    // The start page of those who decide shows the open request too
    await theo.page.locator('#home-finance-requests').getByText('Max Test').waitFor();
    await openOpenRequest(theo, 'Max Test');
    assert.match(await theo.page.locator('#request-detail-modal').innerText(), /November fee/);
    await theo.page.locator('#request-detail-modal').getByRole('button', { name: 'Approve' }).click();
    await theo.toast('Request approved');
    await until(async () => (await theo.page.locator('#admin-requests-inline').count()) === 0, 'no open request left');

    await max.go('/finances');
    await myRequests(max.page).getByText('Approved').waitFor();
    await max.page.locator('#user-payment-history').getByText('November fee').waitFor();
  });

  test('an expense with its receipt, rejected with a reason the member reads', async () => {
    const mia = await app.signIn('mia');
    await openRequest(mia, 'Get refunded');
    await mia.page.locator('#req-amount').fill('12.50');
    await mia.page.locator('#req-desc').fill('Flowers for the hall');
    await mia.page.locator('#req-receipt').setInputFiles(RECEIPT);
    await mia.page.locator('#user-request-modal').getByText('receipt.pdf').waitFor();
    await submitRequest(mia);

    const theo = await app.signIn('treasurer');
    await openOpenRequest(theo, 'Mia Test');
    const dialog = theo.page.locator('#request-detail-modal');
    assert.match(await dialog.innerText(), /Flowers for the hall/);
    // The receipt under the name the server gave it
    await dialog.getByText(/\.pdf$/).first().waitFor();
    await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
    await theo.page.locator('#reqd-reject-reason').fill('Please bring the receipt from the shop');
    await dialog.getByRole('button', { name: 'Reject request' }).click();
    await theo.toast('Request rejected');

    await mia.go('/finances');
    await myRequests(mia.page).getByText('Rejected').waitFor();
    await myRequests(mia.page).getByText('Reason: Please bring the receipt from the shop').waitFor();
  });

  test('a status change, once approved, is the member\'s status', async () => {
    const max = await app.signIn('max');
    await openRequest(max, 'Change status');
    await max.page.locator('#req-status').selectOption('geringverdiener');
    await submitRequest(max);

    const theo = await app.signIn('treasurer');
    await openOpenRequest(theo, 'Max Test');
    await theo.page.locator('#request-detail-modal').getByRole('button', { name: 'Approve' }).click();
    await theo.toast('Request approved');

    await max.go('/finances');
    await max.page.locator('#user-finances-status-card').getByRole('button', { name: 'Request status change' }).getByText('Low earner').waitFor();
  });

  test('the treasurer books a payment from the fee list; the member sees it in the history', async () => {
    const theo = await app.signIn('treasurer');
    await theo.go('/finances/members');
    await theo.page.locator('#people-search').fill('Mia');
    await theo.page.locator('#peopleList [role="button"]', { hasText: 'Mia Test' }).click();
    await theo.page.locator('#peopleList').getByRole('button', { name: 'Record payment' }).click();
    await theo.page.locator('#payment-amount').fill('30');
    await theo.page.locator('#payment-desc').fill('Cash at the door');
    await theo.page.locator('#btn-add-payment').click();
    await theo.toast('Payment booked');

    const mia = await app.signIn('mia');
    await mia.go('/finances');
    await mia.page.locator('#user-payment-history').getByText('Cash at the door').waitFor();
  });

  test('a donation and an expense: the balance, the history, its search and a booking\'s details', async () => {
    const theo = await app.signIn('treasurer');
    await theo.go('/finances');
    await fab(theo.page, 'Record donation');
    await theo.page.locator('#donation-amount').fill('50');
    await theo.page.locator('#donation-name').fill('Anna Giver');
    await theo.page.locator('#donation-desc').fill('For the roof');
    await theo.page.locator('#btn-add-donation').click();
    await theo.toast('Donation saved');
    await fab(theo.page, 'Book expense');
    await theo.page.locator('#expense-amount').fill('20');
    await theo.page.locator('#expense-issuer').fill('Hardware store');
    await theo.page.locator('#expense-desc').fill('Screws');
    await theo.page.locator('#expense-receipt').setInputFiles(RECEIPT);
    await theo.page.locator('#btn-add-expense').click();
    await theo.toast('Expense saved');

    // 25 and 30 paid, 50 given, 20 spent (the rejected expense counts for nothing)
    await theo.page.getByText('€85.00').waitFor();
    await history(theo.page).getByText('Anna Giver').waitFor();
    await history(theo.page).getByText('Hardware store').waitFor();
    await theo.page.locator('#history-search').fill('Screws');
    await until(async () => (await history(theo.page).getByText('Anna Giver').count()) === 0, 'the search to hide the donation');
    await history(theo.page).getByText('Hardware store').waitFor();
    await theo.page.getByRole('button', { name: 'Clear search' }).click();
    await history(theo.page).getByText('Anna Giver').click();
    const details = theo.page.locator('#transaction-details-modal');
    await details.getByText('For the roof').waitFor();
    assert.match(await details.innerText(), /Anna Giver/);
  });

  test('the report of the year downloads as a PDF', async () => {
    const theo = await app.signIn('treasurer');
    await theo.go('/finances');
    await theo.page.locator('#btn-open-export-report').click();
    const dialog = theo.page.locator('#export-report-modal');
    const download = dialog.getByRole('button', { name: 'Download PDF' });
    await until(() => download.isEnabled(), 'the bookings of the year');
    const [file] = await Promise.all([theo.page.waitForEvent('download', { timeout: 30000 }), download.click()]);
    assert.match(file.suggestedFilename(), /^Testgemeinde_Financial_Report_\d{4}-\d{2}-\d{2}\.pdf$/);
    const chunks = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-');
  });

  test('the owner changes the fees; the treasurer only reads them', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/settings/fees');
    await owner.page.locator('#btn-fee-change').click();
    await owner.page.locator('#fee-change-vollverdiener').fill('35');
    await owner.page.locator('#btn-fee-change-review').click();
    await owner.page.locator('#fee-change-review').waitFor();
    await owner.page.locator('#btn-fee-change-confirm').click();
    await owner.toast('Fees saved');
    await owner.page.locator('#card-rates').getByText('€35.00').first().waitFor();

    const theo = await app.signIn('treasurer');
    await theo.go('/settings/fees');
    await theo.page.locator('#card-rates').getByText('€35.00').first().waitFor();
    await theo.page.locator('#fee-plan-readonly').waitFor();
    assert.equal(await theo.page.locator('#btn-fee-change').count(), 0);
  });

  test('a booking the server refuses says so, and the dialog keeps what was typed', async () => {
    const theo = await app.signIn('treasurer');
    await theo.go('/finances');
    theo.expectProblems(/^500 POST \/api\/db\/transaction$/);
    theo.expectProblems(/^console error: Saving the donation failed:/);
    await theo.page.route('**/api/db/transaction', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Not right now' }) })
    );
    await fab(theo.page, 'Record donation');
    await theo.page.locator('#donation-amount').fill('10');
    await theo.page.locator('#donation-name').fill('Refused');
    await theo.page.locator('#btn-add-donation').click();
    await theo.toast('Donation could not be saved. Please try again.');
    assert.equal(await theo.page.locator('#donation-name').inputValue(), 'Refused');
  });
});
