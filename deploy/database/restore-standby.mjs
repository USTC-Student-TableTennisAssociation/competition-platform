#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This command can refresh only the private standby. It cannot activate it.
const ROOT = '/var/www/kedapp';
const STATE = `${ROOT}/shared/database-standby`;
const BIN = '/usr/lib/postgresql/17/bin';
const DB = 'kedapp_standby';
const PRODUCTION_HOST = 'ep-still-field-a1u573oe-pooler.ap-southeast-1.aws.neon.tech';
const DIRECT_HOST = 'ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech';
const LOCK = `${STATE}/operation.lock`;
let ownsLock = false;

function run(program, args, { input, env, log } = {}) {
  const result = spawnSync(program, args, {
    input, env: env ?? process.env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (log) fs.writeFileSync(log, result.stderr ?? '', { mode: 0o600 });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(program)} failed; inspect private diagnostics.`);
  }
  return result.stdout.trim();
}

function admin(sql) {
  return run('sudo', ['-n', 'runuser', '-u', 'postgres', '--', `${BIN}/psql`,
    '-X', '-h', '/var/run/postgresql', '-U', 'postgres', '-p', '5433',
    '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('PG') && !key.startsWith('DATABASE_URL'))),
  });
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function connectionEnv(connection, inherited = process.env) {
  const u = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hash ||
      u.hostname !== '127.0.0.1' || u.port !== '5433' || !u.password ||
      u.pathname !== `/${DB}` || u.username !== 'kedapp_migrator') {
    throw new Error('Refusing any database other than the designated local standby.');
  }
  const env = Object.fromEntries(Object.entries(inherited)
    .filter(([key]) => !key.startsWith('PG') && !key.startsWith('DATABASE_URL')));
  return { ...env, PGHOST: '127.0.0.1', PGPORT: '5433', PGDATABASE: DB,
    PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c default_transaction_read_only=off -c statement_timeout=90000' };
}

function assertNeonIsStillProduction() {
  const env = parseEnv(fs.readFileSync(`${ROOT}/shared/.env`, 'utf8'));
  for (const [key, host] of [['DATABASE_URL', PRODUCTION_HOST], ['DATABASE_URL_UNPOOLED', DIRECT_HOST]]) {
    const u = new URL(env[key]);
    if (u.hostname !== host || u.pathname !== '/neondb') {
      throw new Error('Production target changed. Refusing to replace the standby.');
    }
  }
  // An inherited PM2 variable takes priority over Next's .env loader.
  const processes = JSON.parse(run('pm2', ['jlist'])).filter(p => p.name === 'kedapp');
  if (processes.length !== 1) throw new Error('Expected one declared production application.');
  const application = processes[0];
  if (!application.pid && application.pm2_env?.status !== 'stopped') {
    throw new Error('Production application is neither running nor deliberately stopped.');
  }
  const entries = application.pid
    ? fs.readFileSync(`/proc/${application.pid}/environ`, 'utf8').split('\0')
    : Object.entries(application.pm2_env?.env ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    if (application.pm2_env?.[key]) entries.push(`${key}=${application.pm2_env[key]}`);
  }
  for (const entry of entries) {
    if (/^DATABASE_URL(?:_UNPOOLED)?=/.test(entry)) {
      const u = new URL(entry.slice(entry.indexOf('=') + 1));
      if (![PRODUCTION_HOST, DIRECT_HOST].includes(u.hostname)) {
        throw new Error('Running application may use the standby. Refusing restoration.');
      }
    }
  }
  return createHash('sha256').update(fs.readFileSync(`${ROOT}/shared/.env`)).digest('hex');
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node restore-standby.mjs /absolute/backup.dump [--replace-standby]');
    return;
  }
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--replace-standby') || !path.isAbsolute(args[0])) {
    throw new Error('Expected an absolute dump path and optional --replace-standby.');
  }
  const archive = fs.realpathSync(args[0]);
  if (!fs.statSync(archive).isFile()) throw new Error('Archive is not a file.');
  const sha256 = await hashFile(archive);
  // Host guard runs before any restore, grant, DROP or role change.
  const before = assertNeonIsStillProduction();
  fs.mkdirSync(LOCK, { mode: 0o700 });
  ownsLock = true;
  fs.writeFileSync(`${LOCK}/owner.json`, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const connections = JSON.parse(fs.readFileSync(`${STATE}/connections.json`, 'utf8'));
  const env = connectionEnv(connections.kedapp_migrator);
  const started = new Date().toISOString();
  const reportDir = path.join(STATE, `restore-${started.replaceAll(/[^0-9TZ]/g, '')}`);
  fs.mkdirSync(reportDir, { mode: 0o700 });
  run(`${BIN}/pg_restore`, ['--list', archive], { env, log: `${reportDir}/archive-list.stderr` });
  run(`${BIN}/pg_restore`, ['--file=/dev/null', archive], { env, log: `${reportDir}/archive-read.stderr` });
  const count = run(`${BIN}/psql`, ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c',
    "SELECT count(*) FROM pg_tables WHERE schemaname='public';"], { env });
  if (!/^\d+$/.test(count)) throw new Error('Cannot determine standby population.');
  if (Number(count) > 0) {
    if (!args.includes('--replace-standby')) throw new Error('Standby is populated. Explicit --replace-standby is required.');
    run(`${BIN}/pg_dump`, ['--format=custom', '--no-owner', '--no-privileges',
      `--file=${reportDir}/previous-standby.dump`], { env, log: `${reportDir}/previous-dump.stderr` });
    assertNeonIsStillProduction();
    admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid<>pg_backend_pid();
DROP DATABASE ${DB};
CREATE DATABASE ${DB} OWNER kedapp_migrator TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin LOCALE 'C.UTF-8';
ALTER DATABASE ${DB} SET default_transaction_read_only=on;
REVOKE ALL ON DATABASE ${DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${DB} TO kedapp_app,kedapp_preview;`);
  }
  // Seal the default before restoration. Only this migrator connection opts out.
  admin(`ALTER DATABASE ${DB} SET default_transaction_read_only=on;`);
  run(`${BIN}/pg_restore`, ['--no-owner', '--no-privileges', '--exit-on-error',
    '--single-transaction', '--dbname', DB, archive], { env, log: `${reportDir}/restore.stderr` });
  run(`${BIN}/psql`, ['-X', '-v', 'ON_ERROR_STOP=1', '-q'], { env, log: `${reportDir}/grants.stderr`, input: `
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kedapp_app,kedapp_preview;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO kedapp_app;
REVOKE INSERT,UPDATE,DELETE ON "_prisma_migrations" FROM kedapp_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO kedapp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kedapp_preview;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO kedapp_preview;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO kedapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO kedapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kedapp_preview;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO kedapp_preview;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ANALYZE;
COMMIT;
` });
  admin(`ALTER DATABASE ${DB} SET default_transaction_read_only=on;`);
  const proofEnv = { ...env, PGOPTIONS: '-c statement_timeout=10000' };
  const proof = JSON.parse(run(`${BIN}/psql`, ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `
SELECT json_build_object('readOnly',current_setting('default_transaction_read_only')='on',
 'databaseOwner',pg_get_userbyid(datdba)='kedapp_migrator',
 'localeMatchesSource',datlocprovider='b' AND datcollate='C.UTF-8' AND datctype='C.UTF-8',
 'schemaOwner',(SELECT pg_get_userbyid(nspowner) IN ('pg_database_owner','kedapp_migrator') FROM pg_namespace WHERE nspname='public'),
 'roleSafe',NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication FROM pg_roles WHERE rolname=current_user))
FROM pg_database WHERE datname=current_database();`], { env: proofEnv, log: `${reportDir}/identity.stderr` }));
  if (Object.values(proof).some(value => value !== true)) throw new Error('Restored database owner or read-only identity failed.');
  if (await hashFile(archive) !== sha256) throw new Error('Archive changed while restoring.');
  const after = assertNeonIsStillProduction();
  if (before !== after) throw new Error('Production configuration changed during restoration.');
  const report = { success: true, restoredAt: new Date().toISOString(), archive,
    sha256,
    database: DB, port: 5433, defaultReadOnly: true,
    productionEnvUnchanged: true, cutoverPerformed: false, reportDirectory: reportDir };
  fs.writeFileSync(`${reportDir}/result.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(`${STATE}/latest-restore.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (ownsLock) fs.rmSync(LOCK, { recursive: true }); }
}
