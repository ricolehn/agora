#!/usr/bin/env node
// How fast the books answer on large instances, before and after the upgrade:
//
//   POCKETBASE_BIN=/path/to/pocketbase node tests/benchmark.js [members:years ...]   (default 50:10 150:20 300:30)
//
// For each size an old instance is filled straight in PocketBase (members paying every month for that many years),
// the reads the apps make most are timed on the frozen backend - read again, and read first after a booking (as the
// web app books) and after an unrelated change (a prayer request made and deleted) - the upgrade runs (timed), and
// the same is timed on the current backend, with the matching reads of API v2. Prints the medians of five runs.
const fs = require('fs');
const path = require('path');
const {
  POCKETBASE_BIN, PASSWORD, LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop
} = require('./instance');
const { BACKEND_DIR } = require('./helpers');

const legacyStore = require(path.join(BACKEND_DIR, 'legacy', 'pocketbase.js'));

const READS = [
  ['all members', '/api/db?path=people'],
  ['one member', (key) => `/api/db?path=people/${key}`],
  ['statistics', '/api/stats'],
  ['bookings, first page', '/api/transactions?page=1&perPage=50'],
  ['bookings, searched', '/api/transactions?page=1&perPage=50&search=Beitrag'],
  ['fee overview', '/api/fees']
];

const month = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

async function batch(su, requests) {
  for (let start = 0; start < requests.length; start += 1000) {
    await su.request('POST', '/api/batch', { requests: requests.slice(start, start + 1000) });
  }
}

async function seed(su, members, years) {
  await su.request('PATCH', '/api/settings', { batch: { enabled: true, maxRequests: 1000, timeout: 120, maxBodySize: 0 } });
  const start = new Date();
  start.setFullYear(start.getFullYear() - years);
  start.setDate(1);
  const since = `${month(start)}-01`;
  const people = [];
  const payments = [];
  for (let index = 0; index < members; index += 1) {
    const key = `member-${index}`;
    const own = [];
    const day = new Date(start);
    let count = 0;
    while (day <= new Date()) {
      own.push({ id: `pay-${index}-${count}`, amount: 50, date: `${month(day)}-03`, description: count % 12 === 0 ? 'Beitrag Januar' : 'Beitrag' });
      day.setMonth(day.getMonth() + 1);
      count += 1;
    }
    const person = { id: key, name: `Mitglied ${index}`, status: index % 3 ? 'vollverdiener' : 'geringverdiener', memberSince: since, originalMemberSince: since, pays: true, standingOrders: [], payments: own };
    people.push({ method: 'POST', url: '/api/collections/people/records', body: legacyStore.buildPersonRecordPayload(key, person) });
    own.forEach((payment, n) => payments.push({ method: 'POST', url: '/api/collections/payments/records', body: legacyStore.buildPaymentRecordPayload(key, payment, n) }));
  }
  await batch(su, people);
  await batch(su, payments);
  return { payments: payments.length, sampleKey: 'member-1' };
}

// The same reads on API v2 (after the upgrade); one member by its id
const READS_V2 = [
  ['v2: all members', '/api/v2/members?limit=500'],
  ['v2: one member', (id) => `/api/v2/members/${id}`],
  ['v2: payments, first page', '/api/v2/payments?limit=50'],
  ['v2: money summary', '/api/v2/finance/summary']
];

const median = (times) => Math.round([...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]);

