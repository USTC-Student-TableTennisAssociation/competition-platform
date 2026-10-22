import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { databaseEnvironment, deploymentConfig, migrationTarget, runPrivateCommand, sshArguments, startLease } from '../deploy/remote-database.mjs';
import { REMOTE_LEASE_PROGRAM } from '../deploy/remote-database-lease.mjs';

const sha = 'a'.repeat(40);
const runtime = 'postgresql://kedapp_app:secret-app@127.0.0.1:5433/kedapp_standby?schema=public&connection_limit=8';
const migration = 'postgresql://kedapp_migrator:secret-migration@127.0.0.1:5433/kedapp_standby?schema=public&connection_limit=2';
const direct = 'postgresql://neondb_owner:secret-neon@ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const pooled = direct.replace('a1u573oe.', 'a1u573oe-pooler.');
const configured = { PROD_HOST: 'example.test', PROD_USER: 'ubuntu', PROD_PORT: '22', PROD_APP_ROOT: '/var/www/kedapp', SHA: sha, SITE_URL: 'https://kedapp.club', FIRST_DEPLOY: 'false' };

test('accepts only explicit safe deployment inputs and HTTPS smoke URL', () => {
  assert.equal(deploymentConfig(configured).appRoot, '/var/www/kedapp');
  for (const change of [{ PROD_HOST: '-bad' }, { PROD_USER: 'ubuntu;env' }, { PROD_PORT: '65536' },
    { PROD_APP_ROOT: '/var/../www' }, { SHA: 'main' }, { SITE_URL: 'http://kedapp.club' },
    { SITE_URL: 'https://user:password@kedapp.club' }, { FIRST_DEPLOY: undefined }]) {
    assert.throws(() => deploymentConfig({ ...configured, ...change }));
  }
});

test('uses the configured direct Neon target before cutover and loopback SSH after it', () => {
  assert.deepEqual(migrationTarget(pooled, direct, 15433), { kind: 'neon', url: direct });
  const local = migrationTarget(runtime, migration, 15433);
  assert.equal(local.kind, 'server-local');
  assert.equal(new URL(local.url).hostname, '127.0.0.1');
  assert.equal(new URL(local.url).port, '15433');
  assert.equal(new URL(local.url).username, 'kedapp_migrator');
  assert.equal(new URL(local.url).searchParams.get('connection_limit'), '2');
});

test('rejects database drift, wrong roles, overrides, missing TLS and malformed credentials', () => {
  for (const [app, migrate] of [
    [runtime, direct], [pooled, migration], [runtime, migration.replace('5433', '5432')],
    [runtime, migration.replace('kedapp_standby', 'postgres')], [runtime, migration.replace('kedapp_migrator', 'postgres')],
    [migration, migration], [runtime, migration + '&host=evil'], [runtime, migration + '&schema=other'],
    [runtime, migration + '#bad'], [runtime, migration.replace('secret-migration', 'bad%00')],
    [pooled, direct.replace('?sslmode=require', '')], [undefined, migration], [runtime, undefined],
  ]) {
    assert.throws(() => migrationTarget(app, migrate, 15433), error => {
      assert.doesNotMatch(error.message, /secret-|postgresql:|neon\.tech/);
      return true;
    });
  }
});

test('clears inherited database and Prisma overrides before using the server configuration', () => {
  assert.deepEqual(databaseEnvironment(migration, { DATABASE_URL: 'evil', DATABASE_URL_UNPOOLED: 'evil',
    PGHOST: 'evil', PGSERVICEFILE: '/evil', PGOPTIONS: 'evil', PRISMA_SCHEMA_ENGINE_BINARY: '/evil', PATH: '/bin' }),
  { PATH: '/bin', DATABASE_URL: migration, DATABASE_URL_UNPOOLED: migration });
});

