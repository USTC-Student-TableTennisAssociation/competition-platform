// This program is sent over SSH; it never runs a database command itself.
// Its stdout is a private machine protocol, captured by remote-database.mjs.
export const REMOTE_LEASE_PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const [root, sha] = process.argv.slice(1);
let ownsLock = false, announced = false, released = false;
let lock, original, watcher, expiry;
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
const stop = () => {
  clearInterval(watcher); clearTimeout(expiry);
  if (ownsLock && (!announced || released)) {
    // Never remove a lock replaced by a different operator.
    try {
      if (JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid === process.pid) {
        fs.rmSync(lock, { recursive: true });
      }
    } catch {}
    ownsLock = false;
  }
};
const fail = () => { reply({ type: 'failure' }); stop(); process.exit(1); };
process.on('SIGTERM', () => { stop(); process.exit(1); });
process.on('SIGINT', () => { stop(); process.exit(1); });
process.on('exit', stop);
try {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(root) || path.resolve(root) !== root || !/^[a-f0-9]{40}$/.test(sha)) throw new Error();
  const state = path.join(root, 'shared/database-standby');
  const stateInfo = fs.lstatSync(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || (stateInfo.mode & 0o077) || stateInfo.uid !== process.getuid()) throw new Error();
  lock = path.join(state, 'operation.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  ownsLock = true;
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, purpose: 'production-deploy', revision: sha, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  const envPath = path.join(root, 'shared/.env');
  const readConfig = () => {
    const info = fs.lstatSync(envPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 65536) throw new Error();
    return fs.readFileSync(envPath);
  };
  original = createHash('sha256').update(readConfig()).digest('hex');
  const assertConfig = () => {
    if (!ownsLock || JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid !== process.pid ||
        createHash('sha256').update(readConfig()).digest('hex') !== original) throw new Error();
  };
  const env = parseEnv(readConfig().toString('utf8'));
  if (!env.DATABASE_URL || !env.DATABASE_URL_UNPOOLED) throw new Error();
  const release = path.join(root, 'releases', sha);
  if (fs.readFileSync(path.join(release, 'REVISION'), 'utf8').trim() !== sha ||
      fs.realpathSync(path.join(release, '.env')) !== fs.realpathSync(envPath)) throw new Error();
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL)/i.test(key)));
  const listing = spawnSync('pm2', ['jlist'], { env: cleanEnv, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  if (listing.error || listing.status !== 0) throw new Error();
  const applications = JSON.parse(listing.stdout).filter(app => app.name === 'kedapp');
  if (applications.length > 1) throw new Error();
  const current = path.join(root, 'current');
  const previousRelease = applications.length === 1 ? fs.realpathSync(applications[0].pm2_env.pm_cwd)
    : fs.existsSync(current) ? fs.realpathSync(current) : null;
  let rollbackRevision = null;
  if (previousRelease) {
    rollbackRevision = fs.readFileSync(path.join(previousRelease, 'REVISION'), 'utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(rollbackRevision) || previousRelease !== path.join(root, 'releases', rollbackRevision)) throw new Error();
  }
  const activate = revision => {
    assertConfig();
    const result = spawnSync('bash', [path.join(release, 'activate-release.sh'), revision, root], {
      env: cleanEnv, stdio: 'ignore', timeout: 120000,
    });
    if (result.error || result.status !== 0) throw new Error();
    assertConfig();
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      if (line.length > 256) throw new Error();
      const request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id)) throw new Error();
      assertConfig();
      if (request.action === 'release') {
        released = true;
        reply({ type: 'result', id: request.id, ok: true });
        stop(); process.exit(0);
      } else if (request.action === 'check') {
        reply({ type: 'result', id: request.id, ok: true });
      } else if (request.action === 'activate') {
        activate(sha);
        reply({ type: 'result', id: request.id, ok: true });
      } else if (request.action === 'rollback') {
        if (rollbackRevision) {
          activate(rollbackRevision);
          reply({ type: 'result', id: request.id, ok: true, revision: rollbackRevision });
        } else {
          const stopped = spawnSync('pm2', ['stop', 'kedapp'], { env: cleanEnv, stdio: 'ignore', timeout: 15000 });
          if (stopped.error || stopped.status !== 0) throw new Error();
          reply({ type: 'result', id: request.id, ok: true, stopped: true });
        }
      } else throw new Error();
    } catch {
      // Keep the lease for a possible controlled rollback after activation fails.
      try { reply({ type: 'result', id: JSON.parse(line).id, ok: false }); } catch { fail(); }
    }
  });
  // A lost runner may still have an in-flight direct-Neon migration. Leave the
  // lock for an operator to reconcile; only the explicit release command clears it.
  lines.on('close', () => { stop(); process.exit(1); });
  watcher = setInterval(() => { try { assertConfig(); } catch { fail(); } }, 2000);
  expiry = setTimeout(fail, 30 * 60 * 1000);
  announced = true;
  reply({ type: 'ready', runtimeUrl: env.DATABASE_URL, migrationUrl: env.DATABASE_URL_UNPOOLED });
} catch { fail(); }
`;
