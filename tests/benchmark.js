#!/usr/bin/env node
// How fast the books answer on large instances, before and after the upgrade:
//
//   POCKETBASE_BIN=/path/to/pocketbase node tests/benchmark.js [members:years ...]   (default 50:10 150:20 300:30)
//
// For each size an old instance is filled straight in PocketBase (members paying every month for that many years),
// the reads the apps make most are timed on the frozen backend, the upgrade runs (timed), and the same reads are
// timed on the current backend. Prints the medians of five runs per read.
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

async function timeReads(http, sampleKey) {
  const results = {};
  for (const [label, url] of READS) {
    const target = typeof url === 'function' ? url(sampleKey) : url;
    const times = [];
    for (let run = 0; run < 5; run += 1) {
      const begin = process.hrtime.bigint();
      const res = await http.call('owner', 'GET', target);
      if (res.status !== 200) throw new Error(`${target}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      times.push(Number(process.hrtime.bigint() - begin) / 1e6);
    }
    times.sort((a, b) => a - b);
    results[label] = Math.round(times[2]);
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
    const before = await timeReads(http, seeded.sampleKey);

    await stop(backend.process);
    begin = Date.now();
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const upgrade = Date.now() - begin;
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    if (status.upgrade) throw new Error(`The upgrade did not go through: ${JSON.stringify(status.upgrade)}`);
    const after = await timeReads(http, seeded.sampleKey);

    await stop(backend.process);
    begin = Date.now();
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const newStart = Date.now() - begin;
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
    console.log(`  ${'read'.padEnd(24)} ${'before'.padStart(8)} ${'after'.padStart(8)}`);
    for (const label of Object.keys(row.before)) console.log(`  ${label.padEnd(24)} ${`${row.before[label]} ms`.padStart(8)} ${`${row.after[label]} ms`.padStart(8)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