test('SSH binds only loopback and fails if the requested forwarding cannot start', () => {
  const args = sshArguments(deploymentConfig(configured), 15433);
  assert.ok(args.includes('127.0.0.1:15433:127.0.0.1:5433'));
  for (const guard of ['ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'ServerAliveCountMax=3']) assert.ok(args.includes(guard));
  assert.ok(!args.some(arg => arg.includes('secret-')));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true; child.stdout.end(); child.stdin.destroy();
    queueMicrotask(() => { child.emit('exit', 1); child.emit('close', 1); });
  };
  return child;
}

test('SSH or tunnel startup failures abort before any migration and hide raw errors', async () => {
  const child = fakeChild();
  const lease = startLease(deploymentConfig(configured), 15433, () => child);
  child.emit('error', new Error('secret-migration postgresql://private'));
  await assert.rejects(lease.ready, error => !error.message.includes('secret-migration'));
  assert.equal(lease.signal.aborted, true);
  assert.equal(child.killed, true);
});

test('a lost lease aborts active operations and rejects outstanding release actions', async () => {
  const child = fakeChild();
  const lease = startLease(deploymentConfig(configured), 15433, () => child);
  child.stdout.write(JSON.stringify({ type: 'ready', runtimeUrl: runtime, migrationUrl: migration }) + '\n');
  await lease.ready;
  const request = lease.request('check');
  child.emit('exit', 255);
  child.emit('close', 255);
  await assert.rejects(request);
  assert.equal(lease.signal.aborted, true);
  await lease.close();
});

test('Prisma diagnostics cannot be inherited or printed on command failure', async () => {
  const child = fakeChild();
  let stdio;
  const running = runPrivateCommand('fake-prisma', [], { env: {}, signal: new AbortController().signal,
    spawnProcess: (_program, _args, options) => { stdio = options.stdio; return child; } });
  child.emit('error', new Error('postgresql://owner:secret-migration@private'));
  await assert.rejects(running, error => !error.message.includes('secret-migration'));
  assert.equal(stdio, 'ignore');
});

test('cancelling a database command stops its worker process before returning', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kedapp-command-'));
  const heartbeat = path.join(directory, 'heartbeat');
  const pidFile = path.join(directory, 'worker.json');
  let worker;
  t.after(() => {
    if (worker) { try { process.kill(worker, 'SIGKILL'); } catch { /* Already stopped. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  const program = `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10)', process.argv[1]], {stdio:'ignore'});
    fs.writeFileSync(process.argv[2], JSON.stringify({worker:child.pid}));
    setInterval(()=>{},1000);
  `;
  const controller = new AbortController();
  const command = runPrivateCommand(process.execPath, ['-e', program, heartbeat, pidFile], { env: process.env, signal: controller.signal, timeout: 5000 });
  const rejected = assert.rejects(command);
  for (let attempt = 0; attempt < 100 && !existsSync(heartbeat); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(heartbeat), true);
  worker = JSON.parse(readFileSync(pidFile)).worker;
  controller.abort();
  await rejected;
  const after = readFileSync(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(readFileSync(heartbeat, 'utf8'), after);
});

function remoteFixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kedapp-lease-')));
  const state = path.join(root, 'shared/database-standby');
  const release = path.join(root, 'releases', sha);
  const previousRevision = 'b'.repeat(40);
  const runningRelease = path.join(root, 'releases', previousRevision);
  mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700);
  mkdirSync(release, { recursive: true });
  mkdirSync(runningRelease, { recursive: true });
  writeFileSync(path.join(runningRelease, 'REVISION'), previousRevision + '\n');
  const envFile = path.join(root, 'shared/.env');
  writeFileSync(envFile, `DATABASE_URL=${runtime}\nDATABASE_URL_UNPOOLED=${migration}\n`, { mode: 0o600 });
  writeFileSync(path.join(release, 'REVISION'), sha + '\n');
  writeFileSync(path.join(release, 'activate-release.sh'), '#!/bin/sh\nprintf "%s" "$1" > "$2/activated"\n');
  symlinkSync(envFile, path.join(release, '.env'));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify([{ name: 'kedapp', pm2_env: { pm_cwd: runningRelease } }]))});\n`, { mode: 0o755 });
  const fixtureEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  function run() {
    const child = spawn(process.execPath, ['-e', REMOTE_LEASE_PROGRAM, root, sha], { stdio: ['pipe', 'pipe', 'pipe'], env: fixtureEnv });
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    const queue = [], waiters = [];
    lines.on('line', line => {
      const item = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(item); else queue.push(item);
    });
    return { child, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)) };
  }
  return { root, state, envFile, release, previousRevision, fixtureEnv, run };
}

test('server lease owns the operation lock until commands and explicit release finish', async t => {
  const f = remoteFixture(t); const { child, next } = f.run();
  const ready = await next();
  assert.equal(ready.type, 'ready');
  assert.equal(ready.migrationUrl, migration);
  const ownerFile = path.join(f.state, 'operation.lock/owner.json');
  assert.equal(JSON.parse(readFileSync(ownerFile)).purpose, 'production-deploy');
  child.stdin.write(JSON.stringify({ id: 1, action: 'check' }) + '\n');
  assert.equal((await next()).ok, true);
  child.stdin.write(JSON.stringify({ id: 2, action: 'activate' }) + '\n');
  assert.equal((await next()).ok, true);
  assert.equal(existsSync(path.join(f.root, 'activated')), true);
  const exited = once(child, 'exit');
  child.stdin.write(JSON.stringify({ id: 3, action: 'release' }) + '\n');
  assert.equal((await next()).ok, true);
  await exited;
  assert.equal(existsSync(path.join(f.state, 'operation.lock')), false);
});

test('an unexpected runner disconnect leaves a lock for reconciliation', async t => {
  const f = remoteFixture(t); const { child, next } = f.run();
  assert.equal((await next()).type, 'ready');
  const exited = once(child, 'exit'); child.stdin.end(); await exited;
  assert.equal(existsSync(path.join(f.state, 'operation.lock/owner.json')), true);
});

test('a failed activation rolls back to the initially running release, not a stale previous symlink', async t => {
  const f = remoteFixture(t);
  writeFileSync(path.join(f.release, 'activate-release.sh'), `#!/bin/sh\nif [ "$1" = "${sha}" ]; then exit 1; fi\nprintf "%s" "$1" > "$2/activated"\n`);
  symlinkSync(path.join(f.root, 'releases', 'c'.repeat(40)), path.join(f.root, 'previous'));
  const { child, next } = f.run();
  assert.equal((await next()).type, 'ready');
  child.stdin.write(JSON.stringify({ id: 1, action: 'activate' }) + '\n');
  assert.equal((await next()).ok, false);
  child.stdin.write(JSON.stringify({ id: 2, action: 'rollback' }) + '\n');
  assert.equal((await next()).revision, f.previousRevision);
  assert.equal(readFileSync(path.join(f.root, 'activated'), 'utf8'), f.previousRevision);
});

test('the runner drains the release acknowledgement before SSH closes', async t => {
  const f = remoteFixture(t);
  const lease = startLease(deploymentConfig(configured), 15433, (_program, _args, options) =>
    spawn(process.execPath, ['-e', REMOTE_LEASE_PROGRAM, f.root, sha], { ...options, env: f.fixtureEnv }));
  await lease.ready;
  await lease.request('check');
  await lease.close();
  assert.equal(existsSync(path.join(f.state, 'operation.lock')), false);
});

test('server refuses an existing maintenance lock without stealing or removing it', async t => {
  const f = remoteFixture(t);
  mkdirSync(path.join(f.state, 'operation.lock'));
  writeFileSync(path.join(f.state, 'operation.lock/owner.json'), '{"pid":999999,"purpose":"cutover"}');
  const { child, next } = f.run();
  assert.equal((await next()).type, 'failure');
  if (child.exitCode === null) await once(child, 'exit');
  assert.equal(JSON.parse(readFileSync(path.join(f.state, 'operation.lock/owner.json'))).purpose, 'cutover');
});

test('a changed environment cannot activate a release under an old migration target', async t => {
  const f = remoteFixture(t); const { child, next } = f.run();
  assert.equal((await next()).type, 'ready');
  writeFileSync(f.envFile, `DATABASE_URL=${pooled}\nDATABASE_URL_UNPOOLED=${direct}\n`);
  child.stdin.write(JSON.stringify({ id: 1, action: 'activate' }) + '\n');
  assert.equal((await next()).ok, false);
  assert.equal(existsSync(path.join(f.root, 'activated')), false);
});

test('missing config or unsafe file permissions never produce a ready credential message', async t => {
  const f = remoteFixture(t);
  chmodSync(f.envFile, 0o644);
  const { child, next } = f.run();
  assert.equal((await next()).type, 'failure');
  if (child.exitCode === null) await once(child, 'exit');
  assert.equal(existsSync(path.join(f.state, 'operation.lock')), false);
});
