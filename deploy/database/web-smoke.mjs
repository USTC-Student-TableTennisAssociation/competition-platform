import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ORIGIN = 'http://127.0.0.1:3001';

export function pageHasErrorTemplate(body) {
  // Next serializes reusable not-found boundaries into successful RSC responses.
  // Only an actual HTML error shell or rendered error text is a failure.
  const markup = body.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return /比赛详情暂不可用|站点状态暂时无法确认|Internal Server Error|This page could not be found|id=["']__next_error__["']/.test(markup);
}
const HELP = `Usage:
  node web-smoke.mjs --connection-file /private/preview.url
    --release /private/independent-release-copy [--output-dir /private/new-directory]
    [--dry-run]

Only 127.0.0.1:5433/kedapp_standby is accepted, using an owned 0600 URL file.
The release must be an independent copy with server.js, REVISION, .next/static,
public and its generated @prisma/client. All .env* files/symlinks must be absent;
Next would otherwise reload production secrets from disk after env sanitization.
The script launches that copy on 127.0.0.1:3001 only, then stops only its child.
No Nginx/PM2/release pointer/production config or database data is modified.

A random independent AUTH_SECRET and ADMIN_REAUTH_SECRET are used. A short-lived
six-part session is generated in memory from one verified non-banned account.
No password hash, user ID, cookie, secret, HTML, or name enters the report.
GET checks: health/revision, auth, authenticated home, men's/women's competitions,
and the supermarket SSR title. Catalog client Server Actions are not invoked.

KNOWN LIMITATION: Home GET calls expireOpenMatchPosts()->matchPost.updateMany().
The hard read-only role should block this. A blocked home returns exit 2 and
success:false with otherReadChecksPassed:true; it is never called full success.
Other failures return exit 1. All pages passing returns exit 0.
--help and --dry-run open no database connection and launch no application.
`;

function parseArgs() {
  const options = {};
  const input = process.argv.slice(2);
  if (input.includes('--help')) return { help: true };
  for (let index = 0; index < input.length; index++) {
    const key = input[index];
    if (key === '--dry-run' || key === '--account-worker') options[key] = true;
    else if (['--connection-file', '--release', '--output-dir'].includes(key) && input[index + 1] && !input[index + 1].startsWith('--')) options[key] = input[++index];
    else throw new Error('Invalid command option.');
  }
  if (!options['--connection-file'] || !options['--release']) throw new Error('Connection file and independent release copy are required.');
  return options;
}

async function connection(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || stat.uid !== process.getuid() || stat.size > 8192) throw new Error('Unsafe connection file.');
  const raw = (await fs.readFile(filePath, 'utf8')).trim();
  if (/\s/.test(raw)) throw new Error('Unexpected connection file format.');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '5433' || url.pathname !== '/kedapp_standby' || !url.username || !url.password) throw new Error('Unexpected standby identity.');
  const allowed = new Set(['schema', 'sslmode', 'connection_limit', 'connect_timeout', 'pool_timeout', 'application_name']);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || (key === 'schema' && value !== 'public')) throw new Error('Unsupported connection option.');
  }
  url.searchParams.set('sslmode', 'disable');
  url.searchParams.set('connection_limit', '3');
  url.searchParams.set('connect_timeout', '3');
  url.searchParams.set('pool_timeout', '3');
  return url;
}

async function inspectRelease(input) {
  const release = await fs.realpath(input);
  const names = await fs.readdir(release);
  if (names.some((name) => name === '.env' || name.startsWith('.env.'))) throw new Error('Release copy contains env files or symlinks.');
  for (const name of ['server.js', 'REVISION', '.next/static', 'public']) await fs.access(path.join(release, name));
  const revision = (await fs.readFile(path.join(release, 'REVISION'), 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid release revision.');
  return { release, revision };
}

function isolatedEnv(url, authSecret, adminSecret) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=384', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href,
    AUTH_SECRET: authSecret, ADMIN_REAUTH_SECRET: adminSecret,
    APP_URL: ORIGIN, NEXT_PUBLIC_APP_URL: ORIGIN,
    HOSTNAME: '127.0.0.1', PORT: '3001',
  };
}

