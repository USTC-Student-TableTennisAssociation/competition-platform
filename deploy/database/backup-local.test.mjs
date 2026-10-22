import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireBackupLocks, backupEnvironment, localConnection, pruneBackups,
  retentionCandidates, runBackup, safeFailure } from './backup-local.mjs';

const migrator = 'postgresql://kedapp_migrator:private-password@127.0.0.1:5433/kedapp_standby?schema=public&sslmode=disable';
const app = migrator.replace('kedapp_migrator', 'kedapp_app');
const production = { DATABASE_URL: app, DATABASE_URL_UNPOOLED: migrator };
const connections = { kedapp_migrator: migrator };
const now = new Date('2026-10-22T00:00:00Z');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kedapp-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'shared/database-standby');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'shared/.env'),
    `DATABASE_URL="${app}"\nDATABASE_URL_UNPOOLED="${migrator}"\n`, { mode: 0o600 });
  await fs.writeFile(path.join(state, 'connections.json'), JSON.stringify(connections), { mode: 0o600 });
  return { root, state, output: path.join(root, 'shared/database-backups') };
}

test('backup refuses a remote host, alternate port/database, app role or unsafe URL options', () => {
  for (const value of [migrator.replace('127.0.0.1', 'localhost'), migrator.replace('127.0.0.1', 'neon.tech'),
    migrator.replace('5433', '5432'), migrator.replace('kedapp_standby', 'postgres'), app,
    migrator.replace('postgresql:', 'https:'), migrator + '&host=remote', migrator + '&options=unsafe',
    migrator.replace('schema=public', 'schema=private'), migrator.replace('sslmode=disable', 'sslmode=require'),
    migrator.replace('private-password', '%00'), 'postgresql://invalid:%ZZ@127.0.0.1:5433/kedapp_standby']) {
    assert.throws(() => localConnection(value, 'kedapp_migrator'), /INVALID_LOCAL_DATABASE/);
  }
});

test('both active runtime and migration targets must match the local backup credentials', () => {
  assert.throws(() => backupEnvironment({ ...production, DATABASE_URL: app.replace('127.0.0.1', 'remote') }, connections));
  assert.throws(() => backupEnvironment({ ...production, DATABASE_URL_UNPOOLED: migrator.replace('127.0.0.1', 'remote') }, connections));
  assert.throws(() => backupEnvironment(production, { kedapp_migrator: migrator.replace('private-password', 'stale-password') }), /PRODUCTION_DATABASE_MISMATCH/);
});

test('inherited libpq service files and connection overrides cannot redirect the backup', () => {
  const env = backupEnvironment(production, connections, {
    PATH: '/usr/bin', PGHOSTADDR: 'remote', PGSERVICE: 'remote', PGPASSFILE: '/tmp/evil',
    PGOPTIONS: '-c default_transaction_read_only=off', DATABASE_URL: 'remote', DATABASE_URL_UNPOOLED: 'remote',
  });
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGPORT, '5433');
  assert.equal(env.PGUSER, 'kedapp_migrator');
  assert.equal(env.PGSSLMODE, 'disable');
  assert.match(env.PGOPTIONS, /default_transaction_read_only=on/);
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGPASSFILE', 'DATABASE_URL', 'DATABASE_URL_UNPOOLED']) assert.equal(env[key], undefined);
});

test('an existing database-operation lock is preserved and backup lock is released', async t => {
  const { state } = await fixture(t);
  await fs.mkdir(path.join(state, 'operation.lock'), { mode: 0o700 });
  await fs.writeFile(path.join(state, 'operation.lock/owner.json'), '{"owner":"cutover"}');
  await assert.rejects(acquireBackupLocks(state), /DATABASE_OPERATION_ACTIVE/);
  assert.equal(await fs.readFile(path.join(state, 'operation.lock/owner.json'), 'utf8'), '{"owner":"cutover"}');
  await assert.rejects(fs.stat(path.join(state, 'backup.lock')), { code: 'ENOENT' });
});

test('backup holds both locks and another backup cannot replace them', async t => {
  const { state } = await fixture(t);
  const release = await acquireBackupLocks(state);
  assert.ok((await fs.stat(path.join(state, 'operation.lock'))).isDirectory());
  await assert.rejects(acquireBackupLocks(state), /BACKUP_ALREADY_RUNNING/);
  await release();
  for (const name of ['operation.lock', 'backup.lock']) await assert.rejects(fs.stat(path.join(state, name)), { code: 'ENOENT' });
});

test('retention never deletes the newest successful backup or anything within seven days', () => {
  const old = { completedAt: '2026-10-01T00:00:00Z' };
  const boundary = { completedAt: '2026-10-15T00:00:00Z' };
  const current = { completedAt: '2026-10-22T00:00:00Z' };
  assert.deepEqual(retentionCandidates([old], now), []);
  assert.deepEqual(retentionCandidates([old, boundary, current], now), [old]);
});

