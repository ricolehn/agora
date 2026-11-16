// API v2: the media library (docs/API_V2.md) - a folder of the community's Nextcloud with the rights Agora decides. It
// runs the old API's own handlers (routes/media.js): the same rights on every call, files streamed as v1 streams them,
// answers in the shapes of v2 and every error in its shape.
const express = require('express');
const { verifyToken } = require('../context');
const mediaRouter = require('../routes/media');
const { handle, bodyOf, page, sortable, v1Route, runV1, runSteps } = require('./http');

const router = express.Router();
const BASE = '/api/v2';

const statusRoute = v1Route(mediaRouter, 'get', '/api/media/status');
const listRoute = v1Route(mediaRouter, 'get', '/api/media/list');
const previewRoute = v1Route(mediaRouter, 'get', '/api/media/preview');
const fileRoute = v1Route(mediaRouter, 'get', '/api/media/file');
const uploadRoute = v1Route(mediaRouter, 'post', '/api/media/upload');
const folderRoute = v1Route(mediaRouter, 'post', '/api/media/folder');
const deleteRoute = v1Route(mediaRouter, 'post', '/api/media/delete');
const downloadRoute = v1Route(mediaRouter, 'post', '/api/media/download');
const archiveRoute = v1Route(mediaRouter, 'get', '/api/media/download/:id');
const rulesRoute = v1Route(mediaRouter, 'get', '/api/media/rules');
const setRulesRoute = v1Route(mediaRouter, 'put', '/api/media/rules');

const pathQuery = (req) => (typeof req.query.path === 'string' ? { path: req.query.path } : {});

// Whether to show Media: { enabled, canManage, hasAccess }
router.get(`${BASE}/media`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(statusRoute, req);
  res.json({ enabled: body.enabled === true, canManage: body.canManage === true, hasAccess: body.hasAccess === true });
}));

// What a folder holds (?path=, relative to the base folder): its folders, then its files, each by name - with the
// folder itself (its access: read, write or none for a folder only passed through)
router.get(`${BASE}/media/items`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(listRoute, req, { query: pathQuery(req) });
  const items = [
    ...(body.folders || []).map((folder) => ({ ...folder, id: folder.path, isFolder: true, kind: 'folder' })),
    ...(body.files || []).map((file) => ({ ...file, id: file.path, isFolder: false }))
  ];
  res.json({
    folder: { path: body.path, name: body.name, access: body.access, canManage: body.canManage === true },
    ...page(items, req, (item) => `${item.isFolder ? 0 : 1}${sortable(item.name)}`, { ascending: true })
  });
}));

// A preview (?path=&size=64..2048&crop=1&v=<etag>) and the file itself (?path=&download=1, ranges too), as v1 sends them
router.get(`${BASE}/media/preview`, verifyToken, (req, res) => runSteps(previewRoute, req, res));
router.get(`${BASE}/media/file`, verifyToken, (req, res) => runSteps(fileRoute, req, res));

// Upload into a folder (?path=; multipart, field "files", up to 50): nothing is replaced, a taken name gets a number
router.post(`${BASE}/media/files`, verifyToken, (req, res) => runSteps(uploadRoute, req, res));

router.post(`${BASE}/media/folders`, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const { body: created } = await runV1(folderRoute, req, { body: { path: body.path, name: body.name } });
  res.status(201).json({ name: created.name, path: created.path });
}));

// Several entries of one folder at once ({ path, names }): deleted (to Nextcloud's trash bin) ...
router.post(`${BASE}/media/delete`, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const { body: result } = await runV1(deleteRoute, req, { body: { path: body.path, names: body.names } });
  res.json({ deleted: result.deleted || [], failed: result.failed || [] });
}));

// ... or downloaded as one ZIP archive: the answer's url gives it (for a while, to whoever asked)
router.post(`${BASE}/media/downloads`, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const { body: ticket } = await runV1(downloadRoute, req, { body: { path: body.path, names: body.names } });
  res.status(201).json({ id: ticket.id, url: `${BASE}/media/downloads/${ticket.id}`, files: ticket.files });
}));

router.get(`${BASE}/media/downloads/:id`, verifyToken, (req, res) => runSteps(archiveRoute, req, res));

// The rights of the folders (extended media rights): every folder that has some, and what can be chosen
router.get(`${BASE}/media/rules`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(rulesRoute, req, { query: pathQuery(req) });
  res.json(body);
}));

router.put(`${BASE}/media/rules`, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const { body: saved } = await runV1(setRulesRoute, req, { body: { path: body.path, groups: body.groups } });
  res.json(saved);
}));

module.exports = { router, RESOURCES: ['media', 'media/items', 'media/preview', 'media/file', 'media/files', 'media/folders', 'media/delete', 'media/downloads', 'media/rules'] };
