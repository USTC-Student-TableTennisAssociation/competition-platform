#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

// Run on the server. This command never restores data or changes the website target.
const ENV_FILE = '/var/www/kedapp/shared/.env';
const SOURCE_HOST = 'ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech';
const PG_BIN = '/usr/lib/postgresql/17/bin';
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 16 * 1024 * 1024;

class BackupError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export function parseBackupArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let outputDir;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (outputDir !== undefined) throw new BackupError('INVALID_ARGUMENTS');
    if (arg === '--output-dir') outputDir = args[++i];
    else if (arg.startsWith('--output-dir=')) outputDir = arg.slice('--output-dir='.length);
    else throw new BackupError('INVALID_ARGUMENTS');
    if (!outputDir || !path.isAbsolute(outputDir) || /[\x00-\x1f\x7f]/.test(outputDir)) {
      throw new BackupError('OUTPUT_DIRECTORY_MUST_BE_ABSOLUTE');
    }
  }
  if (!outputDir || path.resolve(outputDir) === path.parse(outputDir).root) {
    throw new BackupError('NEW_OUTPUT_DIRECTORY_REQUIRED');
  }
  return { outputDir: path.resolve(outputDir) };
}

export function createConnectionEnvironment(databaseUrl, inherited = process.env) {
  let source;
  try { source = new URL(databaseUrl); } catch { throw new BackupError('INVALID_SOURCE_CONFIGURATION'); }
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || source.hostname !== SOURCE_HOST ||
      (source.port && source.port !== '5432') || source.pathname !== '/neondb' ||
      !source.username || !source.password || source.hash) {
    throw new BackupError('SOURCE_MUST_BE_ORIGINAL_PRODUCTION_DIRECT_DATABASE');
  }
  let user, password;
  try {
    user = decodeURIComponent(source.username);
    password = decodeURIComponent(source.password);
  } catch { throw new BackupError('INVALID_SOURCE_CONFIGURATION'); }
  if (!user || !password || user.includes('\0') || password.includes('\0')) {
    throw new BackupError('INVALID_SOURCE_CONFIGURATION');
  }
  const clean = Object.fromEntries(Object.entries(inherited)
    .filter(([key]) => !key.startsWith('PG') && !key.startsWith('DATABASE_URL')));
  return {
    ...clean,
    PGHOST: SOURCE_HOST, PGPORT: '5432', PGDATABASE: 'neondb', PGUSER: user, PGPASSWORD: password,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system', PGSSLSNI: '1', PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'kedapp-controlled-readonly-backup',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000',
  };
}

function matchSummarySql(matchId) {
  // Only aggregate values leave PostgreSQL; no names, user IDs or result payloads.
  return `jsonb_build_object(
    'groups', (SELECT count(*)::text FROM public.match_group WHERE match_id='${matchId}'),
    'memberships', (SELECT count(*)::text FROM public.match_group_entry WHERE match_id='${matchId}'),
    'entries', (SELECT count(*)::text FROM public.match_entry WHERE match_id='${matchId}'),
    'entryMembers', (SELECT count(*)::text FROM public.match_entry_member WHERE match_id='${matchId}'),
    'groupFixtures', (SELECT count(*)::text FROM public.match_fixture WHERE match_id='${matchId}' AND stage='GROUP'),
    'knockoutFixtures', (SELECT count(*)::text FROM public.match_fixture WHERE match_id='${matchId}' AND stage='KNOCKOUT'),
    'resultRevisions', (SELECT count(*)::text FROM public.result_revision WHERE match_id='${matchId}'),
    'confirmedResultRevisions', (SELECT count(*)::text FROM public.result_revision WHERE match_id='${matchId}' AND status='CONFIRMED'),
    'settlements', (SELECT count(*)::text FROM public.settlement_event s WHERE
      EXISTS (SELECT 1 FROM public.match_entry e WHERE e.id=s.match_entry_id AND e.match_id='${matchId}') OR
      EXISTS (SELECT 1 FROM public.result_revision r WHERE r.id=s.result_revision_id AND r.match_id='${matchId}'))
  )`;
}

