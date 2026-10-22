import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditOutput, compareAudits, localReadEnvironment, AUDIT_SQL, REASON_CHECK_CANONICALIZATION, CONSTRAINT_FINGERPRINT_SQL } from './cutover-audit.mjs';
const catalog={kind:'catalog',tables:1,sequences:1,invalidIndexes:0,unvalidatedConstraints:0,definitionHash:'a'.repeat(64)};
const table={kind:'table',name:'public.Example',rows:'3',sha256:'b'.repeat(64)};
const sequence={kind:'sequence',name:'public.example_id_seq',lastValue:'10',isCalled:true};
const parse=(records=[catalog,table,sequence])=>parseAuditOutput(records.map(v=>JSON.stringify(v)).join('\n'));
test('compares contents as well as counts and sequence call state',()=>{
  const source=parse(); const target=parse([sequence,table,catalog]);
  assert.equal(compareAudits(source,target).equal,true);
  target.tables['public.Example'].sha256='c'.repeat(64);
  target.sequences['public.example_id_seq'].isCalled=false;
  assert.deepEqual(compareAudits(source,target).differences,['tables.public.Example','sequences.public.example_id_seq']);
});
test('an empty, partial, duplicate or invalid catalog cannot claim equality',()=>{
  for(const rows of [[],[table,sequence],[catalog,table],[catalog,table,table,sequence],[{...catalog,invalidIndexes:1},table,sequence]]) assert.throws(()=>parse(rows));
});
test('local audit rejects other targets and removes inherited libpq overrides',()=>{
  const url='postgresql://kedapp_preview:synthetic@127.0.0.1:5433/kedapp_standby';
  for(const bad of [url.replace('preview','app'),url.replace('5433','5432'),url.replace('127.0.0.1','remote.invalid'),url.replace('kedapp_standby','postgres')]) assert.throws(()=>localReadEnvironment(bad));
  const env=localReadEnvironment(url,{PGHOSTADDR:'remote.invalid',PGSERVICE:'other',DATABASE_URL:'private',PATH:'/bin'});
  assert.equal(env.PGHOSTADDR,undefined);assert.equal(env.PGSERVICE,undefined);assert.equal(env.DATABASE_URL,undefined);
  assert.equal(env.PGHOST,'127.0.0.1');assert.match(env.PGOPTIONS,/default_transaction_read_only=on/);
});
test('fingerprints use a read-only snapshot and stable textual representations',()=>{
  assert.match(AUDIT_SQL,/REPEATABLE READ READ ONLY/);assert.match(AUDIT_SQL,/timezone='UTC'/);
  assert.match(AUDIT_SQL,/ORDER BY row_hash COLLATE "C"/);assert.match(AUDIT_SQL,/last_value::text/);
});

const integrationUrl=process.env.V2_CORE_INTEGRATION_DATABASE_URL;
test('catalog fingerprint SQL executes with PostgreSQL internal character columns', {skip:!integrationUrl}, async()=>{
  const url=new URL(integrationUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'audit regression requires loopback');
  assert.ok(['/ustctta_ci','/ustctta_v2_test'].includes(url.pathname),'audit regression requires the isolated test database');
  const {PrismaClient}=await import('@prisma/client');
  const db=new PrismaClient({datasourceUrl:integrationUrl});
  try {
    // Execute the actual catalog statement: pg_attribute.attidentity and
    // attgenerated are PostgreSQL internal "char", not SQL character/text.
    const query=AUDIT_SQL.slice(
      AUDIT_SQL.indexOf("SELECT jsonb_build_object('kind','catalog'"),
      AUDIT_SQL.indexOf('SELECT format($query$'),
    );
    const rows=await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe(query);
    });
    assert.equal(rows.length,1);
    const result=rows[0].jsonb_build_object;
    assert.equal(result.kind,'catalog');
    assert.ok(result.tables>0);
    assert.match(result.definitionHash,/^[a-f0-9]{64}$/);
  } finally {await db.$disconnect();}
});

test('only the exact observed public CHECK gets its equivalent AND grouping canonicalized', {skip:!integrationUrl}, async()=>{
  const url=new URL(integrationUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'CHECK regression requires loopback');
  assert.ok(['/ustctta_ci','/ustctta_v2_test'].includes(url.pathname),'CHECK regression requires the isolated test database');
  const {PrismaClient}=await import('@prisma/client');
  const db=new PrismaClient({datasourceUrl:integrationUrl});
  const rule=REASON_CHECK_CANONICALIZATION;
  const base=[rule.schema,rule.table,rule.constraint,rule.source];
  const cases=[
    {input:base,expected:rule.canonical},
    {input:[...base.slice(0,3),rule.canonical],expected:rule.canonical},
    {input:['archive',...base.slice(1)],expected:rule.source},
    {input:[base[0],'different_table',...base.slice(2)],expected:rule.source},
    {input:[...base.slice(0,2),'different_constraint',rule.source],expected:rule.source},
    {input:[...base.slice(0,3),rule.source.replace('<= 500','<= 501')],expected:rule.source.replace('<= 500','<= 501')},
    {input:[...base.slice(0,3),rule.source.replace('AND (reason =','OR (reason =')],expected:rule.source.replace('AND (reason =','OR (reason =')},
    {input:[...base.slice(0,3),rule.source+' NOT VALID'],expected:rule.source+' NOT VALID'},
  ];
  const parameters=[];
  const values=cases.map((item,index)=>{
    const offset=parameters.length;
    parameters.push(index,...item.input);
    return `($${offset+1}::int,$${offset+2}::text,$${offset+3}::text,$${offset+4}::text,$${offset+5}::text)`;
  }).join(',');
  try {
    const rows=await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe(`SELECT position,(${CONSTRAINT_FINGERPRINT_SQL}) AS canonical
        FROM (VALUES ${values}) AS fixtures(position,schema_name,relation_name,constraint_name,definition)
        ORDER BY position`,...parameters);
    });
    assert.deepEqual(rows.map(row=>row.canonical),cases.map(item=>item.expected));
  } finally {await db.$disconnect();}
});
