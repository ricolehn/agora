// Media library: folder rights, clean paths and the Nextcloud answers (backend/media.js, backend/nextcloud.js) and
// the address / order helpers of the web app (assets/media.js). The HTTP side is in api.test.js.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { REPO_ROOT } = require('./helpers');
const media = require('../backend/media');
const { parseMultistatus } = require('../backend/nextcloud');

const member = (...groupIds) => ({ permissions: [], groupIds });
const manager = { permissions: ['manage_media'], groupIds: [] };

describe('media rights (backend/media.js)', () => {
  const rules = {
    Fotos: { '*': 'read' },
    'Fotos/Privat': { '*': 'hide' },
    'Fotos/Jugend': { jugend: 'write' },
    'Fotos/Jugend/Leiter': { jugend: 'hide', leitung: 'read' },
    'Intern/Leitung': { leitung: 'write' }
  };

  test('a rule applies to the folder and everything below until a folder sets its own', () => {
    assert.equal(media.folderAccess(rules, 'Fotos', member()), 'read');
    assert.equal(media.folderAccess(rules, 'Fotos/2026/Sommer', member()), 'read');
    assert.equal(media.folderAccess(rules, 'Fotos/Privat', member()), 'none');
    assert.equal(media.folderAccess(rules, 'Fotos/Privat/Tief', member()), 'none');
    assert.equal(media.groupLevel(rules, 'Fotos/Jugend/Leiter/x', 'jugend'), 'hide');
    assert.equal(media.groupLevel(rules, 'Fotos/Jugend/x', '*'), 'read');
  });

  test('nothing without a rule; the most any of the groups gets; hidden only where no group grants', () => {
    assert.equal(media.folderAccess(rules, '', member()), 'none');
    assert.equal(media.folderAccess(rules, 'Anderes', member('jugend')), 'none');
    assert.equal(media.folderAccess(rules, 'Fotos/Jugend', member('jugend')), 'write');
    assert.equal(media.folderAccess(rules, 'Fotos/Jugend', member()), 'read', 'all members, from Fotos');
    // jugend is hidden in Leiter, all members still read there (from Fotos), leitung reads too
    assert.equal(media.folderAccess(rules, 'Fotos/Jugend/Leiter', member('jugend')), 'read');
    assert.equal(media.folderAccess({ A: { x: 'write' }, 'A/B': { x: 'hide' } }, 'A/B', member('x')), 'none');
    assert.equal(media.folderAccess({ A: { x: 'write' }, 'A/B': { x: 'hide', y: 'read' } }, 'A/B', member('x', 'y')), 'read');
  });

  test('extended media rights see and write everywhere', () => {
    for (const folder of ['', 'Fotos/Privat', 'Intern', 'Nirgends/x']) assert.equal(media.folderAccess(rules, folder, manager), 'write');
    assert.equal(media.hasAnyAccess({}, manager), true);
    assert.equal(media.hasAnyAccess({}, member()), false);
  });

  test('folders on the way to a readable folder are shown, without their files and other folders', () => {
    const listing = {
      folders: [{ name: 'Intern' }, { name: 'Fotos' }, { name: '.cache' }, { name: 'Geheim' }],
      files: [{ name: 'root.pdf' }]
    };
    const view = media.filterListing(rules, '', member('leitung'), listing);
    assert.equal(view.access, 'none');
    assert.deepEqual(view.folders.map((f) => [f.name, f.access]), [['Intern', 'none'], ['Fotos', 'read']]);
    assert.deepEqual(view.files, []);
    const intern = media.filterListing(rules, 'Intern', member('leitung'), { folders: [{ name: 'Leitung' }, { name: 'Kasse' }], files: [{ name: 'x.txt' }] });
    assert.deepEqual(intern.folders.map((f) => f.path), ['Intern/Leitung']);
    assert.deepEqual(intern.files, []);
    assert.equal(media.canSeeFolder(rules, 'Intern', member()), false);
    assert.equal(media.canSeeFolder(rules, 'Intern/Kasse', member('leitung')), false);
  });

  test('a readable folder lists its files (no dot files) and the folders the member may see', () => {
    const view = media.filterListing(rules, 'Fotos', member(), {
      folders: [{ name: 'Privat' }, { name: 'Jugend' }, { name: '2026' }],
      files: [{ name: 'a.jpg' }, { name: '.nomedia' }]
    });
    assert.deepEqual(view.folders.map((f) => f.name), ['Jugend', '2026']);
    assert.deepEqual(view.files.map((f) => f.path), ['Fotos/a.jpg']);
    const managed = media.filterListing(rules, 'Fotos', manager, { folders: [{ name: 'Privat' }, { name: '2026' }], files: [] });
    assert.deepEqual(managed.folders.map((f) => [f.name, f.hasRules, f.hiddenFor]), [['Privat', true, ['*']], ['2026', false, []]]);
  });

  test('setting rules: known groups and levels only; an empty set removes the folder; deleted groups go', () => {
    const known = new Set(['jugend']);
    assert.deepEqual(media.setFolderRules({}, 'A', { jugend: 'write', '*': 'read', x: '' }, known).rules, { A: { jugend: 'write', '*': 'read' } });
    assert.equal(media.setFolderRules({}, 'A', { jugend: 'delete' }, known).error, 'Unknown access level.');
    assert.equal(media.setFolderRules({}, 'A', { other: 'read' }, known).error, 'Unknown group.');
    assert.deepEqual(media.setFolderRules({ A: { jugend: 'read' } }, 'A', {}, known).rules, {});
    assert.deepEqual(media.pruneRules({ A: { gone: 'read' }, B: { gone: 'read', jugend: 'hide' } }, known), { B: { jugend: 'hide' } });
  });
});

