import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { REMOTE_LEASE_PROGRAM } from './remote-database-lease.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEON_DIRECT = 'ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech';
const NEON_POOLER = 'ep-still-field-a1u573oe-pooler.ap-southeast-1.aws.neon.tech';
const safeFailure = stage => new Error(`${stage} failed; deployment stopped without printing database credentials.`);

export function deploymentConfig(env) {
  const { PROD_HOST: host, PROD_USER: user, PROD_PORT: port, PROD_APP_ROOT: appRoot, SHA: sha, SITE_URL: siteUrl } = env;
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user ?? '') ||
      !/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/[A-Za-z0-9/_-]+$/.test(appRoot ?? '') || path.resolve(appRoot) !== appRoot || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw safeFailure('Deployment configuration');
  }
  let site;
  try { site = new URL(siteUrl); } catch { throw safeFailure('Production URL'); }
  if (site.protocol !== 'https:' || site.username || site.password || site.hash || site.search || site.pathname !== '/') throw safeFailure('Production URL');
  if (!['true', 'false'].includes(env.FIRST_DEPLOY)) throw safeFailure('First-deploy configuration');
  return { host, user, port, appRoot, sha, siteUrl: site.origin, firstDeploy: env.FIRST_DEPLOY === 'true' };
}

function parseDatabaseUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw safeFailure('Database configuration'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.username || !u.password || u.hash || /\s/.test(value)) throw safeFailure('Database configuration');
  const allowed = new Set(['schema', 'sslmode', 'channel_binding', 'connect_timeout', 'pool_timeout', 'connection_limit', 'application_name']);
  for (const [key, entry] of u.searchParams) {
    if (!allowed.has(key) || u.searchParams.getAll(key).length !== 1 || (key === 'schema' && entry !== 'public')) throw safeFailure('Database connection options');
  }
  try {
    if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(u.username) + decodeURIComponent(u.password))) throw new Error();
  } catch { throw safeFailure('Database configuration'); }
  return u;
}

export function migrationTarget(runtimeValue, migrationValue, localPort) {
  const runtime = parseDatabaseUrl(runtimeValue);
  const migration = parseDatabaseUrl(migrationValue);
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw safeFailure('SSH forwarding port');
  if (migration.hostname === '127.0.0.1' && runtime.hostname === '127.0.0.1' &&
      migration.port === '5433' && runtime.port === '5433' &&
      migration.pathname === '/kedapp_standby' && runtime.pathname === '/kedapp_standby' &&
      migration.username === 'kedapp_migrator' && runtime.username === 'kedapp_app') {
    migration.port = String(localPort);
    return { kind: 'server-local', url: migration.href };
  }
  if (migration.hostname === NEON_DIRECT && runtime.hostname === NEON_POOLER &&
      ['', '5432'].includes(migration.port) && ['', '5432'].includes(runtime.port) &&
      migration.pathname === '/neondb' && runtime.pathname === '/neondb' &&
      migration.username === 'neondb_owner' && runtime.username === 'neondb_owner' &&
      ['require', 'verify-full'].includes(migration.searchParams.get('sslmode'))) {
    return { kind: 'neon', url: migration.href };
  }
  throw safeFailure('Runtime and migration database identity');
}

