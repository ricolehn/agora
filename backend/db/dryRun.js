#!/usr/bin/env node
// Tries the database upgrade on a copy of an existing database - nothing of the original is touched:
//
//   node backend/db/dryRun.js <backup.zip | pb_data folder> [--data <data folder>] [--out <folder>]
//
// The backup (a zip from PocketBase's admin page or the backups folder) or a copy of the database folder is unpacked
// into a temporary folder; a temporary PocketBase runs on it, the upgrade runs in its dry-run mode (check, copy,
// compare, and the cleanup that removes the old tables - on the copy only) and the temporary folder is deleted. --data: the data folder of the
// instance (config.json, the key of the mentoring texts), so encrypted texts are compared as the apps see them; it is
// copied too. Writes into --out (default: the current folder):
//
//   upgrade-dry-run-report.json   what the check found and what differed: counts, kinds, record ids - no names, no
//                                 amounts, no texts; can be shared
//   upgrade-dry-run-details.json  the same with the values that differed - personal data: keep it to yourself
//
// Exit code 0: the upgrade would go through; 1: it would not (the report says why); 2: the dry run itself failed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node backend/db/dryRun.js <backup.zip | pb_data folder> [--data <data folder>] [--out <folder>]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { source: null, data: null, out: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data') args.data = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--help' || arg === '-h') usage();
    else if (!args.source) args.source = arg;
    else usage(`Unknown argument: ${arg}`);
  }
  if (!args.source) usage('Which database? Give a backup zip or a pb_data folder.');
  return args;
}

/** Unpacks the zip [file] into [dir] (stored and deflated entries - what PocketBase's backups use). */
function unzip(file, dir) {
  const zip = fs.readFileSync(file);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error(`${file} is no zip file.`);
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (offset === 0xffffffff) throw new Error(`${file} is a zip64 file: unpack it with another tool and give the folder.`);
  const root = path.resolve(dir);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${file}: damaged zip directory.`);
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    const target = path.resolve(root, name);
    // Nothing outside the folder ("../" in a name)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`${file}: an entry points outside the folder (${name}).`);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compressed);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`${file}: ${name} uses a kind of compression this tool does not read; unpack it with another tool.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function pocketBaseBinary() {
  const candidates = [process.env.POCKETBASE_BIN, path.join(__dirname, '..', '..', 'pocketbase'), path.join(__dirname, '..', 'pocketbase'), '/app/pocketbase'].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('PocketBase was not found: set POCKETBASE_BIN to its path.');
  return found;
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`PocketBase stopped (exit code ${child.exitCode}).`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('PocketBase did not start.');
}

async function freePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(args.source);
  if (!fs.existsSync(source)) usage(`${source} does not exist.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dry-run-'));
  const dbDir = path.join(work, 'pb_data');
  const dataDir = path.join(work, 'data');
  let pocketbase = null;
  try {
    console.log(`[Dry run] Copying ${source} into a temporary folder ...`);
    if (fs.statSync(source).isDirectory()) fs.cpSync(source, dbDir, { recursive: true });
    else unzip(source, dbDir);
    if (!fs.existsSync(path.join(dbDir, 'data.db'))) throw new Error('There is no data.db in it: give a PocketBase backup or the pb_data folder.');
    if (args.data) fs.cpSync(path.resolve(args.data), dataDir, { recursive: true });
    else fs.mkdirSync(dataDir);

    const binary = pocketBaseBinary();
    const email = `dry-run-${crypto.randomUUID()}@local.invalid`;
    const password = `p${crypto.randomBytes(24).toString('base64url')}`;
    execFileSync(binary, ['superuser', 'upsert', email, password, '--dir', dbDir], { stdio: 'ignore' });
    const port = await freePort();
    pocketbase = spawn(binary, ['serve', '--dir', dbDir, '--automigrate=false', '--http', `127.0.0.1:${port}`], { stdio: 'ignore' });
    await waitForHealth(port, pocketbase);

    // The server's modules read where PocketBase and the data folder are from the environment
    Object.assign(process.env, { POCKETBASE_PORT: String(port), POCKETBASE_DIR: dbDir, POCKETBASE_BIN: binary, DATA_DIR: dataDir });
    delete process.env.POCKETBASE_BASE_URL;
    const appConfig = { pocketbase: { adminEmail: email, adminPassword: password } };
    const { upgradeDatabase } = require('./upgrade');
    console.log('[Dry run] Checking, copying and comparing ...');
    // The copy is thrown away afterwards, so the cleanup - the one step of the upgrade nothing can undo - is tried too
    const outcome = await upgradeDatabase(appConfig, { dryRun: true, rehearseCleanup: true });

    const report = { at: new Date().toISOString(), source: path.basename(source), status: outcome.status, ...(outcome.report || {}) };
    const details = { ...report, details: outcome.details || [], findings: outcome.findings || {} };
    if (outcome.error) report.error = details.error = outcome.error.message;
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'upgrade-dry-run-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(args.out, 'upgrade-dry-run-details.json'), JSON.stringify(details, null, 2));

    if (outcome.status === 'dry-run') {
      console.log('[Dry run] The upgrade would go through: the new tables answered exactly like the old ones, and the old tables could be removed.');
      for (const [area, { counts }] of Object.entries(report.areas || {})) console.log(`  ${area}: ${JSON.stringify(counts.new)}`);
    } else if (outcome.status === 'current' || outcome.status === 'fresh') {
      console.log(`[Dry run] Nothing to upgrade (${outcome.status === 'current' ? 'the database already has the new structure' : 'an empty database'}).`);
    } else {
      console.log(`[Dry run] The upgrade would NOT go through: ${report.error || report.reason || outcome.status}`);
      for (const difference of report.differences || []) console.log(`  ${difference.what} ${difference.path || ''}`);
    }
    console.log(`[Dry run] Report: ${path.join(args.out, 'upgrade-dry-run-report.json')} (no personal data)`);
    console.log(`[Dry run] Details: ${path.join(args.out, 'upgrade-dry-run-details.json')} (personal data: keep it to yourself)`);
    return outcome.status === 'dry-run' || outcome.status === 'current' || outcome.status === 'fresh' ? 0 : 1;
  } finally {
    if (pocketbase && pocketbase.exitCode === null) {
      pocketbase.kill();
      await new Promise((resolve) => { pocketbase.once('exit', resolve); setTimeout(resolve, 5000); });
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[Dry run] Failed: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { unzip, main };
