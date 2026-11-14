// A password is nowhere but in PocketBase's own hash. The accounts are written through a codec that keeps whatever
// the columns do not know in `original` (backend/db/codecs/accounts.js) - the password of a new account, of a changed
// or reset one was such a "field" and stood in the database, and in every backup of it, in plain text.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { POCKETBASE_BIN, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop } = require('./instance');

describe('passwords', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the HTTP tests' }, () => {
  test('are never kept with the account: not when it is made, changed or reset - and what was kept is removed', async (t) => {
    const root = makeRoot('agora-passwords-');
    const pocketbase = await startPocketBase(root);
    let backend = await startBackend(root, pocketbase.port);
    t.after(async () => {
      await stop(backend.process);
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const http = httpClient(backend.base);
    const { call, ok } = http;
    const passwords = { setup: 'Gruender-Geheim-1', made: 'Angelegt-Geheim-2', own: 'Selbst-Geheim-3', registered: 'Beitritt-Geheim-4', claimed: 'Uebernommen-Geheim-5' };

    // The setup, an account an admin makes, one that registers with the invite code, a member's own change
    const setup = await ok(call(null, 'POST', '/api/setup', { appName: 'Passwörter', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: passwords.setup } }));
    http.tokens.owner = setup.token;
    await ok(call('owner', 'POST', '/api/admin/users', { firstName: 'Max', lastName: 'Muster', email: 'max@test.local', password: passwords.made, pays: true, admin: false }));
    await http.login('max', 'max@test.local', passwords.made);
    const changed = await call('max', 'POST', '/api/auth/password', { oldPassword: passwords.made, password: passwords.own });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const inviteCode = await ok(call('owner', 'GET', '/api/db?path=system/inviteCode'));
    const registered = await call(null, 'POST', '/api/auth/register', { firstName: 'Nina', lastName: 'Neu', email: 'nina@test.local', password: passwords.registered, inviteCode });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.ok(!JSON.stringify(registered.body).includes(passwords.registered), 'the answer to a registration does not repeat the password');

    const su = await superuser(root, pocketbase.port);
    const everywhere = async (what) => {
      for (const user of await su.list('users')) {
        assert.ok(!JSON.stringify(user).includes('assword'), `${what}: nothing about a password with ${user.email}: ${JSON.stringify(user.original)}`);
      }
      // The database files themselves (what a backup takes along)
      for (const file of fs.readdirSync(path.join(root, 'pb')).filter((name) => name.startsWith('data.db'))) {
        const content = fs.readFileSync(path.join(root, 'pb', file)).toString('latin1');
        for (const [which, password] of Object.entries(passwords)) assert.ok(!content.includes(password), `${what}: the password "${which}" is not in ${file}`);
      }
    };
    await everywhere('after making, changing and registering');
    // Every one of them signs in with the password it has now
    for (const [email, password] of [['owner@test.local', passwords.setup], ['max@test.local', passwords.own], ['nina@test.local', passwords.registered]]) {
      assert.equal((await call(null, 'POST', '/api/auth/login', { email, password })).status, 200, email);
    }
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'max@test.local', password: passwords.made })).status, 401, 'the old password is gone');

    // What the first releases of the new structure left: the password next to the account, with whatever else
    // `original` holds (a field of an older app). Removed once, at the next start; the login is untouched
    const users = await su.list('users');
    const max = users.find((user) => user.email === 'max@test.local');
    await su.update('users', max.id, { original: { extra: { password: 'Alt-Klartext-9', passwordConfirm: 'Alt-Klartext-9', spitzname: 'Maxi' } } });
    await su.remove('system_migrations', 'passwords-out-of-accounts');
    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { port: backend.port });
    const after = (await su.list('users')).find((user) => user.id === max.id);
    assert.deepEqual(after.original, { extra: { spitzname: 'Maxi' } }, 'the password is gone, the rest stays');
    const repair = (await su.list('system_migrations')).find((record) => record.id === 'passwords-out-of-accounts');
    assert.equal(repair.status, 'done');
    assert.deepEqual(repair.report, { cleaned: 1 });
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'max@test.local', password: passwords.own })).status, 200, 'the login is as it was');
  });
});
