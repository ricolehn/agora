// The codecs between what the apps write and what the new tables keep (backend/db/codec.js): whatever an app wrote
// comes back exactly - same keys, same values, same types - and what the current apps write needs no `original`.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { BACKEND_DIR } = require('./helpers');
const path = require('path');

const { toCents, amountValue, fromCents, createCodec, fieldKinds } = require(path.join(BACKEND_DIR, 'db', 'codec'));
const finance = require(path.join(BACKEND_DIR, 'db', 'codecs', 'finance'));

// A small seeded random generator: the same objects on every run (a failure can be repeated)
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  return { next, pick };
}

const ODD_VALUES = [
  undefined, null, '', ' ', 0, 1, -1, 50, 49.99, 0.1, 0.30000000000000004, 33.333, 1e21, 1e-7, -10.5, Number.MAX_SAFE_INTEGER,
  '50', '50,00', '1.234,50', '1,234.50', 'fünfzig', '12.5', '0', '-5', true, false, [], [1, 'a'], {}, { a: 1 },
  '2026-01-03', '2026-1-3', '2020-06-03T00:00:00.000Z', '07/15/2020', '15.07.2020', 'kein Datum', '2026-02-30',
  'vollverdiener', 'geringverdiener', 'keinverdiener', 'pausiert', 'student', 'payment', 'expense', 'status', 'standing_order',
  'pending', 'approved', 'rejected', 'refund', 1700000000000, 'req_abc', 'auto_so1_2026-01-01', '-Nabc', 'abc123def456ghi', '__proto__'
];

/** A random object with keys from [keys] (and now and then an unknown one), values from ODD_VALUES. */
function randomObject(rand, keys) {
  const object = {};
  for (const key of keys) if (rand.next() < 0.7) {
    const value = rand.pick(ODD_VALUES);
    if (value !== undefined) object[key] = value;
  }
  if (rand.next() < 0.2) object[rand.pick(['notes', 'telefon', '_eigen', 'grund', 'zweck', 'x-y'])] = rand.pick(ODD_VALUES.filter((v) => v !== undefined));
  return object;
}

const roundTrip = (codec, object, ctx = {}) => {
  const encoded = codec.encode(object, ctx);
  return { encoded, back: codec.decode({ ...encoded.columns, original: JSON.parse(JSON.stringify(encoded.original)) }) };
};

describe('amounts in cents', () => {
  test('whole cents are worked out from the digits, never by multiplying', () => {
    assert.deepEqual(toCents(1.005), { cents: 101, exact: false }); // three decimals: not a whole cent, rounded by its digits
    assert.deepEqual(toCents(-1.005), { cents: -101, exact: false });
    assert.deepEqual(toCents(1e21), { cents: 1e23, exact: false });
    assert.deepEqual(toCents(49.99), { cents: 4999, exact: true });
    assert.deepEqual(toCents(0.1), { cents: 10, exact: true });
    assert.deepEqual(toCents(-10.5), { cents: -1050, exact: true });
    assert.deepEqual(toCents(0), { cents: 0, exact: true });
    assert.deepEqual(toCents(33.333), { cents: 3333, exact: false });
    assert.deepEqual(toCents(0.30000000000000004), { cents: 30, exact: false });
    for (let cents = -100000; cents <= 100000; cents += 7) {
      const amount = cents / 100;
      assert.deepEqual(toCents(amount), { cents, exact: true }, String(amount));
      assert.equal(fromCents(cents), amount);
    }
  });

  test('text amounts are read the way the server always read them', () => {
    assert.equal(amountValue('1.234,50'), 1234.5);
    assert.equal(amountValue('50,00'), 50);
    assert.equal(amountValue('12.5'), 12.5);
    assert.equal(amountValue('fünfzig'), 0);
    assert.equal(amountValue(null), 0);
  });
});

