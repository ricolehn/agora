// API v2 shows the numbers of the old API: what a member has paid and until when, on an instance that was upgraded
// (members whose old records disagreed with themselves among them) and whose server runs ahead of UTC, as most do -
// and its money adds up as the app's statistics count it.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { POCKETBASE_BIN, stop } = require('./instance');
const { oldInstance } = require('./upgradeHarness');

describe('API v2 and the old API', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('every member has paid the same and until the same day in both, also east of Greenwich - and the money adds up as the statistics count it', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    const backend = await old.start({ TZ: 'Europe/Berlin' });
    t.after(() => stop(backend.process));
    const { call, ok } = old.http;

    const people = await ok(call('treasurer', 'GET', '/api/db?path=people'));
    const members = (await ok(call('treasurer', 'GET', '/api/v2/members?includeDeleted=1&limit=500'))).items;
    const dayInBerlin = (moment) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(moment));
    let withPaidUntil = 0;
    let checked = 0;
    for (const member of members) {
      const person = people[member.key];
      if (!person) continue;
      checked += 1;
      assert.equal(member.totalPaidCents, Math.round(person.totalPaid * 100), `${member.name}: paid in all`);
      assert.equal(member.balanceCents, Math.round(person._currentBalance * 100), `${member.name}: balance`);
      // The old API hands the day out as its midnight in the server's time zone; the web app reads it in local time
      assert.equal(member.paidUntil, person._paidUntil ? dayInBerlin(person._paidUntil) : null, `${member.name}: paid until`);
      if (member.paidUntil) withPaidUntil += 1;
    }
    assert.ok(checked >= 9 && withPaidUntil >= 5, `members compared: ${checked}, with a day: ${withPaidUntil}`);
    // A month is paid until its last day - never the day before it
    for (const member of members.filter((entry) => entry.paidUntil)) {
      const next = new Date(`${member.paidUntil}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      assert.equal(next.getUTCDate(), 1, `${member.name} is paid until the last day of a month (${member.paidUntil})`);
    }
    // Erna's old record said "0 paid" in its list column next to a payment of 40: the payment counts
    const erna = members.find((member) => member.key === '-NalteMitgliedXY');
    assert.equal(erna.totalPaidCents, 4000);

    // A member's total is what its payments add up to as /payments lists them
    const payments = [];
    for (let cursor = ''; ;) {
      const page = await ok(call('treasurer', 'GET', `/api/v2/payments?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      payments.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const member of members) {
      const own = payments.filter((payment) => payment.memberId === member.id && Number.isSafeInteger(payment.amountCents));
      assert.equal(member.totalPaidCents, own.reduce((sum, payment) => sum + payment.amountCents, 0), `${member.name}: the sum of the payments`);
    }
    // The cash balance of the books is the statistics' one: with an amount nobody can read (it counts 0), a payment
    // without a day, the payment of a member that has no record (the app never shows it) - the summary used to count
    // that payment and what is dated later, and named another balance than the app
    const stats = await ok(call('treasurer', 'GET', '/api/stats'));
    const summary = await ok(call('treasurer', 'GET', '/api/v2/finance/summary'));
    assert.equal(typeof stats.totalBalance, 'number', 'the statistics have a balance');
    assert.equal(summary.totalsCents.balance, Math.round(stats.totalBalance * 100));
    assert.equal(summary.totalsCents.balance, summary.totalsCents.memberPayments + summary.totalsCents.donations - summary.totalsCents.expenses);
    // The database's own money per month (finance_monthly_totals, for whoever reads the database itself) is the books'
    // too: it counted the payment of the member without a record
    const view = await old.su.request('GET', '/api/collections/finance_monthly_totals/records?perPage=500&sort=month');
    const byKind = (rows) => rows.reduce((sums, row) => ({ ...sums, [row.kind]: (sums[row.kind] || 0) + row.totalCents }), {});
    assert.deepEqual(byKind(view.items), byKind([...summary.months, ...summary.planned]));
  });
});
