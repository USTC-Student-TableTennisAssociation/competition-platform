#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv, isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createConnectionEnvironment } from './export-neon.mjs';

const BIN = '/usr/lib/postgresql/17/bin/psql';
export const AUDIT_SQL = String.raw`
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
SET LOCAL timezone='UTC';
SET LOCAL extra_float_digits=3;
SET LOCAL bytea_output='hex';
SET LOCAL search_path=pg_catalog,public;
SELECT jsonb_build_object('kind','catalog','tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),
 'sequences',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'),
 'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid),
 'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated),
 'definitionHash',(SELECT encode(sha256(convert_to(coalesce(string_agg(definition,E'\n' ORDER BY definition COLLATE "C"),''),'UTF8')),'hex') FROM (
   SELECT 'index:'||c.relname||':'||pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   UNION ALL SELECT 'constraint:'||c.relname||':'||con.conname||':'||pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   UNION ALL SELECT 'column:'||c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||a.attidentity||':'||a.attgenerated||':'||coalesce(coll.collname,'')
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
   UNION ALL SELECT 'enum:'||t.typname||':'||string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' GROUP BY t.typname
   UNION ALL SELECT 'sequence:'||c.relname||':'||format_type(s.seqtypid,NULL)||':'||s.seqstart::text||':'||s.seqincrement::text||':'||s.seqmin::text||':'||s.seqmax::text||':'||s.seqcache::text||':'||s.seqcycle::text
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 ) definitions));
SELECT format($query$
 SELECT jsonb_build_object('kind','table','name',%L,'rows',count(*)::text,
  'sha256',encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash COLLATE "C"),''),'UTF8')),'hex'))
 FROM (SELECT encode(sha256(convert_to(to_jsonb(row_value)::text,'UTF8')),'hex') AS row_hash FROM %I.%I AS row_value) hashes;
 $query$,n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname
\gexec
SELECT format($query$SELECT jsonb_build_object('kind','sequence','name',%L,'lastValue',last_value::text,'isCalled',is_called) FROM %I.%I;$query$,
 n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname
\gexec
COMMIT;
`;

export function parseAuditOutput(output) {
  const records = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const catalogs = records.filter(row => row.kind === 'catalog');
  if (catalogs.length !== 1) throw new Error('Audit catalog missing or duplicated.');
  const catalog = catalogs[0];
  if (!Number.isSafeInteger(catalog.tables) || catalog.tables < 1 ||
      !Number.isSafeInteger(catalog.sequences) || catalog.sequences < 0 ||
      catalog.invalidIndexes !== 0 || catalog.unvalidatedConstraints !== 0 ||
      !/^[a-f0-9]{64}$/.test(catalog.definitionHash)) throw new Error('Audit catalog integrity failed.');
  const tables = {}, sequences = {};
  for (const row of records) {
    if (row.kind === 'catalog') continue;
    if (typeof row.name !== 'string' || !row.name.startsWith('public.')) throw new Error('Unexpected audit relation.');
    if (row.kind === 'table') {
      if (tables[row.name] || !/^\d+$/.test(row.rows) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid table fingerprint.');
      tables[row.name] = { rows: row.rows, sha256: row.sha256 };
    } else if (row.kind === 'sequence') {
      if (sequences[row.name] || !/^-?\d+$/.test(row.lastValue) || typeof row.isCalled !== 'boolean') throw new Error('Invalid sequence fingerprint.');
      sequences[row.name] = { lastValue: row.lastValue, isCalled: row.isCalled };
    } else throw new Error('Unexpected audit record.');
  }
  if (Object.keys(tables).length !== catalog.tables || Object.keys(sequences).length !== catalog.sequences) throw new Error('Audit relation count mismatch.');
  const ordered = value => Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  return { catalog, tables: ordered(tables), sequences: ordered(sequences) };
}

export function compareAudits(source, target) {
  const differences = [];
  for (const section of ['catalog', 'tables', 'sequences']) {
    for (const key of new Set([...Object.keys(source[section]), ...Object.keys(target[section])])) {
      if (!isDeepStrictEqual(source[section][key], target[section][key])) differences.push(`${section}.${key}`);
    }
  }
  return { equal: differences.length === 0, differences };
}

function privateRead(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Input must be an owned private regular file.');
  return fs.readFileSync(file,'utf8');
}

export function localReadEnvironment(value, inherited = process.env) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Invalid local audit configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5433' ||
      url.pathname !== '/kedapp_standby' || url.username !== 'kedapp_preview' || !url.password || url.hash) throw new Error('Local audit requires the designated read-only role.');
  return { ...Object.fromEntries(Object.entries(inherited).filter(([k]) => !/^(PG|DATABASE_URL)/i.test(k))),
    PGHOST:'127.0.0.1',PGPORT:'5433',PGDATABASE:'kedapp_standby',PGUSER:'kedapp_preview',PGPASSWORD:decodeURIComponent(url.password),
    PGSSLMODE:'disable',PGAPPNAME:'kedapp-cutover-readonly-audit',PGCONNECT_TIMEOUT:'10',
    PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=60000' };
}

function query(env, directory, name) {
  const result = spawnSync(BIN, ['-X','-Atq','-v','ON_ERROR_STOP=1'], { input: AUDIT_SQL, env, encoding:'utf8', timeout:120000, maxBuffer:8*1024*1024 });
  fs.writeFileSync(path.join(directory,`${name}.stderr`),result.stderr ?? '',{mode:0o600,flag:'wx'});
  if (result.error || result.status !== 0) throw new Error('Read-only database fingerprint query failed.');
  return parseAuditOutput(result.stdout);
}

async function main() {
  process.umask(0o077);
  const values = {};
  const args=process.argv.slice(2);
  if(args.includes('--help')) { console.log('node cutover-audit.mjs --source-env /private/source.env --output-dir /private/new-directory [--target-connection-file /private/preview.url] [--baseline /private/source.json]'); return; }
  for(let i=0;i<args.length;i+=2) {
    if(!['--source-env','--output-dir','--target-connection-file','--baseline'].includes(args[i]) || !args[i+1] || values[args[i]]) throw new Error('Invalid audit arguments.');
    values[args[i]]=args[i+1];
  }
  if(!values['--source-env'] || !values['--output-dir'] || !path.isAbsolute(values['--output-dir'])) throw new Error('Explicit private source and new output directory required.');
  const sourceEnv=createConnectionEnvironment(parseEnv(privateRead(values['--source-env'])).DATABASE_URL_UNPOOLED);
  const targetEnv=values['--target-connection-file'] ? localReadEnvironment(privateRead(values['--target-connection-file'])) : null;
  const baseline=values['--baseline'] ? JSON.parse(privateRead(values['--baseline'])) : null;
  const directory=values['--output-dir'];
  fs.mkdirSync(directory,{mode:0o700});
  const source=query(sourceEnv,directory,'source');
  fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify(source,null,2)+'\n',{mode:0o600,flag:'wx'});
  const checks={};
  if(baseline) checks.sourceUnchanged=compareAudits(baseline,source);
  if(targetEnv) {
    const target=query(targetEnv,directory,'target');
    fs.writeFileSync(path.join(directory,'target.json'),JSON.stringify(target,null,2)+'\n',{mode:0o600,flag:'wx'});
    checks.targetMatchesSource=compareAudits(source,target);
  }
  const report={success:Object.values(checks).every(value=>value.equal),tableCount:source.catalog.tables,sequenceCount:source.catalog.sequences,checks};
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(report));
  if(!report.success) process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(()=>{console.error('Database fingerprint audit failed; inspect private diagnostics.');process.exitCode=1;});