export function databaseEnvironment(url, inherited) {
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(PG|DATABASE_URL|PRISMA)/i.test(key)));
  return { ...clean, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url };
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function sshArguments(config, localPort) {
  return ['-T', '-i', path.join(homedir(), '.ssh/deploy_key'), '-p', config.port,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:5433`, `${config.user}@${config.host}`,
    `node -e ${shellQuote(REMOTE_LEASE_PROGRAM)} ${shellQuote(config.appRoot)} ${shellQuote(config.sha)}`];
}

async function unusedLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export function startLease(config, port, spawnProcess = spawn) {
  const child = spawnProcess('ssh', sshArguments(config, port), { stdio: ['pipe', 'pipe', 'ignore'] });
  const controller = new AbortController();
  const waiting = new Map();
  let alive = true, nextId = 0, settled = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => die('SSH lease readiness'), 25000);
  const die = stage => {
    if (!alive) return;
    alive = false; clearTimeout(timer); controller.abort();
    const error = safeFailure(stage);
    if (!settled) { settled = true; rejectReady(error); }
    for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(error); }
    waiting.clear();
    child.kill('SIGTERM');
  };
  child.on('error', () => die('SSH connection'));
  // Drain the private protocol before treating an orderly SSH close as a loss.
  child.on('close', () => die('SSH lease'));
  child.stdin.on('error', () => die('SSH input'));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      if (line.length > 32768) throw new Error();
      const message = JSON.parse(line);
      if (message.type === 'ready' && !settled) {
        if (typeof message.runtimeUrl !== 'string' || typeof message.migrationUrl !== 'string') throw new Error();
        settled = true; clearTimeout(timer); resolveReady(message);
      } else if (message.type === 'result' && waiting.has(message.id)) {
        const request = waiting.get(message.id); waiting.delete(message.id); clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message);
        else request.reject(safeFailure('Remote release action'));
      } else throw new Error();
    } catch { die('SSH lease protocol'); }
  });
  return {
    ready, signal: controller.signal,
    abort() { die('Deployment interrupted'); },
    request(action) {
      if (!alive) return Promise.reject(safeFailure('SSH lease'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => die('Remote release action timeout'), 130000);
        waiting.set(id, { resolve, reject, timer: timeout });
        child.stdin.write(JSON.stringify({ id, action }) + '\n');
      });
    },
    async close() {
      if (!alive) return;
      const exited = new Promise(resolve => {
        const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        child.once('close', () => { clearTimeout(force); resolve(); });
      });
      try { await this.request('release'); }
      finally { child.stdin.end(); await exited; }
    },
  };
}

export async function runPrivateCommand(program, args, { env, signal, timeout = 600000, spawnProcess = spawn }) {
  if (signal.aborted) throw safeFailure('Database operation lease');
  await new Promise((resolve, reject) => {
    // Prisma may include the full datasource in diagnostics: never inherit stdio.
    // Give it a process group so cancellation also stops Prisma's schema engine.
    const child = spawnProcess(program, args, { cwd: ROOT, env, stdio: 'ignore', detached: true });
    let stopped = false, force;
    const killGroup = signalName => {
      try { if (child.pid) process.kill(-child.pid, signalName); else child.kill(signalName); } catch { /* Already exited. */ }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), 5000);
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true });
    const finish = code => {
      clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', stop);
      if (stopped) killGroup('SIGKILL');
      if (code === 0 && !stopped) resolve();
      else reject(safeFailure('Database command'));
    };
    child.once('error', () => { if (child.pid) stop(); else finish(1); });
    child.once('exit', finish);
    if (signal.aborted) stop();
  });
}

async function healthCheck(siteUrl, revision, signal) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (signal.aborted) throw safeFailure('Database operation lease');
    try {
      const response = await fetch(`${siteUrl}/api/health`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), cache: 'no-store' });
      const body = await response.json();
      if (response.ok && body.status === 'ok' && body.revision === revision) return;
    } catch { /* Retry only the bounded activation health check. */ }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw safeFailure('Production health check');
}

export async function deployProduction(env = process.env) {
  const config = deploymentConfig(env);
  const port = await unusedLocalPort();
  const lease = startLease(config, port);
  const interrupted = () => lease.abort();
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  let activationStarted = false;
  try {
    const remote = await lease.ready;
    const target = migrationTarget(remote.runtimeUrl, remote.migrationUrl, port);
    const commandEnv = databaseEnvironment(target.url, env);
    console.log(`Production database source: server shared/.env (${target.kind}).`);
    await lease.request('check');
    await runPrivateCommand(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: commandEnv, signal: lease.signal });
    console.log('Production migrations completed.');
    if (config.firstDeploy) {
      await runPrivateCommand(process.execPath, [path.join(ROOT, 'scripts/v2-cutover-preflight.mjs')], {
        env: { ...commandEnv, V2_COMPETITIONS_CREATION_MODE: 'PAUSED' }, signal: lease.signal,
      });
      console.log('First V2 cutover preflight passed.');
    }
    await lease.request('check');
    activationStarted = true;
    await lease.request('activate');
    await healthCheck(config.siteUrl, config.sha, lease.signal);
    await lease.request('check');
    console.log(`Production activation and health check passed for ${config.sha}.`);
  } catch {
    if (activationStarted && !lease.signal.aborted) {
      try {
        const rollback = await lease.request('rollback');
        if (rollback.stopped) console.error('Failed first deployment stopped; no previous application release was available.');
        else {
          await healthCheck(config.siteUrl, rollback.revision, lease.signal);
          console.error('Application restored to the previously running release; database configuration was not changed.');
        }
      } catch { console.error('Application rollback could not be verified; operator attention required.'); }
    }
    // Never echo remote/process exceptions; their fields may contain a URL.
    throw safeFailure('Production deployment');
  } finally {
    process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
    await lease.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployProduction().catch(() => { console.error('Production deployment failed; database credentials were not logged.'); process.exitCode = 1; });
}
