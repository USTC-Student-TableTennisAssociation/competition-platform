#!/usr/bin/env node
// Server-only operator: private plan + explicitly compiled, reviewed application code.
// Dry run is the default and rolls the whole SERIALIZABLE transaction back.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
const ROOT='/var/www/kedapp';
process.umask(0o077);
function options(args){
 const result={apply:false};
 for(let i=0;i<args.length;i++){
  const key=args[i];
  if(key==='--help'){console.log('node reseed-campus-knockout.mjs --compiled-root /private/compiled-src --plan /private/command.json --expected-revision <40hex> [--apply]');process.exit(0);}
  else if(key==='--apply')result.apply=true;
  else if(['--compiled-root','--plan','--expected-revision'].includes(key)&&args[i+1])result[key]=args[++i];
  else throw Error('Unexpected operator option');
 }
 if(!path.isAbsolute(result['--compiled-root']??'')||!path.isAbsolute(result['--plan']??'')||!/^[a-f0-9]{40}$/.test(result['--expected-revision']??''))throw Error('Explicit compiled source, private plan and production revision are required');
 return result;
}
const opts=options(process.argv.slice(2));
const require=createRequire(ROOT+'/current/package.json');
const {PrismaClient}=require('@prisma/client');
const {reseedCampusKnockoutInTransaction}=require(path.join(opts['--compiled-root'],'modules/competitions-v2/application/campus-knockout-reseeding.js'));
const {getV2GroupOnlyGroupingReadModelInTransaction,V2_SINGLE_GROUPING_READ_PROFILE}=require(path.join(opts['--compiled-root'],'modules/competitions-v2/read-model/group-only-grouping.js'));
const configuredText=fs.readFileSync(ROOT+'/shared/.env','utf8');
const configurationFingerprint=createHash('sha256').update(configuredText).digest('hex');
const configured=parseEnv(configuredText);
const url=new URL(configured.DATABASE_URL_UNPOOLED);
if(url.hostname!=='ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech'||url.pathname!=='/neondb')throw Error('Operator expects the original Neon production database');
const revision=fs.readFileSync(ROOT+'/current/REVISION','utf8').trim();
if(revision!==opts['--expected-revision'])throw Error('Production release changed or has not been deployed yet');
if(fs.readFileSync(path.join(opts['--compiled-root'],'REVISION'),'utf8').trim()!==revision)throw Error('Operator application code differs from the deployed revision');
async function assertRuntime(){
 if(fs.readFileSync(ROOT+'/current/REVISION','utf8').trim()!==revision||createHash('sha256').update(fs.readFileSync(ROOT+'/shared/.env','utf8')).digest('hex')!==configurationFingerprint)throw Error('Production configuration or release changed during the operation');
 const health=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(10000),cache:'no-store'});
 const running=await health.json();
 if(!health.ok||running.status!=='ok'||running.revision!==revision)throw Error('The running website has not activated the compatible release');
}
await assertRuntime();
const stat=fs.statSync(opts['--plan']);
if((stat.mode&0o077)!==0||!stat.isFile())throw Error('Plan must be a private regular file');
const plan=JSON.parse(fs.readFileSync(opts['--plan'],'utf8'));
const db=new PrismaClient({datasourceUrl:configured.DATABASE_URL_UNPOOLED,log:[]});
let result;
let committed=false;
let preparedToCommit=false;
const dryRunRollback=new Error('OPERATOR_DRY_RUN_ROLLBACK');
const receiptDir=ROOT+'/shared/backups/campus-reseed-'+(opts.apply?'apply':'dry-run')+'-'+Date.now();
fs.mkdirSync(receiptDir,{mode:0o700});
try{
 await db.$transaction(async tx=>{
  const actor=await tx.user.findUnique({where:{id:'cmmbn4b4k0000wlsahqgggalr'},select:{id:true,role:true,isBanned:true,emailVerifiedAt:true}});
  if(!actor||actor.role!=='admin'||actor.isBanned||!actor.emailVerifiedAt)throw Error('The authorizing administrator is not active');
  const before={
   schedule:await tx.matchKnockoutSchedule.findUnique({where:{matchId:plan.matchId}}),
   fixtures:await tx.matchFixture.findMany({where:{matchId:plan.matchId,stage:'KNOCKOUT'},orderBy:{id:'asc'},include:{lineupMembers:true,resultRevisions:true,administrativeResolution:true}}),
   dependencies:await tx.matchFixtureDependency.findMany({where:{matchId:plan.matchId},orderBy:{id:'asc'}}),
   snapshots:await tx.matchGroupQualificationSnapshot.findMany({where:{matchId:plan.matchId},include:{standings:true},orderBy:{id:'asc'}}),
  };
  fs.writeFileSync(receiptDir+'/before.json',JSON.stringify(before,null,2)+'\n',{mode:0o600,flag:'wx'});
  result=await reseedCampusKnockoutInTransaction(tx,{...plan,actor:{id:actor.id,role:actor.role}});
  const model=await getV2GroupOnlyGroupingReadModelInTransaction(tx,plan.matchId,V2_SINGLE_GROUPING_READ_PROFILE);
  if(model.kind!=='GROUP_THEN_KNOCKOUT_V2_MATCH'||!model.knockout)throw Error('Reseeded competition reader failed');
  fs.writeFileSync(receiptDir+'/validated-result.json',JSON.stringify({result,kind:model.kind,fixtureCount:model.knockout.fixtureCount},null,2)+'\n',{mode:0o600,flag:'wx'});
  await assertRuntime();
  if(!opts.apply)throw dryRunRollback;
  preparedToCommit=true;
 },{isolationLevel:'Serializable',maxWait:10000,timeout:60000});
 committed=true;
 const receipt={success:true,applied:true,revision,matchId:plan.matchId,oldFingerprint:result.oldLayoutFingerprint,newFingerprint:result.newLayoutFingerprint,protectedAuthorityUnchanged:result.protectedAuthorityBefore===result.protectedAuthorityAfter,receiptDirectory:receiptDir};
 fs.writeFileSync(receiptDir+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(receipt));
}catch(error){
 if(!opts.apply&&error===dryRunRollback){const receipt={success:true,applied:false,dryRunRolledBack:true,revision,matchId:plan.matchId,newFingerprint:result.newLayoutFingerprint,protectedAuthorityUnchanged:result.protectedAuthorityBefore===result.protectedAuthorityAfter,receiptDirectory:receiptDir};fs.writeFileSync(receiptDir+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));}
 else{fs.writeFileSync(receiptDir+'/failure.log',String(error?.stack??error)+'\n',{mode:0o600});console.error(JSON.stringify({success:false,applied:committed?true:(opts.apply&&preparedToCommit?'unknown':false),receiptDirectory:receiptDir,code:error?.code??'OPERATOR_FAILED'}));process.exitCode=1;}
}finally{await db.$disconnect();}
