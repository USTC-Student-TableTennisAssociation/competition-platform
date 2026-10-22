#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const ROOT = '/var/www/kedapp';
const PG_BIN = '/usr/lib/postgresql/17/bin';
const PRODUCER = 'kedapp-local-postgres-backup';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_NAME = /^local-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const knownCodes = new Set([
  'INVALID_ARGUMENTS', 'INVALID_LOCAL_DATABASE', 'PRODUCTION_DATABASE_MISMATCH',
  'PRIVATE_FILE_REQUIRED', 'PRIVATE_DIRECTORY_REQUIRED', 'BACKUP_ALREADY_RUNNING',
  'DATABASE_OPERATION_ACTIVE', 'LOCK_OWNERSHIP_CHANGED', 'POSTGRESQL_17_REQUIRED',
  'POSTGRESQL_TOOL_FAILED', 'BACKUP_ABORTED', 'EMPTY_ARCHIVE', 'BACKUP_FAILED',
]);

class BackupError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function safeFailure(error) {
  return { success: false, code: knownCodes.has(error?.code) ? error.code : 'BACKUP_FAILED' };
}

export function localConnection(value, role) {
  let url;
  try { url = new URL(value); } catch { throw new BackupError('INVALID_LOCAL_DATABASE'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '5433' || url.pathname !== '/kedapp_standby' || url.hash
    || url.username !== role || !url.password) throw new BackupError('INVALID_LOCAL_DATABASE');
  const permitted = new Set(['schema', 'sslmode', 'connection_limit', 'connect_timeout', 'pool_timeout', 'application_name']);
  for (const [key, value] of url.searchParams) {
    if (!permitted.has(key) || (key === 'schema' && value !== 'public')
      || (key === 'sslmode' && value !== 'disable')) throw new BackupError('INVALID_LOCAL_DATABASE');
  }
  let password;
  try { password = decodeURIComponent(url.password); } catch { throw new BackupError('INVALID_LOCAL_DATABASE'); }
  if (password.includes('\0')) throw new BackupError('INVALID_LOCAL_DATABASE');
  return { url, password };
}

export function backupEnvironment(production, connections, inherited = process.env) {
  localConnection(production.DATABASE_URL, 'kedapp_app');
  const current = localConnection(production.DATABASE_URL_UNPOOLED, 'kedapp_migrator');
  const backup = localConnection(connections.kedapp_migrator, 'kedapp_migrator');
  if (current.password !== backup.password) throw new BackupError('PRODUCTION_DATABASE_MISMATCH');
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(PG|DATABASE_URL)/i.test(key)));
  return {
    ...clean, PGHOST: '127.0.0.1', PGPORT: '5433', PGDATABASE: 'kedapp_standby',
    PGUSER: 'kedapp_migrator', PGPASSWORD: backup.password, PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '10', PGAPPNAME: PRODUCER,
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=10000',
  };
}

async function privateDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new BackupError('PRIVATE_DIRECTORY_REQUIRED');
  }
}

async function privateFile(file, maxSize = 16384) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > maxSize) {
    throw new BackupError('PRIVATE_FILE_REQUIRED');
  }
  return fs.readFile(file, 'utf8');
}