async function timed(http, url) {
  const begin = process.hrtime.bigint();
  const res = await http.call('owner', 'GET', url);
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

async function timeReads(http, reads, sample) {
  const results = {};
  for (const [label, url] of reads) {
    const target = typeof url === 'function' ? url(sample) : url;
    const times = [];
    for (let run = 0; run < 5; run += 1) times.push(await timed(http, target));
    results[label] = median(times);
  }
  return results;
}

/** A payment booked the way the web app books it: the member read with its version, then the transaction. */
async function book(http, key, id) {
  const raw = await http.call('owner', 'GET', `/api/db?path=people/${key}&raw=1`);
  const value = { ...raw.body.value, payments: [...(raw.body.value.payments || []), { id, amount: 50, date: new Date().toISOString().slice(0, 10), description: 'Beitrag' }] };
  const begin = process.hrtime.bigint();
  const res = await http.call('owner', 'POST', '/api/db/transaction', { path: `people/${key}`, currentVersion: raw.body.version, value });
  if (res.status !== 200) throw new Error(`booking: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

/** What every app reads right after a change: [readUrls] ({ label: url }) first after a booking and after an unrelated change. */
async function timeChanges(http, label, readUrls) {
  const results = {};
  const bookings = [];
  const after = Object.fromEntries(Object.keys(readUrls).map((name) => [name, []]));
  const unrelated = Object.fromEntries(Object.keys(readUrls).map((name) => [name, []]));
  for (let run = 0; run < 5; run += 1) {
    for (const [name, url] of Object.entries(readUrls)) {
      bookings.push(await book(http, `member-${10 + run}`, `bench-${label}-${name}-${run}`));
      after[name].push(await timed(http, url));
      const prayer = await http.call('owner', 'POST', '/api/prayers', { text: 'Bitte', duration: 'week' });
      await http.call('owner', 'DELETE', `/api/prayers/${prayer.body?.id || prayer.body?.prayer?.id}`);
      unrelated[name].push(await timed(http, url));
    }
  }
  results['saving a booking'] = median(bookings);
  for (const name of Object.keys(readUrls)) {
    results[`${name}, first after a booking`] = median(after[name]);
    results[`${name}, after an unrelated change`] = median(unrelated[name]);
  }
  return results;
}

async function measure(members, years) {
  const root = makeRoot('agora-bench-');
  const pocketbase = await startPocketBase(root);
  let backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
  try {
    const http = httpClient(backend.base);
    const setup = await http.ok(http.call(null, 'POST', '/api/setup', {
      appName: 'Benchmark', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@bench.local', password: PASSWORD, memberSince: '2000-01-01' }
    }));
    http.tokens.owner = setup.token;
    const su = await superuser(root, pocketbase.port);
    const seeded = await seed(su, members, years);

    let begin = Date.now();
    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, port: backend.port, label: 'old backend' });
    const oldStart = Date.now() - begin;
    const before = { ...await timeReads(http, READS, seeded.sampleKey), ...await timeChanges(http, 'old', { 'all members': '/api/db?path=people', statistics: '/api/stats' }) };

    await stop(backend.process);
    begin = Date.now();
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const upgrade = Date.now() - begin;
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    if (status.upgrade) throw new Error(`The upgrade did not go through: ${JSON.stringify(status.upgrade)}`);

    // As an instance runs after its one-time upgrade: a fresh start of the current backend
    await stop(backend.process);
    begin = Date.now();
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const newStart = Date.now() - begin;
    const memberId = (await http.ok(http.call('owner', 'GET', '/api/v2/members?limit=500'))).items.find((member) => member.key === seeded.sampleKey).id;
    const after = {
      ...await timeReads(http, READS, seeded.sampleKey),
      ...await timeChanges(http, 'new', { 'all members': '/api/db?path=people', statistics: '/api/stats', 'v2: all members': '/api/v2/members?limit=500', 'v2: money summary': '/api/v2/finance/summary' }),
      ...await timeReads(http, READS_V2, memberId)
    };
    return { members, years, payments: seeded.payments, oldStart, upgrade, newStart, before, after };
  } finally {
    await stop(backend.process);
    await stop(pocketbase.process);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  if (!POCKETBASE_BIN) throw new Error('Set POCKETBASE_BIN to the PocketBase binary.');
  const sizes = (process.argv.slice(2).length ? process.argv.slice(2) : ['50:10', '150:20', '300:30']).map((size) => size.split(':').map(Number));
  const rows = [];
  for (const [members, years] of sizes) {
    console.log(`Measuring ${members} members over ${years} years ...`);
    rows.push(await measure(members, years));
  }
  for (const row of rows) {
    console.log(`\n${row.members} members, ${row.years} years (${row.payments} payments): old start ${row.oldStart} ms, upgrade ${row.upgrade} ms, new start ${row.newStart} ms`);
    console.log(`  ${'read'.padEnd(44)} ${'before'.padStart(8)} ${'after'.padStart(8)}`);
    const before = (label) => (label in row.before ? `${row.before[label]} ms` : '-');
    for (const label of Object.keys(row.after)) console.log(`  ${label.padEnd(44)} ${before(label).padStart(8)} ${`${row.after[label]} ms`.padStart(8)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
