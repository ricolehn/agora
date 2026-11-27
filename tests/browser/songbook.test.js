// The songbook in the browser: adding a song (list, search by title and lyrics), reading it as a member (transposing,
// back to the original key, chords hidden), its own address, editing and deleting, a save the server refuses.
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startApp, until } = require('./harness');

const LYRICS = '{c: Verse 1}\n[G]Amazing [C]grace, how [G]sweet the sound\nThat [G]saved a wretch like [D]me';
const row = (page, title) => page.locator('#songbook-list').getByRole('button', { name: new RegExp(title) });
const chords = page => page.locator('#song-view-body [data-song-chord]').allInnerTexts().then(list => list.filter(Boolean));

describe('songbook (browser)', { skip: skipReason || false }, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.close());
  afterEach(() => app.endTest());

  test('the owner adds a song: it is in the list with its artist and key, and the search finds it by title and lyrics', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/songbook');
    await owner.page.locator('#desktop-fab').click();
    await owner.page.locator('#song-edit-name').fill('Amazing Grace');
    await owner.page.locator('#song-edit-artist').fill('John Newton');
    await owner.page.locator('#song-edit-key').fill('G');
    await owner.page.locator('#song-edit-content').fill(LYRICS);
    await owner.page.locator('#song-save-btn').click();
    await owner.toast('Song saved');
    const text = await row(owner.page, 'Amazing Grace').innerText();
    assert.match(text, /John Newton/);
    assert.match(text, /Key G/);
    const search = owner.page.locator('#songbook-search');
    await search.fill('wretch');
    await row(owner.page, 'Amazing Grace').waitFor();
    await search.fill('nothing like this');
    await until(async () => (await row(owner.page, 'Amazing Grace').count()) === 0, 'no song to match');
  });

  test('a member reads a song: transposing moves key and chords, the key goes back, the chords can be hidden', async () => {
    const max = await app.signIn('max');
    await max.go('/songbook');
    await row(max.page, 'Amazing Grace').click();
    await max.page.locator('#song-view-modal').waitFor();
    assert.deepEqual(await chords(max.page), ['G', 'C', 'G', 'G', 'D']);
    assert.equal(await max.page.locator('#song-edit-btn').count(), 0, 'members do not edit songs');
    await max.page.locator('#song-panel-btn').click();
    await max.page.getByRole('button', { name: 'Semitone up' }).click();
    await until(async () => (await chords(max.page))[0] !== 'G', 'the chords to move');
    assert.deepEqual(await chords(max.page), ['Ab', 'Db', 'Ab', 'Ab', 'Eb']);
    await max.page.locator('#song-key').click();
    await until(async () => (await chords(max.page))[0] === 'G', 'the original key');
    await max.page.locator('label[for="song-chords-btn"], #song-chords-btn').first().click();
    await until(async () => (await chords(max.page)).length === 0, 'the chords to hide');
    // Shown again for the other tests (the choice is remembered on the device)
    await max.page.locator('label[for="song-chords-btn"], #song-chords-btn').first().click();
  });

  test('a song has its own address', async () => {
    const mia = await app.signIn('mia');
    // The title as the address (capitals kept, spaces as _)
    await mia.go('/songbook/Amazing_Grace');
    await mia.page.locator('#song-view-title').getByText('Amazing Grace').waitFor();
  });

  test('the owner edits the title and then deletes the song', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/songbook');
    await row(owner.page, 'Amazing Grace').click();
    await owner.page.locator('#song-edit-btn').click();
    await owner.page.locator('#song-edit-name').fill('Amazing Grace (2nd verse)');
    await owner.page.locator('#song-save-btn').click();
    await owner.toast('Song saved');
    await owner.page.locator('#song-view-title').getByText('Amazing Grace (2nd verse)').waitFor();
    await owner.page.locator('#song-edit-btn').click();
    await owner.page.locator('#song-delete-btn').click();
    await owner.toast('Song deleted');
    await owner.go('/songbook');
    assert.equal(await row(owner.page, 'Amazing Grace').count(), 0);
  });

  test('a save the server refuses shows its reason, and the editor keeps the text', async () => {
    const owner = await app.signIn('owner');
    await owner.go('/songbook');
    await owner.page.locator('#desktop-fab').click();
    await owner.page.locator('#song-edit-name').fill('A song that is not taken');
    await owner.page.locator('#song-edit-content').fill('[C]La la la');
    await owner.page.locator('#song-edit-key').fill('X');
    await owner.page.locator('#song-save-btn').click();
    await owner.toast('The key has to be a note like G, F#m or Bb.');
    assert.equal(await owner.page.locator('#song-edit-name').inputValue(), 'A song that is not taken');
  });
});
