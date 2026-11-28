// The media library in the browser (against tests/fakeNextcloud.js): the owner connects it (a wrong password is
// reported), members see nothing until a folder has rights, then open folders and pictures; with write rights a new
// folder and an upload by the file picker, both in the cloud; deleting takes a file out of the cloud again.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNextcloud } = require('../fakeNextcloud');
const { pngImage, skipReason, startApp, until } = require('./harness');

const entry = (page, name) => page.locator(`#media-list [data-media-name="${name}"]`);
const open = (page, name) => entry(page, name).locator('[data-media-open]').click();
/** Sets the level of "All members" in the rights of the open folder. */
async function rightsForAll(session, level) {
  await session.page.locator('#media-rights-btn').click();
  const dialog = session.page.locator('#media-rights-modal');
  await dialog.getByRole('radiogroup', { name: 'All members' }).getByRole('radio', { name: level }).click();
  await session.page.locator('#media-rights-save').click();
  await session.toast('Folder rights saved');
}
/** Through the library's add button ('Upload files' or 'New folder'). */
async function fab(page, item) {
  await page.locator('#desktop-fab').click();
  await page.locator('#fabMenu').getByRole('button', { name: new RegExp(item) }).click();
}

/** A short silent WAV file (a browser plays it). */
function silentWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

describe('media (browser)', { skip: skipReason || false }, () => {
  let app;
  let cloud;
  before(async () => {
    cloud = await startFakeNextcloud({ previewImage: () => pngImage(64, 64, [37, 99, 235]) });
    cloud.addFile('Agora/willkommen.pdf', '%PDF-1.4 hello', 'application/pdf');
    cloud.addFile('Agora/Fotos/Sommer.png', pngImage(400, 300), 'image/png');
    cloud.addFile('Agora/Intern/notiz.txt', 'intern', 'text/plain');
    cloud.addFile('Agora/Glocke.wav', silentWav(), 'audio/wav');
    app = await startApp();
  });
  after(async () => {
    await app?.close();
    await cloud?.close();
  });
  afterEach(() => app.endTest());

  test('the owner connects the library: a wrong password is reported, the right one finds the folders', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/system/media');
    const { page } = owner;
    await page.locator('#super-admin-media-url').fill(cloud.url);
    await page.locator('#super-admin-media-user').fill(cloud.user);
    await page.locator('#super-admin-media-password').fill('not-the-password');
    await page.locator('#super-admin-media-root').fill('Agora');
    // The server says that Nextcloud refused the login
    owner.expectProblems(/^502 POST \/api\/admin\/media-config\/test$/);
    await page.locator('#media-cfg-test-btn').click();
    await page.locator('#media-cfg-result').getByText('No connection.').waitFor();
    await page.locator('#super-admin-media-password').fill(cloud.password);
    await page.locator('#media-cfg-test-btn').click();
    await page.locator('#media-cfg-result').getByText('Connected.').waitFor();
    assert.match(await page.locator('#media-cfg-result').innerText(), /2 folders in the base folder:[\s\S]*Fotos[\s\S]*Intern/);
    await page.locator('label[for="super-admin-media-enabled"]').click();
    await page.locator('#media-cfg-save-btn').click();
    await owner.toast('Media settings saved');
  });

  test('without rights members see no library; with read rights for all they open folders and pictures', async () => {
    const max = await app.signIn('max');
    await max.go('/hub');
    const tile = max.page.locator('main').getByText('Pictures and files of the community');
    assert.equal(await tile.count(), 0, 'no library without rights');

    const owner = await app.signIn('owner');
    await owner.go('/media');
    await entry(owner.page, 'Fotos').waitFor();
    await rightsForAll(owner, 'Read');

    await max.go('/hub');
    await tile.click();
    await entry(max.page, 'willkommen.pdf').waitFor();
    await open(max.page, 'Fotos');
    await until(() => max.page.url().endsWith('/media/Fotos'), 'the folder\'s address');
    await open(max.page, 'Sommer.png');
    const picture = max.page.locator('#media-viewer-img');
    await picture.waitFor();
    // Nextcloud's large preview of it (the stand-in draws 64 pixels)
    await until(() => picture.evaluate(img => img.complete && img.naturalWidth === 64), 'the picture');
    await max.page.keyboard.press('Escape');
    // Reading only: no way to add anything
    assert.equal(await max.page.locator('#desktop-fab').isVisible(), false);
  });

  test('with write rights: a new folder and an upload through the file picker, both in the cloud', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/media/Fotos');
    await entry(owner.page, 'Sommer.png').waitFor();
    await rightsForAll(owner, 'Write');

    const max = await app.signIn('max');
    await max.go('/media/Fotos');
    await fab(max.page, 'New folder');
    await max.page.locator('#media-folder-name').fill('Sommerfest');
    await max.page.locator('#media-folder-create').click();
    await max.toast('Folder created');
    assert.ok(cloud.nodes.get('Agora/Fotos/Sommerfest')?.dir);
    await open(max.page, 'Sommerfest');
    await until(() => max.page.url().endsWith('/media/Fotos/Sommerfest'), 'the new folder\'s address');
    const [chooser] = await Promise.all([max.page.waitForEvent('filechooser'), fab(max.page, 'Upload files')]);
    await chooser.setFiles({ name: 'Bild.png', mimeType: 'image/png', buffer: pngImage(120, 80) });
    await max.toast('1 file added');
    await entry(max.page, 'Bild.png').waitFor();
    assert.equal(cloud.nodes.get('Agora/Fotos/Sommerfest/Bild.png')?.type, 'image/png');
  });

  test('deleting a file takes it out of the cloud', async () => {
    const max = await app.signIn('max');
    await max.go('/media/Fotos/Sommerfest');
    await max.page.getByRole('button', { name: 'Select Bild.png' }).click();
    await max.page.locator('#media-select-delete').click();
    await max.toast('Deleted');
    await until(async () => (await entry(max.page, 'Bild.png').count()) === 0, 'the file to go');
    assert.equal(cloud.nodes.has('Agora/Fotos/Sommerfest/Bild.png'), false);
  });

  test('music opens in a player of its own, a new one when it opens again', async () => {
    const max = await app.signIn('max');
    await max.go('/media');
    await open(max.page, 'Glocke.wav');
    const player = max.page.locator('#media-player-modal audio');
    await player.waitFor({ state: 'attached' });
    await player.evaluate(el => (el.dataset.seen = 'first'));
    await max.page.keyboard.press('Escape');
    await open(max.page, 'Glocke.wav');
    await until(async () => (await player.count()) === 1 && (await player.evaluate(el => el.dataset.seen || 'new')) === 'new', 'a new player');
  });
});