async function directoryLock(directory, code) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new BackupError(code); throw error; }
  const identity = await fs.lstat(directory);
  const token = randomBytes(16).toString('hex');
  try {
    await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({
      owner: PRODUCER, token, pid: process.pid, startedAt: new Date().toISOString(),
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
  return async () => {
    const current = await fs.lstat(directory);
    const owner = JSON.parse(await privateFile(path.join(directory, 'owner.json')));
    if (current.ino !== identity.ino || current.dev !== identity.dev || owner.token !== token) {
      throw new BackupError('LOCK_OWNERSHIP_CHANGED');
    }
    await fs.unlink(path.join(directory, 'owner.json'));
    await fs.rmdir(directory);
  };
}

export async function acquireBackupLocks(state) {
  const releaseBackup = await directoryLock(path.join(state, 'backup.lock'), 'BACKUP_ALREADY_RUNNING');
  let releaseOperation;
  try { releaseOperation = await directoryLock(path.join(state, 'operation.lock'), 'DATABASE_OPERATION_ACTIVE'); }
  catch (error) { await releaseBackup(); throw error; }
  return async () => {
    try { await releaseOperation(); } finally { await releaseBackup(); }
  };
}

export function runPgTool(name, args, env, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BackupError('BACKUP_ABORTED'));
    const child = spawn(path.join(PG_BIN, name), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false, forceKill;
    const abort = () => {
      child.kill('SIGTERM');
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { failed = true; abort(); }, 10 * 60 * 1000);
    const finish = () => { clearTimeout(timeout); clearTimeout(forceKill); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => {
      output += data.toString('utf8');
      if (output.length > 16 * 1024 * 1024) { failed = true; abort(); }
    });
    // PostgreSQL errors can include credentials or business values. Never forward them.
    child.stderr.resume();
    child.on('error', () => { finish(); reject(new BackupError('POSTGRESQL_TOOL_FAILED')); });
    child.on('close', code => {
      finish();
      if (signal?.aborted) reject(new BackupError('BACKUP_ABORTED'));
      else if (failed || code !== 0) reject(new BackupError('POSTGRESQL_TOOL_FAILED'));
      else resolve(output);
    });
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function durableFile(file) {
  const handle = await fs.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export function retentionCandidates(backups, now = new Date()) {
  const sorted = backups.toSorted((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  return sorted.slice(1).filter(item => Date.parse(item.completedAt) < now.getTime() - RETENTION_MS);
}

export async function pruneBackups(directory, now = new Date()) {
  const eligible = [];
  for (const name of await fs.readdir(directory)) {
    if (!RUN_NAME.test(name)) continue;
    const folder = path.join(directory, name);
    try {
      await privateDirectory(folder);
      const names = (await fs.readdir(folder)).sort();
      if (names.join(',') !== 'database.dump,manifest.json') continue;
      const manifest = JSON.parse(await privateFile(path.join(folder, 'manifest.json')));
      if (manifest.producer !== PRODUCER || manifest.schemaVersion !== 1 || manifest.runId !== name
        || manifest.success !== true || !Number.isFinite(Date.parse(manifest.completedAt))
        || manifest.database !== 'kedapp_standby' || manifest.port !== 5433
        || manifest.archive?.file !== 'database.dump' || !/^[a-f0-9]{64}$/.test(manifest.archive.sha256)
        || !Number.isSafeInteger(manifest.archive.bytes) || manifest.archive.bytes <= 0
        || manifest.validation?.completeArchiveRead !== true) continue;
      const file = path.join(folder, 'database.dump');
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
        || (info.mode & 0o077) || info.size !== manifest.archive.bytes) continue;
      if (await sha256(file) !== manifest.archive.sha256) continue;
      eligible.push({ folder, completedAt: manifest.completedAt, sha256: manifest.archive.sha256 });
    } catch { /* Unknown, incomplete, insecure or malformed backups are never deleted. */ }
  }
  let deleted = 0;
  for (const candidate of retentionCandidates(eligible, now)) {
    const archive = path.join(candidate.folder, 'database.dump');
    if (await sha256(archive) !== candidate.sha256) continue;
    await fs.unlink(archive);
    await fs.unlink(path.join(candidate.folder, 'manifest.json'));
    await fs.rmdir(candidate.folder);
    deleted++;
  }
  return deleted;
}

// root/toolRunner are injectable for local tests; the CLI always uses the fixed production paths.
export async function runBackup({ root = ROOT, now = new Date(), toolRunner = runPgTool, signal } = {}) {
  const state = path.join(root, 'shared/database-standby');
  const output = path.join(root, 'shared/database-backups');
  await privateDirectory(state);
  await privateDirectory(output, true);
  const release = await acquireBackupLocks(state);
  let partial;
  try {
    const production = parseEnv(await privateFile(path.join(root, 'shared/.env')));
    const connections = JSON.parse(await privateFile(path.join(state, 'connections.json')));
    const env = backupEnvironment(production, connections);
    for (const tool of ['pg_dump', 'pg_restore']) {
      const version = (await toolRunner(tool, ['--version'], env, signal)).trim();
      if (!new RegExp(`^${tool} \\(PostgreSQL\\) 17(?:\\.|\\s|$)`).test(version)) {
        throw new BackupError('POSTGRESQL_17_REQUIRED');
      }
    }
    const runId = `local-${now.toISOString().replaceAll(/[^0-9TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
    const folder = path.join(output, runId);
    await fs.mkdir(folder, { mode: 0o700 });
    partial = path.join(folder, 'database.dump.partial');
    const archive = path.join(folder, 'database.dump');
    await fs.writeFile(partial, '', { flag: 'wx', mode: 0o600 });
    await toolRunner('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--no-password',
      '--lock-wait-timeout=15000', `--file=${partial}`], env, signal);
    const toc = await toolRunner('pg_restore', ['--list', partial], env, signal);
    const archiveEntries = toc.split('\n').filter(line => line.trim() && !line.startsWith(';')).length;
    if (!archiveEntries || !(await fs.stat(partial)).size) throw new BackupError('EMPTY_ARCHIVE');
    await toolRunner('pg_restore', ['--file=/dev/null', partial], env, signal);
    if (signal?.aborted) throw new BackupError('BACKUP_ABORTED');
    const bytes = (await fs.stat(partial)).size;
    const digest = await sha256(partial);
    await durableFile(partial);
    await fs.rename(partial, archive);
    partial = undefined;
    const manifest = {
      schemaVersion: 1, producer: PRODUCER, runId, success: true,
      startedAt: now.toISOString(), completedAt: new Date().toISOString(),
      host: '127.0.0.1', port: 5433, database: 'kedapp_standby', retentionDays: 7,
      archive: { file: 'database.dump', format: 'custom', bytes, sha256: digest },
      validation: { postgresToolsMajor: 17, archiveEntries, completeArchiveRead: true, restoreTested: false },
    };
    const manifestFile = path.join(folder, 'manifest.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await durableFile(manifestFile);
    await durableFile(folder);
    const prunedBackups = await pruneBackups(output, now);
    return { success: true, runId, bytes, sha256: digest, prunedBackups };
  } finally {
    if (partial) await fs.unlink(partial).catch(() => {});
    await release();
  }
}

async function main() {
  process.umask(0o077);
  if (process.argv.slice(2).join(' ') === '--help') {
    console.log('node backup-local.mjs\nBack up the active 127.0.0.1:5433/kedapp_standby database into private shared/database-backups. Keeps at least seven days and the newest successful backup.');
    return;
  }
  if (process.argv.length !== 2) throw new BackupError('INVALID_ARGUMENTS');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try { console.log(JSON.stringify(await runBackup({ signal: controller.signal }))); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
}
