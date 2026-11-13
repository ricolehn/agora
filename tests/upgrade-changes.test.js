// Changes after the upgrade behave as before it. Two copies of the same old instance: one stays on the frozen backend,
// the other is upgraded; both get the same changes through the API - deleting a group that events and duties name,
// a song an order of service uses, a member with an account, an account (by an admin) - and afterwards every read of
// the old API answers the same on both.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POCKETBASE_BIN, LEGACY_SERVER, CURRENT_SERVER, startPocketBase, startBackend, httpClient, stop } = require('./instance');
const { oldInstance, recordAll, firstDifference } = require('./upgradeHarness');

describe('changes after the upgrade', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('deleting a group, a song, a member and an account works as it did before the upgrade', async (t) => {
    const old = await oldInstance();
    // The twin: the same database and data folder, copied while PocketBase is stopped
    await stop(old.pocketbase.process);
    const twinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-twin-'));
    fs.cpSync(old.root, twinRoot, { recursive: true });
    const pbBefore = await startPocketBase(old.root);
    const pbAfter = await startPocketBase(twinRoot);
    const servers = [];
    t.after(async () => {
      for (const server of servers) await stop(server.process);
      await stop(pbBefore.process);
      await stop(pbAfter.process);
      for (const root of [old.root, twinRoot]) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    servers.push(await startBackend(old.root, pbBefore.port, { entry: LEGACY_SERVER, label: 'old backend' }));
    servers.push(await startBackend(twinRoot, pbAfter.port, { entry: CURRENT_SERVER, label: 'new backend' }));
    const [before, after] = servers.map((server) => {
      const http = httpClient(server.base);
      Object.assign(http.tokens, old.http.tokens);
      Object.assign(http.uids, old.http.uids);
      return http;
    });
    const status = await (await fetch(`${servers[1].base}/api/status`)).json();
    assert.equal(status.upgrade, undefined, 'the twin was upgraded');

    const { facts } = old;
    const songInProgram = facts.songs[0];
    const member = Object.entries(facts.people).find(([who]) => who === 'viewer')?.[1];
    for (const [side, http] of [['before', before], ['after', after]]) {
      const step = async (label, who, method, url, body) => {
        const res = await http.call(who, method, url, body);
        assert.ok(res.status < 300, `${side}: ${label} answered ${res.status} ${JSON.stringify(res.body)}`);
      };
      // A group events and duties name, a song the order of service uses
      await step('deleting the group Jugend', 'owner', 'DELETE', `/api/admin/groups/${facts.groups.Jugend}`);
      await step('deleting the group Technik', 'owner', 'DELETE', `/api/admin/groups/${facts.groups.Technik}`);
      await step('deleting a song', 'mia', 'DELETE', `/api/songs/${songInProgram}`);
      // A member with an account (the account goes with it), an account deleted by an admin
      await step('deleting a member', 'owner', 'DELETE', '/api/db', { path: `people/${member}` });
      await step('deleting an account', 'ada', 'DELETE', `/api/admin/users/${http.uids.mentee}`);
    }

    const reads = old.reads;
    const [answersBefore, answersAfter] = [await recordAll(before, reads), await recordAll(after, reads)];
    const differences = reads.map(([who, url], index) => [who, url, firstDifference(answersBefore[index], answersAfter[index])])
      .filter(([, , difference]) => difference).map(([who, url, difference]) => `${who || 'nobody'} GET ${url}\n    ${difference}`);
    assert.deepEqual(differences, [], `${differences.length} of ${reads.length} answers differ:\n${differences.slice(0, 30).join('\n')}`);
  });
});
