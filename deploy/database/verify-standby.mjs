import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const HELP = `Usage:
  node verify-standby.mjs --connection-file /private/preview.url
    --prisma-root /var/www/kedapp/releases/RELEASE
    [--baseline /private/source-manifest.json] [--output-dir /private/new-directory]
    [--audit-module /private/audit-sql.mjs]
    [--pg-bin /usr/lib/postgresql/17/bin] [--dry-run]

The connection file must be an owned 0600 regular file containing one PostgreSQL URL.
Only 127.0.0.1:5433/kedapp_standby is accepted. Use a SELECT-only non-owner role.
Output files are private; console output contains aggregate counts and phases only.
--dry-run validates inputs and prints the plan without opening a database connection.
--help needs no files and opens no database connection.
Baseline schema: {tableCounts:{"public.User":503,...}, statistics:{...AUDIT_SQL result...},
  migrationFingerprint:"...", keySums:{...}}. Every supplied numeric/boolean audit
field is compared. Previous source {statistics:...} and restore {counts:...} summaries
are also accepted. Missing baseline fields are not silently claimed as verified.
No restore, migration, write probe, application startup, or remote operation is performed.
`;

function args() {
  const values = {};
  const flags = new Set(['--dry-run', '--prisma-worker']);
  const options = new Set(['--connection-file', '--prisma-root', '--baseline', '--output-dir', '--audit-module', '--pg-bin']);
  const input = process.argv.slice(2);
  if (input.includes('--help')) return { help: true };
  for (let index = 0; index < input.length; index++) {
    const key = input[index];
    if (flags.has(key)) values[key] = true;
    else if (options.has(key) && input[index + 1] && !input[index + 1].startsWith('--')) values[key] = input[++index];
    else throw new Error('Unrecognized or incomplete command option.');
  }
  if (!values['--connection-file'] || !values['--prisma-root']) throw new Error('Connection file and Prisma release root are required.');
  return values;
}

async function privateConnection(filePath) {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077)
    || metadata.uid !== process.getuid() || metadata.size > 8192) {
    throw new Error('Connection file must be an owned private regular file.');
  }
  const value = (await fs.readFile(filePath, 'utf8')).trim();
  if (/\s/.test(value)) throw new Error('Connection URL must contain no literal whitespace.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '5433' || url.pathname !== '/kedapp_standby' || !url.username || !url.password) {
    throw new Error('Unexpected standby database identity.');
  }
  const allowed = new Set(['schema', 'sslmode', 'connection_limit', 'connect_timeout', 'pool_timeout', 'application_name']);
  for (const [key, entry] of url.searchParams) {
    if (!allowed.has(key) || (key === 'schema' && entry !== 'public')) throw new Error('Unsupported connection option.');
  }
  return url;
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL)/i.test(key)));
}

