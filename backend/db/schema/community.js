// Community: songbook, prayer requests and polls. Server-only like everything else: poll participation and prayer
// owners are stored as keyed hashes (secrets in the data folder), never as account ids.
const { text, integer, bool, moment, json, link, keptTimes, keptId, original } = require('./fields');

// Nothing is required: older data may lack a value, and the server checks what the apps send
const collections = [
  {
    name: 'community_songs',
    description: 'The songbook: songs with chords (ChordPro).',
    id: keptId(),
    fields: [
      text('title', 'Title.', { presentable: true }),
      text('artist', 'Artist / author.'),
      text('musicalKey', 'Key, e.g. G, F#m or Bb.'),
      integer('capo', 'Capo fret (0: none).'),
      integer('tempo', 'Tempo in BPM (0: none given).'),
      text('ccli', 'CCLI song number.'),
      text('copyright', 'Copyright line.'),
      text('content', 'Lyrics with chords (ChordPro).'),
      original(),
      ...keptTimes()
    ],
    indexes: ['CREATE INDEX idx_community_songs_title ON community_songs (title)']
  },
  {
    name: 'community_prayers',
    description: 'Prayer requests. Each runs out on a day; it is removed 14 days later.',
    id: keptId(),
    fields: [
      text('text', 'The request.'),
      bool('isAnonymous', 'Shown without a name (then no account is stored either).'),
      // Like the account deletion does: a named request goes with its author's account
      link('author', 'users', 'Who wrote it (empty when anonymous). A named request is deleted with its author\'s account.', { cascadeDelete: true }),
      text('authorName', 'The name shown with it.'),
      text('ownerHash', 'Keyed hash that lets the writer see, extend and delete it (also when anonymous).'),
      moment('expiresAt', 'When it runs out.'),
      original(),
      ...keptTimes()
    ],
    indexes: ['CREATE INDEX idx_community_prayers_expires ON community_prayers (expiresAt)']
  },
  {
    name: 'community_polls',
    description: 'Polls. The choices are counted without storing who chose what; voters are keyed hashes in random order.',
    id: keptId(),
    fields: [
      text('title', 'Question.', { presentable: true }),
      text('description', 'Explanation.'),
      json('options', 'The choices: [{"id": "o1", "text": "..."}].'),
      bool('isMultiple', 'Several choices allowed.'),
      moment('endsAt', 'When voting ends.'),
      text('creatorHash', 'Keyed hash of who created it.'),
      json('tallies', 'Votes per choice ({"o1": 3}); empty when fewer than three voted by the end.'),
      json('voters', 'Keyed hashes of who voted, in random order (no link to a choice).'),
      original(),
      ...keptTimes()
    ],
    indexes: []
  }
];

module.exports = { collections, views: [] };