// The open transaction is deliberately kept alive after the final SELECT until pg_dump exits.
// Exported snapshots cover table data. Sequence state is nontransactional in PostgreSQL.
export const SNAPSHOT_SQL = String.raw`
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '11min';
SET LOCAL row_security = off;
SET LOCAL search_path = pg_catalog, public;
SELECT jsonb_build_object(
  'kind', 'snapshot', 'snapshot', pg_export_snapshot(), 'capturedAt', transaction_timestamp(),
  'serverVersionNum', current_setting('server_version_num')::int,
  'readOnly', current_setting('transaction_read_only'), 'inRecovery', pg_is_in_recovery(),
  'database', current_database(),
  'databaseLocale', (SELECT jsonb_build_object('encoding',pg_encoding_to_char(encoding),
    'collation',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale)
    FROM pg_database WHERE datname=current_database()),
  'foreignPublicTables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='f')
);
SELECT format(
  $count$SELECT jsonb_build_object('kind','tableCount','schema','public','table',%L,
    'count',count(*)::text,'relkind',%L,'persistence',%L) FROM %I.%I;$count$,
  c.relname,c.relkind,c.relpersistence,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname
\gexec
SELECT jsonb_build_object('kind','summary','value',jsonb_build_object(
  'users', (SELECT jsonb_build_object('count',count(*)::text,
    'pointsTotal',coalesce(sum(points),0)::text,'eloRatingTotal',coalesce(sum("eloRating"),0)::text,
    'winsTotal',coalesce(sum(wins),0)::text,'lossesTotal',coalesce(sum(losses),0)::text,
    'matchesPlayedTotal',coalesce(sum("matchesPlayed"),0)::text) FROM public."User"),
  'men', ${matchSummarySql('cmuxw9liu000swlp2m44ihhi3')},
  'women', ${matchSummarySql('cmuxwaor20016wlp2swtr3pes')},
  'supermarket', jsonb_build_object(
    'periods',(SELECT count(*)::text FROM public.supermarket_period),
    'prizes',(SELECT count(*)::text FROM public.supermarket_prize),
    'wallets',(SELECT count(*)::text FROM public.supermarket_balance),
    'walletPointsTotal',(SELECT coalesce(sum(balance),0)::text FROM public.supermarket_balance),
    'walletLedgerEntries',(SELECT count(*)::text FROM public.supermarket_balance_entry),
    'walletLedgerAmountTotal',(SELECT coalesce(sum(amount),0)::text FROM public.supermarket_balance_entry),
    'redemptions',(SELECT count(*)::text FROM public.supermarket_redemption),
    'pointsSpentTotal',(SELECT coalesce(sum(points_spent),0)::text FROM public.supermarket_redemption),
    'pendingRedemptions',(SELECT count(*)::text FROM public.supermarket_redemption WHERE status='PENDING'),
    'settlements',(SELECT count(*)::text FROM public.supermarket_settlement)
  )
));
SELECT jsonb_build_object('kind','migrations','value',jsonb_build_object(
  'successfulNames',coalesce((SELECT jsonb_agg(migration_name ORDER BY migration_name)
    FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'[]'::jsonb),
  'latestSuccessfulName',(SELECT migration_name FROM public._prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC,migration_name DESC LIMIT 1),
  'unfinishedNames',coalesce((SELECT jsonb_agg(migration_name ORDER BY migration_name)
    FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),'[]'::jsonb),
  'rolledBackNames',coalesce((SELECT jsonb_agg(migration_name ORDER BY migration_name)
    FROM public._prisma_migrations WHERE rolled_back_at IS NOT NULL),'[]'::jsonb)
));
SELECT jsonb_build_object('kind','ready','publicTableCount',
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')));
`;