async function fakeBackup(output, name, completedAt, overrides = {}) {
  const folder = path.join(output, name);
  await fs.mkdir(folder, { mode: 0o700 });
  const data = 'synthetic archive';
  await fs.writeFile(path.join(folder, 'database.dump'), data, { mode: 0o600 });
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, producer: 'kedapp-local-postgres-backup', runId: name, success: true,
    completedAt, database: 'kedapp_standby', port: 5433,
    archive: { file: 'database.dump', bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') },
    validation: { completeArchiveRead: true }, ...overrides,
  }), { mode: 0o600 });
  return folder;
}

test('retention prunes only verified owned backups and leaves unknown files and corrupt archives', async t => {
  const { output } = await fixture(t);
  await fs.mkdir(output, { mode: 0o700 });
  const oldest = await fakeBackup(output, 'local-20261001T000000000Z-11111111', '2026-10-01T00:00:00Z');
  const newest = await fakeBackup(output, 'local-20261022T000000000Z-22222222', '2026-10-22T00:00:00Z');
  const unknown = await fakeBackup(output, 'local-20261002T000000000Z-33333333', '2026-10-02T00:00:00Z');
  await fs.writeFile(path.join(unknown, 'operator-note.txt'), 'keep me');
  const corrupt = await fakeBackup(output, 'local-20261003T000000000Z-44444444', '2026-10-03T00:00:00Z');
  await fs.writeFile(path.join(corrupt, 'database.dump'), 'corrupted archive');
  assert.equal(await pruneBackups(output, now), 1);
  await assert.rejects(fs.stat(oldest), { code: 'ENOENT' });
  for (const folder of [newest, unknown, corrupt]) assert.ok((await fs.stat(folder)).isDirectory());
});

test('a corrupt newer backup cannot cause the last valid successful archive to be pruned', async t => {
  const { output } = await fixture(t);
  await fs.mkdir(output, { mode: 0o700 });
  const valid = await fakeBackup(output, 'local-20261001T000000000Z-11111111', '2026-10-01T00:00:00Z');
  const corrupt = await fakeBackup(output, 'local-20261002T000000000Z-22222222', '2026-10-02T00:00:00Z');
  await fs.writeFile(path.join(corrupt, 'database.dump'), 'different archive');
  assert.equal(await pruneBackups(output, now), 0);
  assert.ok((await fs.stat(valid)).isDirectory());
});

function fakeTools({ failDecode = false, calls = [] } = {}) {
  return async (name, args, env) => {
    calls.push([name, args]);
    assert.equal(env.PGHOST, '127.0.0.1');
    if (args[0] === '--version') return `${name} (PostgreSQL) 17.6\n`;
    if (name === 'pg_dump') {
      await fs.writeFile(args.find(arg => arg.startsWith('--file=')).slice(7), 'synthetic dump');
      return '';
    }
    if (args[0] === '--list') return '; synthetic toc\n1; table entry\n';
    if (failDecode) throw new Error('tool error with private-password and user data');
    return '';
  };
}

test('success publishes a private complete archive only after full decoding, with no credentials in output', async t => {
  const { root, state, output } = await fixture(t);
  const calls = [];
  const result = await runBackup({ root, now, toolRunner: fakeTools({ calls }) });
  assert.equal(result.success, true);
  assert.ok(calls.some(([name, args]) => name === 'pg_restore' && args[0] === '--file=/dev/null'));
  const folder = path.join(output, result.runId);
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  for (const name of ['database.dump', 'manifest.json']) assert.equal((await fs.stat(path.join(folder, name))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')).validation.restoreTested, false);
  assert.doesNotMatch(JSON.stringify(result), /private-password|postgresql/);
  for (const name of ['operation.lock', 'backup.lock']) await assert.rejects(fs.stat(path.join(state, name)), { code: 'ENOENT' });
});

test('decoder failure leaves no successful backup, removes its partial archive, releases locks and redacts errors', async t => {
  const { root, state, output } = await fixture(t);
  let caught;
  try { await runBackup({ root, now, toolRunner: fakeTools({ failDecode: true }) }); }
  catch (error) { caught = error; }
  assert.ok(caught);
  assert.deepEqual(safeFailure(caught), { success: false, code: 'BACKUP_FAILED' });
  const [directory] = await fs.readdir(output);
  assert.deepEqual(await fs.readdir(path.join(output, directory)), []);
  for (const name of ['operation.lock', 'backup.lock']) await assert.rejects(fs.stat(path.join(state, name)), { code: 'ENOENT' });
});

test('the CLI error formatter never includes untrusted errors or connection secrets', () => {
  assert.deepEqual(safeFailure(Object.assign(new Error(migrator), { code: migrator })), { success: false, code: 'BACKUP_FAILED' });
  assert.deepEqual(safeFailure(Object.assign(new Error(migrator), { code: 'BACKUP_ABORTED' })), { success: false, code: 'BACKUP_ABORTED' });
});
