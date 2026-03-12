const fs = require('fs');
const path = require('path');

function resolveDataDirectory({ env = process.env } = {}) {
  if (env.DATA_DIR) {
    return path.resolve(env.DATA_DIR);
  }

  return path.join(__dirname, '..', 'data');
}

function resolvePocketBaseDirectory({ env = process.env, existsSync = fs.existsSync } = {}) {
  if (env.POCKETBASE_DIR) {
    return path.resolve(env.POCKETBASE_DIR);
  }

  if (env.DB_DIR) {
    return path.resolve(env.DB_DIR);
  }

  const dbDir = path.join(__dirname, '..', 'db');
  if (existsSync(dbDir)) {
    return dbDir;
  }

  return path.join(resolveDataDirectory({ env }), 'pocketbase');
}

function resolveFrontendDirectory({ env = process.env, existsSync = fs.existsSync } = {}) {
  if (env.FRONTEND_DIR) {
    return path.resolve(env.FRONTEND_DIR);
  }

  const htmlDir = path.join(__dirname, '..', 'html');
  if (existsSync(htmlDir)) {
    return htmlDir;
  }

  return path.join(__dirname, '..');
}

module.exports = {
  resolveDataDirectory,
  resolvePocketBaseDirectory,
  resolveFrontendDirectory
};