describe('finance codecs', () => {
  const kinds = {
    payment: [finance.payment, ['id', 'amount', 'date', 'description', 'receipt', 'isAuto']],
    statusPeriod: [finance.statusPeriod, ['id', 'status', 'startDate', 'endDate']],
    standingOrder: [finance.standingOrder, ['id', 'amount', 'startDate', 'endDate', 'note', 'lastAutoPayment']],
    donation: [finance.donation, ['id', 'amount', 'name', 'date', 'description']],
    expense: [finance.expense, ['id', 'amount', 'description', 'issuer', 'date', 'receipt']],
    member: [finance.member, ['id', 'uid', 'name', 'status', 'memberSince', 'originalMemberSince', 'pays', 'isDeleted']]
  };

  for (const [name, [codec, keys]] of Object.entries(kinds)) {
    test(`${name}: 5000 random records come back exactly`, () => {
      const rand = random(name.length * 7919);
      for (let i = 0; i < 5000; i += 1) {
        const object = randomObject(rand, keys);
        const ctx = { recordId: typeof object.id === 'string' && object.id ? object.id : 'record1', exists: (collection, id) => id === 'abc123def456ghi' };
        const { back } = roundTrip(codec, object, ctx);
        assert.deepStrictEqual(back, object, JSON.stringify(object));
      }
    });
  }

  test('request: 5000 random requests (with what they ask for) come back exactly', () => {
    const rand = random(4242);
    for (let i = 0; i < 5000; i += 1) {
      const object = randomObject(rand, ['id', 'type', 'userId', 'personId', 'personName', 'status', 'timestamp', 'decidedAt', 'rejectionReason']);
      if (rand.next() < 0.85) object.data = rand.next() < 0.9 ? randomObject(rand, ['amount', 'date', 'note', 'description', 'receipt', 'newStatus']) : rand.pick(ODD_VALUES.filter((v) => v !== undefined));
      const ctx = { recordId: 'req1', exists: () => true };
      const { back } = roundTrip(finance.request, object, ctx);
      assert.deepStrictEqual(back, object, JSON.stringify(object));
    }
  });

  test('what the current apps write needs no `original`', () => {
    const clean = (codec, object, ctx = {}) => assert.equal(codec.encode(object, ctx).original, null, JSON.stringify(object));
    clean(finance.payment, { amount: 50, date: '2026-01-03', description: 'Beitrag', id: 1700000007919 });
    clean(finance.payment, { id: 'auto_so1_2026-02-01', amount: 50, date: '2026-02-01', description: 'Dauerauftrag (Auto)', isAuto: true });
    clean(finance.payment, { id: 'req_abc', amount: 30, date: '2026-07-01', description: 'Bar gegeben' });
    clean(finance.statusPeriod, { status: 'vollverdiener', startDate: '2025-01-01' });
    clean(finance.statusPeriod, { status: 'vollverdiener', startDate: '2025-01-01', endDate: '2026-01-01' });
    clean(finance.standingOrder, { id: 'so1', amount: 50, startDate: '2026-01-01', note: 'Dauerauftrag', lastAutoPayment: null });
    clean(finance.standingOrder, { id: 'so1', amount: 50, startDate: '2026-01-01', note: 'Dauerauftrag', lastAutoPayment: '2026-05-01', endDate: '2026-06-30' });
    clean(finance.donation, { amount: 100, name: 'Anonym', date: '2026-01-06', description: 'Kollekte', id: 1736000000000 });
    clean(finance.expense, { id: 1710000000001, amount: 89.9, description: 'Beamer-Lampe', issuer: 'Theo', date: '2024-03-04' });
    clean(finance.expense, { id: 'req_x', amount: 45.5, description: 'Bastelmaterial', issuer: 'Mia', date: '2026-06-20', receipt: 'beleg.png' });
    clean(finance.request, { id: 'r1', type: 'payment', userId: 'u1', personId: 'u1', personName: 'Max', data: { amount: '30', date: '2026-07-01', note: 'Bar' }, status: 'pending', timestamp: 1700000000000 }, { recordId: 'r1' });
    clean(finance.request, { id: 'r2', type: 'expense', userId: 'u1', personId: 'u1', personName: 'Max', data: { amount: '45.5', description: 'Material', date: '2026-06-20', receipt: 'b.png' }, status: 'approved', timestamp: 1700000000000, decidedAt: 1700000500000 }, { recordId: 'r2' });
    clean(finance.request, { id: 'r3', type: 'status', userId: 'u1', personId: 'u1', personName: 'Max', data: { newStatus: 'keinverdiener', date: '2026-08-01' }, status: 'rejected', timestamp: 1700000000000, decidedAt: 1700000500000, rejectionReason: 'Bitte Nachweis' }, { recordId: 'r3' });
    clean(finance.member, { id: 'u1', uid: 'u1', name: 'Max Muster', status: 'vollverdiener', memberSince: '2021-01-01', originalMemberSince: '2021-01-01', pays: true }, { recordId: 'u1', exists: () => true });
    clean(finance.member, { id: 'g1', uid: '', name: 'Gerd', status: '', memberSince: '', originalMemberSince: '', isDeleted: true }, { recordId: 'g1' });
  });

  test('values the columns cannot show stay in `original`, the columns hold what the server reads', () => {
    const odd = finance.payment.encode({ amount: '1.234,50', date: '07/15/2020', description: 'alt' });
    assert.equal(odd.columns.amountCents, 123450);
    assert.equal(odd.columns.date, '2020-07-15');
    assert.deepEqual(odd.original.values, { amount: '1.234,50', date: '07/15/2020' });
    const unreadable = finance.payment.encode({ amount: 'fünfzig', date: '2020-04-03', description: 'x', id: 'p' });
    assert.equal(unreadable.columns.amountCents, 0, 'counts as nothing, as it always did');
    assert.deepEqual(unreadable.original.values, { amount: 'fünfzig' });
    const fraction = finance.payment.encode({ amount: 33.333, date: '2020-05-03', description: 'x', id: 'p' });
    assert.equal(fraction.columns.amountCents, 3333);
    assert.deepEqual(fraction.original.values, { amount: 33.333 });
    // A link to an account that does not exist (any more) is no link; the id stays for older apps
    const gone = finance.member.encode({ id: 'm1', uid: 'deadbeefdeadbee', name: 'X', status: 'vollverdiener', memberSince: '', originalMemberSince: '', pays: true }, { recordId: 'm1', exists: () => false });
    assert.equal(gone.columns.user, '');
    assert.deepEqual(gone.original.values, { uid: 'deadbeefdeadbee' });
  });

  test('a key named __proto__ stays an ordinary key', () => {
    const codec = createCodec({ fields: { a: fieldKinds.text('a') }, canonicalKeys: () => ['a'] });
    const object = JSON.parse('{"a": "x", "__proto__": {"polluted": true}}');
    const back = codec.decode({ ...codec.encode(object).columns, original: JSON.parse(JSON.stringify(codec.encode(object).original)) });
    assert.deepStrictEqual(back, object);
    assert.equal({}.polluted, undefined);
  });
});