describe('media paths and names (backend/media.js)', () => {
  test('only clean paths below the base folder', () => {
    assert.equal(media.cleanPath('/Fotos//2026/'), 'Fotos/2026');
    assert.equal(media.cleanPath(''), '');
    for (const bad of ['..', 'a/../b', './a', 'a\\b', 'a\u0000', 'x'.repeat(1100), `${'y'.repeat(201)}/z`]) assert.equal(media.cleanPath(bad), null, bad);
    assert.equal(media.cleanPath('Mit Leerzeichen /Ä #1 %20'), 'Mit Leerzeichen /Ä #1 %20', 'names are kept as they are');
    assert.equal(media.cleanName('  Neu  '), 'Neu');
    assert.equal(media.cleanName('a/b'), null);
    assert.equal(media.numberedName('Foto.jpg', 2), 'Foto (2).jpg');
    assert.equal(media.numberedName('README', 3), 'README (3)');
  });

  test('the Nextcloud address: https by default, pasted Files and WebDAV addresses cut back', () => {
    assert.equal(media.cleanServerUrl('cloud.example.org:8443/nextcloud/'), 'https://cloud.example.org:8443/nextcloud');
    assert.equal(media.cleanServerUrl('https://c.org/index.php/apps/files/?dir=/'), null, 'no query');
    assert.equal(media.cleanServerUrl('https://c.org/index.php/apps/files/'), 'https://c.org');
    assert.equal(media.cleanServerUrl('http://192.168.1.5:8080/remote.php/dav/files/bot/'), 'http://192.168.1.5:8080');
    assert.equal(media.cleanServerUrl(''), '');
    for (const bad of ['ftp://c.org', 'https://user:pw@c.org', 'https://']) assert.equal(media.cleanServerUrl(bad), null, bad);
  });

  test('the bot password is stored encrypted and only the same key opens it', () => {
    const sealed = media.encryptSecret('app-pass-123', 'k'.repeat(64));
    assert.ok(!sealed.includes('app-pass'));
    assert.notEqual(sealed, media.encryptSecret('app-pass-123', 'k'.repeat(64)), 'a fresh IV each time');
    assert.equal(media.decryptSecret(sealed, 'k'.repeat(64)), 'app-pass-123');
    assert.equal(media.decryptSecret(sealed, 'o'.repeat(64)), null);
    assert.equal(media.decryptSecret('garbage', 'k'.repeat(64)), null);
  });

  test('kinds and preview sizes', () => {
    assert.equal(media.fileKind('image/jpeg', 'a.jpg'), 'image');
    assert.equal(media.fileKind('application/octet-stream', 'Scan.PDF'), 'pdf');
    assert.equal(media.fileKind('image/svg+xml', 'logo.svg'), 'other', 'SVG is never shown as a picture');
    assert.equal(media.fileKind('video/mp4', 'a.mp4'), 'video');
    assert.deepEqual([1, 300, 600, 5000, 'x'].map(media.previewSize), [64, 512, 1024, 2048, 64]);
  });
});