async function accountWorker(options) {
  if (!process.send || !process.env.AUTH_SECRET) throw new Error('Internal worker requires private IPC.');
  const url = await connection(options['--connection-file']);
  url.searchParams.set('connection_limit', '1');
  const require = createRequire(path.join(await fs.realpath(options['--release']), 'package.json'));
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
  try {
    const user = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3s'");
      const rows = await tx.$queryRawUnsafe(`SELECT
        current_database()='kedapp_standby' AND inet_server_port()=5433 AND inet_server_addr()='127.0.0.1'::inet AS identity,
        NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS role_safe,
        (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS writable_tables,
        NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE') AS no_create,
        (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS security_definers`);
      const proof = rows[0];
      if (!proof?.identity || !proof.role_safe || proof.writable_tables !== 0 || !proof.no_create || proof.security_definers !== 0) throw new Error('Standby read-only account proof failed.');
      return tx.user.findFirst({
        where: { isBanned: false, role: 'user', emailVerifiedAt: { not: null }, hashedPassword: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, hashedPassword: true, sessionVersion: true },
      });
    }, { maxWait: 2_000, timeout: 8_000 });
    if (!user?.hashedPassword || !Number.isSafeInteger(user.sessionVersion)) throw new Error('No usable verified account.');
    const secret = process.env.AUTH_SECRET;
    const stamp = createHmac('sha256', secret).update(`${user.id}.${user.hashedPassword}`).digest('hex');
    const payload = `${user.id}.${user.sessionVersion}.${Date.now() + 90_000}.${randomBytes(16).toString('hex')}.${stamp}`;
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    // IPC only: no secret, hash, identifier or cookie is written to stdout/files.
    process.send({ token: `${payload}.${signature}` });
  } finally { await client.$disconnect(); }
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 3001, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function main(options) {
  process.umask(0o077);
  const deadline = Date.now() + 60_000;
  const url = await connection(options['--connection-file']);
  const { release, revision } = await inspectRelease(options['--release']);
  const report = (value) => console.log(JSON.stringify(value));
  if (options['--dry-run']) {
    report({ stage: 'dry-run', success: true, release, maximumSeconds: 60, maximumDatabaseConnections: 3,
      homepageHasKnownReadOnlySideEffect: true });
    return;
  }
  const directory = options['--output-dir'] ? path.resolve(options['--output-dir']) : await fs.mkdtemp('/tmp/tta-web-smoke-');
  if (options['--output-dir']) await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const logPath = path.join(directory, 'server.log');
  const log = await fs.open(logPath, 'wx', 0o600);
  const workerLog = await fs.open(path.join(directory, 'account-worker.log'), 'wx', 0o600);
  const authSecret = randomBytes(32).toString('hex');
  const adminSecret = randomBytes(32).toString('hex');
  const env = isolatedEnv(url, authSecret, adminSecret);
  let child;
  let childAlive = false;
  let worker;
  let stopped = true;
  let interrupted = false;
  let stage = 'setup';
  let outcome = { success: false, otherReadChecksPassed: false, homepageKnownReadOnlySideEffect: false, checks: [] };
  let graceTimer;
  const signalChild = (signal) => {
    if (childAlive && child?.pid) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const onSignal = () => { interrupted = true; worker?.kill('SIGTERM'); signalChild('SIGTERM'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const deadlineTimer = setTimeout(() => {
    interrupted = true; worker?.kill('SIGKILL'); signalChild('SIGTERM');
    graceTimer = setTimeout(() => signalChild('SIGKILL'), 1_000);
  }, Math.max(1, deadline - Date.now()));

  async function http(route, cookie, maximumMs = 6_000) {
    if (interrupted || Date.now() >= deadline) throw new Error('Smoke deadline reached.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(maximumMs, deadline - Date.now())));
    try {
      const response = await fetch(`${ORIGIN}${route}`, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { ...(cookie ? { Cookie: `ustc_tta_session=${cookie}` } : {}), 'Cache-Control': 'no-cache' },
      });
      const reader = response.body?.getReader();
      const chunks = [];
      let length = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Response exceeds private memory limit.'); }
          chunks.push(Buffer.from(value));
        }
      }
      return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
    } finally { clearTimeout(timer); }
  }
  try {
    stage = 'account-and-readonly-proof';
    const token = await new Promise((resolve, reject) => {
      let message;
      let spawnError;
      let timedOut = false;
      worker = spawn(process.execPath, [SCRIPT, '--account-worker', '--connection-file', path.resolve(options['--connection-file']), '--release', release], {
        env, cwd: release, shell: false, stdio: ['ignore', workerLog.fd, workerLog.fd, 'ipc'],
      });
      const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 12_000);
      worker.on('message', (value) => { if (typeof value?.token === 'string' && value.token.length < 1024) message = value.token; });
      worker.once('error', (error) => { spawnError = error; });
      worker.once('close', (code) => {
        clearTimeout(timer); worker = undefined;
        if (code === 0 && message && !spawnError && !timedOut && !interrupted) resolve(message);
        else reject(new Error('Private account worker failed.'));
      });
    });
    report({ stage, success: true });

    stage = 'loopback-server-start';
    await assertPortFree();
    let serverSpawnError;
    child = spawn(process.execPath, ['server.js'], { cwd: release, env, shell: false, detached: true, stdio: ['ignore', log.fd, log.fd] });
    childAlive = Boolean(child.pid); stopped = false;
    child.once('error', (error) => { serverSpawnError = error; });
    child.once('close', () => { childAlive = false; });
    let health;
    const startupDeadline = Math.min(deadline, Date.now() + 12_000);
    while (Date.now() < startupDeadline && !interrupted) {
      if (serverSpawnError || !childAlive) throw new Error('Private application failed to start.');
      try {
        const response = await http('/api/health', undefined, 1_000);
        const value = JSON.parse(response.body);
        if (response.status === 200 && value.status === 'ok' && value.revision === revision) { health = response; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!health || !childAlive || serverSpawnError) throw new Error('Private health/revision check failed.');
    outcome.checks.push({ page: 'health', status: health.status, titleMatched: true, passed: true });
    report({ stage, success: true });

    stage = 'read-only-web-pages';
    const pages = [
      { label: 'auth', route: '/auth', authenticated: false, title: /登录 USTC TTA/ },
      { label: 'home', route: '/', authenticated: true, title: /我的比赛|近期比赛|约球|USTC TTA/ },
      { label: 'men', route: '/matchs/cmuxw9liu000swlp2m44ihhi3', authenticated: true, title: /继往开来/, extra: /男子/ },
      { label: 'women', route: '/matchs/cmuxwaor20016wlp2swtr3pes', authenticated: true, title: /继往开来/, extra: /女子/ },
      { label: 'supermarket', route: '/supermarket', authenticated: true, title: /积分商店/ },
    ];
    for (const page of pages) {
      let item;
      try {
        const response = await http(page.route, page.authenticated ? token : undefined);
        const titleMatched = page.title.test(response.body) && (!page.extra || page.extra.test(response.body));
        const passed = response.status === 200 && titleMatched && !pageHasErrorTemplate(response.body);
        item = { page: page.label, status: response.status, titleMatched, passed };
      } catch { item = { page: page.label, status: 0, titleMatched: false, passed: false }; }
      outcome.checks.push(item);
      report({ stage: page.label, success: item.passed, status: item.status, titleMatched: item.titleMatched });
    }
    const home = outcome.checks.find((item) => item.page === 'home');
    const serverDiagnostics = await fs.readFile(logPath, 'utf8');
    const blockedUpdate = /matchPost\.updateMany|expireOpenMatchPosts|MatchPost/.test(serverDiagnostics)
      && /permission denied|read.only transaction|read-only|P2004|P2010|P1010/i.test(serverDiagnostics);
    outcome.otherReadChecksPassed = outcome.checks.filter((item) => item.page !== 'home').every((item) => item.passed);
    outcome.homepageKnownReadOnlySideEffect = home?.status === 500 && blockedUpdate;
    outcome.success = outcome.checks.every((item) => item.passed);
  } catch (error) {
    await fs.writeFile(path.join(directory, 'failure.log'), `${error?.stack ?? String(error)}\n`, { mode: 0o600, flag: 'a' });
    report({ stage, success: false, diagnosticsDirectory: directory });
  } finally {
    stage = 'stop-private-server';
    if (childAlive) {
      try {
        signalChild('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('close', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (childAlive) {
          signalChild('SIGKILL');
          await Promise.race([
            new Promise((resolve) => child.once('close', resolve)),
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
        stopped = !childAlive;
      } catch { stopped = false; }
    } else stopped = true;
    worker?.kill('SIGKILL');
    clearTimeout(deadlineTimer); clearTimeout(graceTimer);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    await log.close(); await workerLog.close();
    outcome.success = outcome.success && stopped && !interrupted;
    outcome = { ...outcome, privateServerStopped: stopped, supermarketCatalogActionInvoked: false, diagnosticsDirectory: directory };
    await fs.writeFile(path.join(directory, 'web-smoke-report.json'), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    report({ stage: 'complete', ...outcome });
    if (!outcome.success) process.exitCode = outcome.otherReadChecksPassed && outcome.homepageKnownReadOnlySideEffect && stopped && !interrupted ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
try {
  process.umask(0o077);
  const options = parseArgs();
  if (options.help) console.log(HELP);
  else if (options['--account-worker']) await accountWorker(options);
  else await main(options);
} catch (error) {
  if (process.argv.includes('--account-worker')) console.error(error?.stack ?? String(error)); // Captured only by parent in its 0600 diagnostic log.
  else console.error(JSON.stringify({ stage: 'setup', success: false }));
  process.exitCode = 1;
}
}