const IDENTITY_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT jsonb_build_object(
 'readOnly',current_setting('transaction_read_only')='on',
 'server17',current_setting('server_version_num')::integer/10000=17,
 'correctDatabase',current_database()='kedapp_standby',
 'correctPort',inet_server_port()=5433,
 'loopback',inet_server_addr()='127.0.0.1'::inet,
 'roleSafe',NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user),
 'writableTables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'writableSequences',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')),
 'canCreateSchemaObjects',has_schema_privilege(current_user,'public','CREATE'),
 'canCreateDatabaseObjects',has_database_privilege(current_user,current_database(),'CREATE'),
 'callableSecurityDefiners',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE'))
); COMMIT;`;

const TABLES_SQL = String.raw`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s';
SELECT format('SELECT jsonb_build_object(''table'',%L,''rows'',count(*)) FROM %I.%I;', n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname
\gexec
COMMIT;`;

const EXTRA_SQL = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s';
SELECT jsonb_build_object(
 'migrationFingerprint',(SELECT md5(coalesce(string_agg(migration_name||':'||checksum||':'||(finished_at IS NOT NULL)::text||':'||(rolled_back_at IS NOT NULL)::text,',' ORDER BY migration_name),'')) FROM "_prisma_migrations"),
 'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated),
 'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid),
 'keySums',jsonb_build_object(
  'pointsLedgerAmount',(SELECT coalesce(sum(amount),0) FROM "PointsTransaction"),
  'eloHistoryDelta',(SELECT coalesce(sum(delta),0) FROM "EloHistory"),
  'settlementPointsDelta',(SELECT coalesce(sum(points_delta),0) FROM settlement_effect),
  'settlementEloDelta',(SELECT coalesce(sum(elo_delta),0) FROM settlement_effect),
  'settlementWinsDelta',(SELECT coalesce(sum(wins_delta),0) FROM settlement_effect),
  'settlementLossesDelta',(SELECT coalesce(sum(losses_delta),0) FROM settlement_effect),
  'settlementMatchesDelta',(SELECT coalesce(sum(matches_played_delta),0) FROM settlement_effect),
  'shopBalance',(SELECT coalesce(sum(balance),0) FROM supermarket_balance),
  'shopLedgerAmount',(SELECT coalesce(sum(amount),0) FROM supermarket_balance_entry)
 )
); COMMIT;`;

const LOAD_QUERY = `SELECT jsonb_build_object(
 'fixtures',(SELECT count(*) FROM match_fixture WHERE match_id='cmuxw9liu000swlp2m44ihhi3'),
 'lineups',(SELECT count(*) FROM match_fixture_lineup_member l JOIN match_fixture f ON f.id=l.fixture_id WHERE f.match_id='cmuxw9liu000swlp2m44ihhi3'),
 'results',(SELECT count(*) FROM result_revision WHERE match_id='cmuxw9liu000swlp2m44ihhi3'),
 'members',(SELECT count(*) FROM match_entry_member WHERE match_id='cmuxw9liu000swlp2m44ihhi3'),
 'points',(SELECT coalesce(sum(points),0) FROM "User")
);`;

function numbersAndBooleans(value, name = '') {
  if (typeof value === 'boolean' || Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected aggregate output.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error('Unexpected aggregate key.');
    return [key, numbersAndBooleans(item, `${name}.${key}`)];
  }));
}

function anonymizeAudit(raw) {
  if (raw.readOnly !== 'on' || raw.postgresMajorVersion !== 17) throw new Error('Audit read-only invariant failed.');
  return Object.fromEntries(['counts','men','women','userAggregates','supermarket','migrations'].map((key) => {
    const section = { ...raw[key] };
    if (key === 'migrations') delete section.latestSuccessfulName;
    return [key, numbersAndBooleans(section)];
  }));
}

async function prismaWorker(options) {
  const url = await privateConnection(options['--connection-file']);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('pool_timeout', '3');
  url.searchParams.set('sslmode', 'disable');
  const require = createRequire(path.join(await fs.realpath(options['--prisma-root']), 'package.json'));
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
  try {
    const summary = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
      const proof = await tx.$queryRawUnsafe("SELECT current_setting('transaction_read_only')='on' AS readonly");
      if (proof[0]?.readonly !== true) throw new Error('Prisma read-only proof failed.');
      const site = await tx.siteSetting.findUnique({ where: { id: 1 }, select: { isClosed: true } });
      const grouping = await tx.matchGrouping.findUnique({
        where: { matchId: 'cmuxw9liu000swlp2m44ihhi3' },
        select: { v2SchemaVersion: true, groups: { select: {
          position: true, entries: { select: { entry: { select: {
            status: true, members: { select: { status: true, rosterVersion: true } },
          } } } },
        } } },
      });
      const fixtures = await tx.matchFixture.findMany({
        where: { matchId: 'cmuxw9liu000swlp2m44ihhi3' },
        select: { stage: true, status: true, _count: { select: {
          lineupMembers: true, resultRevisions: true, incomingDependencies: true,
        } } },
      });
      const user = await tx.user.findFirst({ where: { isBanned: false }, select: {
        points: true, eloRating: true, wins: true, losses: true, matchesPlayed: true,
        _count: { select: { registrations: true, eloHistory: true, awardedBadges: true } },
      } });
      const usableLogins = await tx.user.count({ where: {
        isBanned: false, emailVerifiedAt: { not: null }, hashedPassword: { not: null },
      } });
      const wallets = await tx.supermarketBalance.aggregate({ _count: true, _sum: { balance: true } });
      return {
        siteSettingRows: site ? 1 : 0, groupingRows: grouping ? 1 : 0,
        groups: grouping?.groups.length ?? 0,
        groupMemberships: grouping?.groups.reduce((sum, group) => sum + group.entries.length, 0) ?? 0,
        rosterRows: grouping?.groups.reduce((sum, group) => sum + group.entries.reduce((total, row) => total + row.entry.members.length, 0), 0) ?? 0,
        fixtures: fixtures.length,
        lineupRows: fixtures.reduce((sum, fixture) => sum + fixture._count.lineupMembers, 0),
        revisionRows: fixtures.reduce((sum, fixture) => sum + fixture._count.resultRevisions, 0),
        dependencyRows: fixtures.reduce((sum, fixture) => sum + fixture._count.incomingDependencies, 0),
        profileQueryRows: user ? 1 : 0, usableLogins,
        wallets: wallets._count, walletBalance: wallets._sum.balance ?? 0,
      };
    }, { maxWait: 3_000, timeout: 20_000 });
    console.log(JSON.stringify(numbersAndBooleans(summary)));
  } finally {
    await client.$disconnect();
  }
}