describe('Nextcloud answers (backend/nextcloud.js)', () => {
  test('PROPFIND multistatus: folders and files with their properties, any namespace prefix', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 <d:response><d:href>/remote.php/dav/files/bot/Agora/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:size>42</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/bot/Agora/Fotos%20%26%20Bilder/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 26 Oct 2026 10:00:00 GMT</d:getlastmodified><oc:size>10</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontenttype/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <D:response xmlns:D="DAV:"><D:href>/remote.php/dav/files/bot/Agora/Gr%C3%BC%C3%9Fe.jpg</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1234</D:getcontentlength><D:getcontenttype>image/jpeg</D:getcontenttype><D:getetag>&quot;abc123&quot;</D:getetag><oc:fileid>77</oc:fileid><nc:has-preview>true</nc:has-preview></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</d:multistatus>`;
    const [self, folder, file] = parseMultistatus(xml);
    assert.equal(self.isFolder, true);
    assert.deepEqual([folder.name, folder.isFolder, folder.size, folder.modified], ['Fotos & Bilder', true, 10, '2026-10-26T10:00:00.000Z']);
    assert.deepEqual([file.name, file.isFolder, file.size, file.contentType, file.etag, file.fileId, file.hasPreview], ['Grüße.jpg', false, 1234, 'image/jpeg', 'abc123', '77', true]);
  });
});

describe('media helpers of the web app (assets/media.js)', () => {
  const load = () => import(require('url').pathToFileURL(path.join(REPO_ROOT, 'assets', 'media.js')).href);

  test('breadcrumb, parent and page addresses', async () => {
    const m = await load();
    assert.deepEqual(m.breadcrumb('Fotos/2026'), [{ name: 'Fotos', path: 'Fotos' }, { name: '2026', path: 'Fotos/2026' }]);
    assert.equal(m.parentPath('Fotos/2026'), 'Fotos');
    assert.equal(m.parentPath('Fotos'), '');
    assert.equal(m.folderUrl('Fotos/50% #1'), '/media/Fotos/50%25%20%231');
    assert.equal(m.folderFromRoute(['Fotos', '..', '2026']), 'Fotos/2026');
  });

  test('previews: fixed sizes, sharp on dense screens, the version keeps them cacheable', async () => {
    const m = await load();
    assert.equal(m.thumbSize(160, 1), 256);
    assert.equal(m.thumbSize(160, 2), 512);
    assert.equal(m.thumbSize(400, 3), 512, 'thumbnails stay small');
    assert.equal(m.viewerSize(1280, 800, 1), 2048);
    assert.equal(m.viewerSize(390, 844, 1), 1024);
    const file = { path: 'Fotos/A & B.jpg', etag: 'e1' };
    assert.equal(m.previewUrl('/api', file, 512), '/api/media/preview?path=Fotos%2FA%20%26%20B.jpg&size=512&v=e1');
    assert.equal(m.fileUrl('/api', file, { download: true }), '/api/media/file?path=Fotos%2FA%20%26%20B.jpg&download=1&v=e1');
  });

  test('order: numbers counted in names, or newest first; sizes; the viewer wraps around', async () => {
    const m = await load();
    const entries = [{ name: 'Bild 10', modified: '2026-01-03' }, { name: 'bild 2', modified: '2026-01-01' }, { name: 'Bild 1', modified: '2026-01-02' }];
    assert.deepEqual(m.sortEntries(entries).map((e) => e.name), ['Bild 1', 'bild 2', 'Bild 10']);
    assert.deepEqual(m.sortEntries(entries, 'newest').map((e) => e.name), ['Bild 10', 'Bild 1', 'bild 2']);
    assert.equal(m.formatSize(1536, 'en-GB'), '1.5 KB');
    assert.equal(m.formatSize(5 * 1024 * 1024, 'de-DE'), '5 MB');
    assert.equal(m.neighbourIndex([1, 2, 3], 2, 1), 0);
    assert.equal(m.neighbourIndex([1, 2, 3], 0, -1), 2);
    assert.equal(m.neighbourIndex([1], 0, 1), -1);
    assert.equal(m.viewerNeedsOriginal({ name: 'a.gif', hasPreview: true }), true);
  });

  test('the rights dialog: own level, what comes from above, only own levels are saved', async () => {
    const m = await load();
    const rows = m.rightsRows([{ id: '*', name: '' }, { id: 'g1', name: 'Jugend' }], { own: { g1: 'write' }, inherited: { '*': { level: 'read', from: 'Fotos' } } });
    assert.deepEqual(rows.map((r) => [r.id, r.level, r.inherited?.from || null]), [['*', '', 'Fotos'], ['g1', 'write', null]]);
    assert.deepEqual(m.rightsPayload(rows), { g1: 'write' });
  });
});
