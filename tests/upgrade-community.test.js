// The songbook, prayer requests and polls through the upgrade, where the every-answer comparison (upgrade.test.js)
// cannot look: v3.1 beta kept polls and songs in app_state, and the old server moved them into their tables at its
// next start. An instance that jumps straight from there gets them moved by the upgrade - the same ones, the same way.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  POCKETBASE_BIN, PASSWORD, LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop
} = require('./instance');

describe('songs and polls left in app_state', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('the upgrade moves them like the old server did at its start', async (t) => {
    const root = makeRoot('agora-community-');
    const pocketbase = await startPocketBase(root);
    let backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
    t.after(async () => {
      await stop(backend?.process);
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const http = httpClient(backend.base);
    const { call, ok, tokens } = http;
    const setup = await ok(call(null, 'POST', '/api/setup', {
      appName: 'Beta-Gemeinde',
      adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, memberSince: '2016-01-01' }
    }));
    tokens.owner = setup.token;
    const song = await ok(call('owner', 'POST', '/api/songs', { title: 'Schon da', content: '[G]Text' }));
    await stop(backend.process);

    // What v3.1 beta left: a song and a poll that are not in the tables yet; a song whose key is (it stays as it is),
    // a key that is no id, an empty value (both were never moved), a list (moved: the old server took any object)
    const su = await superuser(root, pocketbase.port);
    const betaSong = { id: 'beta-lied', title: 'Aus der Beta', artist: 'Alt', key: 'D', capo: null, tempo: 90, ccli: '', copyright: '', content: '[D]Beta', createdAt: 1600000000000, updatedAt: 1600000000000 };
    const betaPoll = {
      id: 'beta-umfrage', title: 'Beta?', description: '', options: [{ id: 'o1', text: 'Ja' }, { id: 'o2', text: 'Nein' }], multiple: false,
      createdAt: 1600000000000, endsAt: 1600000600000, creator: 'c'.repeat(64), tallies: { o1: 2, o2: 1 }, voters: ['a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64)]
    };
    await su.create('app_state', { key: 'songs', value: { [song.id]: { id: song.id, title: 'Doppelt' }, 'beta-lied': betaSong, 'kein schlüssel': { title: 'Nie' }, leer: null, liste: [1, 2] } });
    await su.create('app_state', { key: 'polls', value: { 'beta-umfrage': betaPoll } });

    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const state = (await su.list('system_migrations')).find((record) => record.id === 'v4-structure');
    assert.equal(state.status, 'done');
    assert.equal(state.report.areas.community.findings.itemsFromOldAppState.count, 3);
    assert.deepEqual(state.report.areas.community.counts.new, { community_songs: 3, community_prayers: 0, community_polls: 1 });

    const songs = (await ok(call('owner', 'GET', '/api/songs'))).songs;
    assert.deepEqual(songs.find((item) => item.id === 'beta-lied'), betaSong, 'the song exactly as it was');
    assert.deepEqual(songs.find((item) => item.id === song.id), song, 'a song already in the table keeps its own data');
    assert.ok(songs.some((item) => Array.isArray(item) && item[0] === 1 && item[1] === 2), 'a list is listed, as the old server listed it');
    assert.equal(songs.length, 3);
    assert.ok(!songs.some((item) => item.title === 'Nie' || item.title === 'Doppelt'));
    const polls = await ok(call('owner', 'GET', '/api/polls'));
    const poll = polls.find((item) => item.id === 'beta-umfrage');
    assert.deepEqual(poll.results, { counts: { o1: 2, o2: 1 }, participants: 3 });

    // Reachable by its key, and the record has it as its id
    const changed = await ok(call('owner', 'PUT', '/api/songs/beta-lied', { ...betaSong, title: 'Aus der Beta (neu)' }));
    assert.equal(changed.title, 'Aus der Beta (neu)');
    assert.equal(changed.createdAt, betaSong.createdAt);
    assert.equal((await su.list('community_songs', 'id = "beta-lied"'))[0].title, 'Aus der Beta (neu)');

    // The old tables are gone, app_state with them (the backup keeps them)
    const collections = new Set((await su.collections()).map((collection) => collection.name));
    for (const name of ['songs', 'polls', 'prayers', 'app_state']) assert.ok(!collections.has(name), `${name} is gone`);
  });
});