function safeProcessResult(result) {
  const details = { exitCode: result.code, signal: result.signal };
  const sqlState = result.stderr.match(/(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b/)?.[1];
  if (sqlState) details.sqlState = sqlState;
  return details;
}

function startTool(context, tool, args, { input, capture = true } = {}) {
  if (context.abort.signal.aborted) throw new BackupError('BACKUP_ABORTED');
  const child = spawn(path.join(PG_BIN, tool), args, {
    env: context.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  context.children.add(child);
  let stdout = '', stderr = '', spawnError = false, exceeded = false;
  child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.toString().slice(0, 16384 - stderr.length); });
  if (capture) child.stdout.on('data', chunk => {
    if (stdout.length + chunk.length > MAX_OUTPUT) {
      exceeded = true;
      child.kill('SIGTERM');
    } else stdout += chunk.toString();
  });
  // A closed holder/dump may race a rollback or stdin write. Completion handles failure.
  child.stdin.on('error', () => {});
  const completion = new Promise(resolve => {
    child.once('error', () => { spawnError = true; });
    child.once('close', (code, signal) => {
      context.children.delete(child);
      resolve({ code, signal, stdout, stderr, spawnError, exceeded });
    });
  });
  if (input !== undefined) child.stdin.end(input);
  return { child, completion };
}

async function runTool(context, tool, args) {
  const result = await startTool(context, tool, args, { input: '' }).completion;
  if (context.abort.signal.aborted) throw new BackupError('BACKUP_ABORTED');
  if (result.spawnError || result.exceeded || result.code !== 0) {
    throw new BackupError(`${tool.toUpperCase()}_FAILED`, safeProcessResult(result));
  }
  return result.stdout;
}

function openSnapshot(context) {
  const task = startTool(context, 'psql', ['--no-psqlrc', '--no-password', '--quiet', '--tuples-only',
    '--no-align', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate'], { capture: false });
  const state = { tableCounts: [], snapshot: null, summary: null, migrations: null };
  let released = false, readySettled = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lines = createInterface({ input: task.child.stdout });
  lines.on('line', line => {
    try {
      if (!line.trim()) return;
      const record = JSON.parse(line);
      if (record.kind === 'snapshot' && !state.snapshot) {
        if (!/^[0-9A-Fa-f-]{1,200}$/.test(record.snapshot) || record.readOnly !== 'on' ||
            record.inRecovery !== false || record.database !== 'neondb' ||
            Math.floor(record.serverVersionNum / 10000) !== 17 || record.foreignPublicTables !== 0) {
          throw new BackupError('UNSUPPORTED_SOURCE_SNAPSHOT');
        }
        state.snapshot = record;
      } else if (record.kind === 'tableCount' && !readySettled) {
        if (record.schema !== 'public' || typeof record.table !== 'string' ||
            !/^\d+$/.test(record.count) || state.tableCounts.some(row => row.table === record.table)) {
          throw new BackupError('INVALID_TABLE_COUNTS');
        }
        state.tableCounts.push(record);
      } else if (record.kind === 'summary' && !state.summary) state.summary = record.value;
      else if (record.kind === 'migrations' && !state.migrations) state.migrations = record.value;
      else if (record.kind === 'ready' && !readySettled && state.snapshot && state.summary && state.migrations &&
          record.publicTableCount > 0 && record.publicTableCount === state.tableCounts.length) {
        readySettled = true;
        resolveReady(state);
      } else throw new BackupError('INVALID_SNAPSHOT_MANIFEST');
    } catch {
      if (!readySettled) { readySettled = true; rejectReady(new BackupError('SNAPSHOT_MANIFEST_FAILED')); }
      context.abort.abort();
    }
  });
  task.completion.then(result => {
    if (!released) {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new BackupError('SOURCE_SNAPSHOT_FAILED', safeProcessResult(result)));
      }
      context.abort.abort();
    }
  });
  task.child.stdin.write(SNAPSHOT_SQL);
  return {
    ready,
    async release() {
      released = true;
      if (!task.child.stdin.destroyed) task.child.stdin.end('\nROLLBACK;\n');
      const timer = setTimeout(() => task.child.kill('SIGTERM'), 3000);
      const force = setTimeout(() => task.child.kill('SIGKILL'), 4500);
      const result = await task.completion;
      clearTimeout(timer);
      clearTimeout(force);
      lines.close();
      if (result.code !== 0 && !context.abort.signal.aborted) {
        throw new BackupError('SNAPSHOT_RELEASE_FAILED', safeProcessResult(result));
      }
    },
  };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseBackupArgs(args);
  if (options.help) {
    console.log('node export-neon.mjs --output-dir /absolute/path/to/NEW-private-directory');
    return;
  }
  process.umask(0o077);
  const configured = parseEnv(await readFile(ENV_FILE, 'utf8'));
  const context = { env: createConnectionEnvironment(configured.DATABASE_URL_UNPOOLED),
    children: new Set(), abort: new AbortController() };
  const interrupt = () => context.abort.abort();
  const forceTimers = new Set();
  context.abort.signal.addEventListener('abort', () => {
    for (const child of context.children) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { child.kill('SIGKILL'); forceTimers.delete(timer); }, 1500);
      forceTimers.add(timer);
    }
  }, { once: true });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  const partial = path.join(options.outputDir, 'database.dump.partial');
  const archive = path.join(options.outputDir, 'database.dump');
  const manifestFile = path.join(options.outputDir, 'manifest.json');
  let directoryCreated = false, holder, source, dumpCompleted = false;
  try {
    for (const tool of ['psql', 'pg_dump', 'pg_restore']) {
      const version = (await runTool(context, tool, ['--version'])).trim();
      if (!new RegExp(`^${tool} \\(PostgreSQL\\) 17(?:\\.|\\s|$)`).test(version)) {
        throw new BackupError('POSTGRESQL_17_TOOLS_REQUIRED');
      }
    }
    // No recursive mkdir: the parent must exist; an existing target always fails.
    try { await mkdir(options.outputDir, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') throw new BackupError('OUTPUT_DIRECTORY_ALREADY_EXISTS');
      throw new BackupError('CANNOT_CREATE_PRIVATE_OUTPUT_DIRECTORY');
    }
    directoryCreated = true;
    await chmod(options.outputDir, 0o700);
    const handle = await open(partial, 'wx', 0o600);
    await handle.close();
    holder = openSnapshot(context);
    source = await holder.ready;
    console.log(JSON.stringify({ phase: 'snapshot-ready', publicTableCount: source.tableCounts.length }));
    try {
      await runTool(context, 'pg_dump', ['--format=custom', '--no-password', '--lock-wait-timeout=15000',
        `--snapshot=${source.snapshot.snapshot}`, `--file=${partial}`]);
      dumpCompleted = true;
    } finally {
      await holder.release();
      holder = undefined;
    }
    const toc = await runTool(context, 'pg_restore', ['--list', partial]);
    const archiveEntries = toc.split('\n').filter(line => line.trim() && !line.startsWith(';')).length;
    if (!archiveEntries) throw new BackupError('EMPTY_ARCHIVE');
    await runTool(context, 'pg_restore', ['--file=/dev/null', partial]);
    const digest = await sha256(partial);
    const bytes = (await stat(partial)).size;
    if (!bytes || context.abort.signal.aborted) throw new BackupError('BACKUP_ABORTED');
    await chmod(partial, 0o600);
    const durableArchive = await open(partial, 'r');
    try { await durableArchive.sync(); } finally { await durableArchive.close(); }
    const manifest = {
      schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
      source: { host: SOURCE_HOST, database: 'neondb', tlsMode: 'verify-full', tlsRoot: 'system',
        ...source.snapshot, kind: undefined },
      tableCounts: source.tableCounts.map(row => ({ schema: row.schema, table: row.table,
        count: row.count, relkind: row.relkind, persistence: row.persistence })),
      summary: source.summary, migrations: source.migrations,
      archive: { file: 'database.dump', format: 'custom', bytes, sha256: digest, postgresToolsMajor: 17 },
      validation: { archiveEntries, archiveListed: true, completeArchiveRead: true, restoreTested: false,
        countsShareDumpSnapshot: true, sequenceStateIsNontransactional: true },
    };
    // link() has exclusive destination semantics. Never overwrite a completed dump.
    await link(partial, archive);
    await unlink(partial);
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ success: true, archive, manifest: manifestFile, bytes, sha256: digest,
      publicTableCount: source.tableCounts.length, archiveEntries, restoreTested: false }));
  } catch (error) {
    if (directoryCreated) {
      await unlink(partial).catch(() => {});
      // Safe classifications only: never persist child stderr, URLs or business rows.
      const failure = { success: false, failedAt: new Date().toISOString(), dumpCompleted,
        code: error instanceof BackupError ? error.code : 'LOCAL_BACKUP_OPERATION_FAILED',
        details: error instanceof BackupError ? error.details : {} };
      await writeFile(path.join(options.outputDir, 'failure.json'), JSON.stringify(failure, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }).catch(() => {});
    }
    throw error;
  } finally {
    if (holder) await holder.release().catch(() => {});
    context.abort.abort();
    clearTimeout(deadline);
    for (const timer of forceTimers) clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ success: false,
      code: error instanceof BackupError ? error.code : 'LOCAL_BACKUP_OPERATION_FAILED',
      details: error instanceof BackupError ? error.details : {} }));
    process.exitCode = 1;
  });
}
