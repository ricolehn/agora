// API v2 (docs/API_V2.md): the data in the shapes of the new structure - record ids, money in whole cents, days as
// 'YYYY-MM-DD', moments as ISO 8601 (UTC), camelCase, lists in pages with a cursor, errors as { error: { code,
// message } } in the language of the request. The permissions are those of the old API (v1), which stays as it is
// for every app version.
//
// Its areas live in backend/v2/: the conventions (http.js), the books (finance.js), the calendar (events.js), who is
// signed in, the groups, the songbook and mentoring (community.js), and the media library (media.js). Reads come from
// the new tables; writes go through the same functions and handlers as v1 - the balances, the change log, the checks
// for conflicting changes, the notifications work exactly alike.
const express = require('express');
const { verifyToken } = require('../auth');
const { fail, errorShape, errorHandler } = require('../v2/http');
const finance = require('../v2/finance');
const events = require('../v2/events');
const community = require('../v2/community');
const media = require('../v2/media');

const BASE = '/api/v2';
const router = express.Router();
const areas = [community, finance, events, media];
for (const area of areas) router.use(area.router);

router.get(BASE, verifyToken, (req, res) => {
  res.json({
    apiVersion: 2,
    documentation: 'docs/API_V2.md in the repository',
    resources: areas.flatMap((area) => area.RESOURCES)
  });
});

// Anything else under /api/v2: an error in the shape of v2
router.all(`${BASE}/*`, (req, res) => fail(req, res, 404, 'There is no such resource in API v2.'));

module.exports = { router, errorShape, errorHandler };
