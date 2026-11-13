// Songs, prayer requests and polls as the server keeps them in memory (one object each, the
// "data" of the old { key, data } records), and as the new tables keep them (see ../codec.js).
const { createCodec, fieldKinds: f } = require('../codec');

const recordId = { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored };
/** A link that the app keeps as null when there is none. */
const linkOrNull = (column, collection) => ({ ...f.link(column, collection), fromColumn: (stored) => stored || null });
const textOrNull = (column) => ({ ...f.text(column), fromColumn: (stored) => (stored === undefined || stored === null || stored === '' ? null : String(stored)) });

const SONG_KEYS = ['id', 'title', 'artist', 'key', 'capo', 'tempo', 'ccli', 'copyright', 'content', 'createdAt', 'updatedAt'];
const song = createCodec({
  fields: {
    id: recordId,
    title: f.text('title'),
    artist: f.text('artist'),
    key: f.text('musicalKey'),
    // 0 is "none" in the column; a capo on fret 0 that an app set on purpose stays in `original`
    capo: f.number('capo', { empty: null }),
    tempo: f.number('tempo', { empty: null }),
    ccli: f.text('ccli'),
    copyright: f.text('copyright'),
    content: f.text('content'),
    createdAt: f.millis('created'),
    updatedAt: f.millis('updated')
  },
  canonicalKeys: () => SONG_KEYS
});

const PRAYER_KEYS = ['id', 'text', 'anonymous', 'authorUid', 'authorName', 'owner', 'createdAt', 'expiresAt'];
const prayer = createCodec({
  fields: {
    id: recordId,
    text: f.text('text'),
    anonymous: f.bool('isAnonymous'),
    authorUid: linkOrNull('author', 'users'),
    authorName: textOrNull('authorName'),
    owner: f.text('ownerHash'),
    createdAt: f.millis('created'),
    expiresAt: f.millis('expiresAt')
  },
  canonicalKeys: () => PRAYER_KEYS
});

const POLL_KEYS = ['id', 'title', 'description', 'options', 'multiple', 'createdAt', 'endsAt', 'creator', 'tallies', 'voters'];
const poll = createCodec({
  fields: {
    id: recordId,
    title: f.text('title'),
    description: f.text('description'),
    options: f.json('options'),
    multiple: f.bool('isMultiple'),
    createdAt: f.millis('created'),
    endsAt: f.millis('endsAt'),
    creator: f.text('creatorHash'),
    tallies: f.json('tallies'),
    voters: f.json('voters')
  },
  canonicalKeys: () => POLL_KEYS
});

module.exports = { song, prayer, poll, SONG_KEYS, PRAYER_KEYS, POLL_KEYS };