describe('community codecs', () => {
  const community = require(path.join(BACKEND_DIR, 'db', 'codecs', 'community'));
  const items = require(path.join(BACKEND_DIR, 'db', 'stores', 'items'));
  const { buildSong } = require(path.join(BACKEND_DIR, 'songbook'));
  const { buildPrayer } = require(path.join(BACKEND_DIR, 'prayers'));
  const { buildPoll, castVote, endPoll } = require(path.join(BACKEND_DIR, 'polls'));
  // As PocketBase hands the record back: its date fields with a space instead of the T
  const DATE_COLUMNS = ['created', 'updated', 'expiresAt', 'endsAt'];
  const stored = (body) => {
    const row = JSON.parse(JSON.stringify(body));
    for (const column of DATE_COLUMNS) if (typeof row[column] === 'string') row[column] = row[column].replace('T', ' ');
    return row;
  };
  const itemRoundTrip = (kind, item, recordId = 'item1') => {
    const body = items.itemBody(kind, item, { recordId, exists: (collection, id) => id === 'abc123def456ghi' });
    return items.decodeItem(kind, stored({ id: recordId, ...body }));
  };

  const kinds = {
    songs: ['id', 'title', 'artist', 'key', 'capo', 'tempo', 'ccli', 'copyright', 'content', 'createdAt', 'updatedAt'],
    prayers: ['id', 'text', 'anonymous', 'authorUid', 'authorName', 'owner', 'createdAt', 'expiresAt'],
    polls: ['id', 'title', 'description', 'options', 'multiple', 'createdAt', 'endsAt', 'creator', 'tallies', 'voters']
  };
  for (const [kind, keys] of Object.entries(kinds)) {
    test(`${kind}: 5000 random items come back exactly (also items that are no objects)`, () => {
      const rand = random(kind.length * 104729);
      for (let i = 0; i < 5000; i += 1) {
        const object = rand.next() < 0.05 ? rand.pick(ODD_VALUES.filter((v) => v !== undefined)) : randomObject(rand, keys);
        assert.deepStrictEqual(itemRoundTrip(kind, object, typeof object?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(object.id) ? object.id : 'item1'), object, JSON.stringify(object));
      }
    });
  }

  test('the order of service: 5000 random items come back exactly', () => {
    const rand = random(31337);
    for (let i = 0; i < 5000; i += 1) {
      const object = randomObject(rand, ['id', 'title', 'minutes', 'who', 'note', 'songId', 'songKey']);
      const { back } = roundTrip(require(path.join(BACKEND_DIR, 'db', 'codecs', 'events')).programItem, object, { recordId: 'p1', exists: (collection, id) => id === 'abc123def456ghi' });
      assert.deepStrictEqual(back, object, JSON.stringify(object));
    }
  });

  test('what the current routes write needs no `original`', () => {
    const clean = (kind, item, exists = () => true) => assert.equal(items.itemBody(kind, item, { recordId: item.id, exists }).original, null, JSON.stringify(item));
    clean('songs', buildSong({ title: 'Amazing Grace', content: '[G]Amazing', key: 'G', ccli: '22025' }).song);
    clean('songs', buildSong({ title: 'Mit Tempo', content: 'x', tempo: 72, capo: 3 }).song);
    const secret = 'x'.repeat(64);
    clean('prayers', buildPrayer({ text: 'Für die Kranken' }, { uid: 'abc123def456ghi', name: 'Max', secret }).prayer);
    clean('prayers', buildPrayer({ text: 'Anonym bitte', anonymous: true, duration: 'week' }, { uid: 'abc123def456ghi', name: 'Max', secret }).prayer);
    const { poll } = buildPoll({ title: 'Wohin?', options: ['Berge', 'See'], endsAt: Date.now() + 86400000 }, { uid: 'u1', secret });
    clean('polls', poll);
    const voted = castVote(poll, ['o1'], { uid: 'u2', secret }).poll;
    clean('polls', voted);
    clean('polls', endPoll(voted));
  });
});