async function main(options) {
  process.umask(0o077);
  const report = (object) => console.log(JSON.stringify(object));
  const url = await privateConnection(options['--connection-file']);
  const prismaRoot = await fs.realpath(options['--prisma-root']);
  const auditModule = await fs.realpath(options['--audit-module'] ?? path.join(path.dirname(SCRIPT), 'audit-sql.mjs'));
  const pgBin = await fs.realpath(options['--pg-bin'] ?? '/usr/lib/postgresql/17/bin');
  const plan = { maximumConnections: 6, loadQueries: 24, loadDeadlineSeconds: 22, prismaMaximumConnections: 1 };
  if (options['--dry-run']) {
    report({ stage: 'dry-run', success: true, ...plan, prismaRoot, auditModule, pgBin });
    return;
  }
  let directory;
  if (options['--output-dir']) {
    directory = path.resolve(options['--output-dir']);
    await fs.mkdir(directory, { mode: 0o700 }); // Must be a new directory.
  } else directory = await fs.mkdtemp('/tmp/tta-standby-verify-');
  await fs.chmod(directory, 0o700);
  let stage = 'setup';
  let success = false;
  let result;
  const env = cleanEnv();
  Object.assign(env, {
    PGHOST: '127.0.0.1', PGPORT: '5433', PGDATABASE: 'kedapp_standby',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'kedapp-standby-readonly-verifier',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000',
    PGPASSFILE: path.join(directory, 'no-passwords'),
    PGSERVICEFILE: path.join(directory, 'no-services'), PGSYSCONFDIR: directory,
  });
  await fs.writeFile(env.PGPASSFILE, '', { mode: 0o600, flag: 'wx' });
  await fs.writeFile(env.PGSERVICEFILE, '', { mode: 0o600, flag: 'wx' });
  const children = new Set();
  let interrupted = false;
  const onSignal = () => { interrupted = true; for (const child of children) child.kill('SIGTERM'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  async function command(label, executable, commandArgs, { input, timeout = 45_000 } = {}) {
    if (interrupted) throw new Error('Verification interrupted.');
    if (timeout <= 0 || timeout >= 120_000) throw new Error('Invalid command timeout.');
    const stdoutPath = path.join(directory, `${label}.stdout.log`);
    const stdout = await fs.open(stdoutPath, 'wx', 0o600);
    let stderr;
    try {
      stderr = await fs.open(path.join(directory, `${label}.stderr.log`), 'wx', 0o600);
      const outcome = await new Promise((resolve, reject) => {
        let child;
        try { child = spawn(executable, commandArgs, { env, shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', stdout.fd, stderr.fd] }); }
        catch (error) { reject(error); return; }
        children.add(child);
        let timedOut = false;
        let spawnError;
        let killTimer;
        const timer = setTimeout(() => {
          timedOut = true; child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        }, timeout);
        child.once('error', (error) => { spawnError = error; });
        child.once('close', (code, signal) => {
          clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
          resolve({ code, signal, timedOut, spawnError });
        });
        if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
      });
      if (outcome.spawnError) await stderr.write(`${outcome.spawnError.stack}\n`);
      if (outcome.code !== 0 || outcome.spawnError || outcome.timedOut || interrupted) throw new Error(`Private command failed: ${label}`);
      return await fs.readFile(stdoutPath, 'utf8');
    } finally { await stdout.close(); await stderr?.close(); }
  }
  const query = (label, sql, timeout) => command(label, path.join(pgBin, 'psql'), [
    '--no-psqlrc', '--no-password', '--quiet', '--tuples-only', '--no-align',
    '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate', '--dbname=kedapp_standby',
  ], { input: sql, timeout });
  try {
    stage = 'readonly-permissions';
    const identity = numbersAndBooleans(JSON.parse((await query('identity', IDENTITY_SQL, 12_000)).trim()));
    if (!identity.readOnly || !identity.server17 || !identity.correctDatabase || !identity.correctPort
      || !identity.loopback || !identity.roleSafe || identity.writableTables !== 0
      || identity.writableSequences !== 0 || identity.canCreateSchemaObjects
      || identity.canCreateDatabaseObjects || identity.callableSecurityDefiners !== 0) {
      throw new Error('Hard read-only role or standby identity verification failed.');
    }
    report({ stage, success: true });

    stage = 'all-table-counts';
    const tableCounts = {};
    for (const line of (await query('table-counts', TABLES_SQL)).trim().split('\n')) {
      const row = JSON.parse(line);
      if (!/^public\.[A-Za-z_][A-Za-z0-9_]*$/.test(row.table) || !Number.isSafeInteger(row.rows) || row.rows < 0
        || Object.hasOwn(tableCounts, row.table)) throw new Error('Invalid table count manifest.');
      tableCounts[row.table] = row.rows;
    }
    if (!Object.hasOwn(tableCounts, 'public.User') || !Object.hasOwn(tableCounts, 'public._prisma_migrations')) throw new Error('Core tables missing.');
    report({ stage, success: true, tables: Object.keys(tableCounts).length });

    stage = 'aggregates-and-migrations';
    const { AUDIT_SQL } = await import(pathToFileURL(auditModule).href);
    const statistics = anonymizeAudit(JSON.parse((await query('source-audit', AUDIT_SQL)).trim()));
    const extra = JSON.parse((await query('extra-audit', EXTRA_SQL)).trim());
    const keySums = numbersAndBooleans(extra.keySums);
    if (!/^[a-f0-9]{32}$/.test(extra.migrationFingerprint) || extra.unvalidatedConstraints !== 0
      || extra.invalidIndexes !== 0 || statistics.migrations.unfinishedCount !== 0) throw new Error('Schema integrity or migration state verification failed.');
    report({ stage, success: true, counts: statistics, keySums });

    stage = 'baseline-comparison';
    let comparedFields = 0;
    const mismatches = [];
    if (options['--baseline']) {
      const baseline = JSON.parse(await fs.readFile(options['--baseline'], 'utf8'));
      if (baseline.tableCounts) {
        const names = new Set([...Object.keys(baseline.tableCounts), ...Object.keys(tableCounts)]);
        for (const name of names) {
          comparedFields++;
          if (baseline.tableCounts[name] !== tableCounts[name]) mismatches.push({ field: 'table-count', table: /^public\.[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'unrecognized' });
        }
      }
      const original = baseline.statistics ?? (baseline.counts?.men ? baseline.counts : undefined);
      for (const [section, fields] of Object.entries(original ?? {})) {
        if (!Object.hasOwn(statistics, section) || !fields || typeof fields !== 'object') continue;
        for (const [key, value] of Object.entries(fields)) {
          if (!Object.hasOwn(statistics[section], key) || !['number','boolean'].includes(typeof value)) continue;
          comparedFields++;
          if (value !== statistics[section][key]) mismatches.push({ field: `${section}.${key}` });
        }
      }
      if (baseline.migrationFingerprint) {
        comparedFields++;
        if (baseline.migrationFingerprint !== extra.migrationFingerprint) mismatches.push({ field: 'migration-fingerprint' });
      }
      for (const [key, value] of Object.entries(baseline.keySums ?? {})) {
        if (!Object.hasOwn(keySums, key)) continue;
        comparedFields++;
        if (value !== keySums[key]) mismatches.push({ field: `keySums.${key}` });
      }
      if (comparedFields === 0) throw new Error('No comparable fields in baseline.');
    }
    await fs.writeFile(path.join(directory, 'baseline-comparison.json'), `${JSON.stringify({ comparedFields, mismatches }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (mismatches.length) throw new Error('Baseline comparison failed.');
    report({ stage, success: true, baselineSupplied: Boolean(options['--baseline']), comparedFields });
    await fs.writeFile(path.join(directory, 'standby-manifest.json'), `${JSON.stringify({
      tableCounts, statistics, keySums, migrationFingerprint: extra.migrationFingerprint,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

    stage = 'bounded-concurrent-reads';
    const started = Date.now();
    const loadSql = `BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='5s';\n${Array(4).fill(LOAD_QUERY).join('\n')}\nCOMMIT;`;
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, async (_, index) => {
      const output = await query(`load-${index + 1}`, loadSql, 20_000);
      const rows = output.trim().split('\n').map((line) => numbersAndBooleans(JSON.parse(line)));
      if (rows.length !== 4) throw new Error('Load query count mismatch.');
      return rows.length;
    }));
    if (outcomes.some((item) => item.status !== 'fulfilled')) throw new Error('Bounded concurrent read failed.');
    const load = { connections: 6, queries: 24, elapsedMilliseconds: Date.now() - started };
    if (load.elapsedMilliseconds > 22_000) throw new Error('Concurrent read deadline exceeded.');
    report({ stage, success: true, ...load });

    stage = 'prisma-readonly-smoke';
    const prisma = numbersAndBooleans(JSON.parse((await command('prisma', process.execPath, [
      SCRIPT, '--prisma-worker', '--connection-file', path.resolve(options['--connection-file']), '--prisma-root', prismaRoot,
    ], { timeout: 26_000 })).trim()));
    if (prisma.groups !== statistics.men.groups || prisma.groupMemberships !== statistics.men.groupMemberships
      || prisma.fixtures !== statistics.men.groupFixtures + statistics.men.knockoutFixtures
      || prisma.wallets !== statistics.supermarket.wallets || prisma.walletBalance !== keySums.shopBalance) {
      throw new Error('Prisma and SQL aggregate mismatch.');
    }
    report({ stage, success: true, counts: prisma });
    success = true;
    result = { success, tableCounts, statistics, keySums, migrationFingerprint: extra.migrationFingerprint,
      comparedFields, load, prisma, diagnosticsDirectory: directory };
    await fs.writeFile(path.join(directory, 'standby-verification.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await fs.writeFile(path.join(directory, 'failure.log'), `${error?.stack ?? String(error)}\n`, { mode: 0o600, flag: 'a' });
    report({ stage, success: false, diagnosticsDirectory: directory });
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    report({ stage: 'complete', success: success && !interrupted, diagnosticsDirectory: directory });
    if (!success || interrupted) process.exitCode = 1;
  }
}

try {
  const options = args();
  if (options.help) console.log(HELP);
  else if (options['--prisma-worker']) await prismaWorker(options);
  else await main(options);
} catch (error) {
  if (process.argv.includes('--prisma-worker')) console.error(error?.stack ?? String(error)); // Parent stores this only in its 0600 log.
  else console.error(JSON.stringify({ stage: 'setup', success: false }));
  process.exitCode = 1;
}
