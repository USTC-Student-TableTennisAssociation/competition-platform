import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import { buildSingleEliminationSeedPositions } from "../domain/knockout-bracket";
import { createV2SingleGroupingApplicationService } from "./grouping";
import { createV2ProgressiveKnockoutActionHandlers } from "../adapters/progressive-knockout-actions";

test("early slots preserve the final bracket seeding for 2 to 1024 qualifiers",()=>{
  for (const count of [1,2,4,8,16,32,64,128,256]) for (const perGroup of [1,2,4]) {
    const total=count*perGroup;
    if(total<2||total>1024)continue;
    const groups=Array.from({length:count},(_,i)=>({id:`g${i+1}`,groupKey:`group:${String(i+1).padStart(4,"0")}`,position:i+1}));
    const plan=buildV2ProgressiveKnockoutPlan({groupingId:"published",groups,qualifiersPerGroup:perGroup});
    assert.deepEqual(plan.fixtures.filter(f=>f.roundNumber===1).flatMap(f=>[f.sideA,f.sideB]).map(source=>{
      assert.equal(source.kind,"GROUP_RANK");
      if(source.kind!=="GROUP_RANK")assert.fail();
      assert.equal(source.qualificationOrder,(source.rank-1)*count+groups.find(g=>g.id===source.groupId)!.position);
      return source.qualificationOrder;
    }),buildSingleEliminationSeedPositions(total));
    assert.equal(plan.fixtureCount,total-1);
    assert.equal(plan.layoutFingerprint,buildV2ProgressiveKnockoutPlan({groupingId:"published",groups:[...groups].reverse(),qualifiersPerGroup:perGroup}).layoutFingerprint);
  }
  assert.throws(()=>buildV2ProgressiveKnockoutPlan({groupingId:"g",groups:[{id:"a",groupKey:"group:0001",position:1},{id:"b",groupKey:"group:0003",position:3}],qualifiersPerGroup:1}));
});

test("progressive web actions enforce CSRF, exact fields and server-owned actor",async()=>{
  const calls:unknown[]=[];
  const handlers=createV2ProgressiveKnockoutActionHandlers({
    db:{} as PrismaClient,getCurrentUser:async()=>({id:"owner",role:"user"}),validateCsrfToken:async f=>f.get("csrfToken")==="valid"?null:"CSRF rejected",
    publicationService:{publish:async command=>{calls.push(command);return{created:true};}},
    qualificationService:{freezeGroup:async command=>{calls.push(command);return{created:true};}},
  });
  const form=(fields:Record<string,string>={})=>{const f=new FormData();for(const[k,v]of Object.entries({csrfToken:"valid",matchId:"match",...fields}))f.set(k,v);return f;};
  assert((await handlers.publish(form({csrfToken:"invalid"}))).error);
  assert((await handlers.publish(form({actorId:"admin"}))).error);
  const duplicate=form();duplicate.append("matchId","another");assert((await handlers.publish(duplicate)).error);
  assert((await handlers.freezeGroup(form())).error);
  assert.equal(calls.length,0);
  assert((await handlers.publish(form())).success);
  assert((await handlers.freezeGroup(form({groupId:"group"}))).success);
  assert.deepEqual(calls,[{actor:{id:"owner",role:"user"},matchId:"match"},{actor:{id:"owner",role:"user"},matchId:"match",groupId:"group"}]);
});

test("real publication rolls back both phases on early bracket failure, then publishes atomically",{skip:!process.env.V2_CORE_INTEGRATION_DATABASE_URL},async()=>{
  const db=new PrismaClient({datasourceUrl:process.env.V2_CORE_INTEGRATION_DATABASE_URL});
  const suffix=randomUUID();const matchId=`early-atomic-${suffix}`;const owner=`early-owner-${suffix}`;
  const players=Array.from({length:4},(_,i)=>`early-player-${i}-${suffix}`);const users=[owner,...players];
  const entries=players.map((_,i)=>`early-entry-${i}-${suffix}`);
  const foreignMatch=`early-foreign-${suffix}`;
  try{
    await db.user.createMany({data:users.map((id,i)=>({id,email:`${id}@example.test`,nickname:`Early ${i}`,emailVerifiedAt:new Date()}))});
    await db.match.create({data:{id:matchId,title:"Atomic early schedule",createdBy:owner,type:"single",engineVersion:"V2",format:"group_then_knockout",dateTime:new Date(),registrationDeadline:new Date(Date.now()-1000),maxParticipants:4}});
    for(const[i,id]of entries.entries())await db.matchEntry.create({data:{id,matchId,kind:"INDIVIDUAL",status:"ACTIVE",sourceKey:`individual:${players[i]}`,sourceUserId:players[i],displayNameSnapshot:`Early ${i+1}`,members:{create:{userId:players[i],displayNameSnapshot:`Early ${i+1}`,slot:1}}}});
    const command={actor:{id:owner,role:"user" as const},matchId,expectedEntries:entries.map(entryId=>({entryId,version:0})),draft:{format:"group_then_knockout" as const,qualifiersPerGroup:1,groups:[{entryIds:entries.slice(0,2)},{entryIds:entries.slice(2)}]}};
    const groupingTime = new Date(Date.now() + 60_000);
    let clockCalls = 0;
    await assert.rejects(
      createV2SingleGroupingApplicationService({
        db,
        publishKnockoutEarly: true,
        clock: () => new Date(groupingTime.getTime() - clockCalls++),
      }).publish(command),
      /publication time cannot precede its grouping/,
    );
    assert.equal(await db.matchGrouping.count({ where: { matchId } }), 0);
    assert.equal(await db.matchFixture.count({ where: { matchId } }), 0);
    assert.equal(await db.matchKnockoutSchedule.count({ where: { matchId } }), 0);
    assert.equal((await db.match.findUniqueOrThrow({ where: { id: matchId } })).status, "registration");
    const broken=db.$extends({query:{matchKnockoutSchedule:{async create(){throw new Error("early publication injected failure");}}}});
    await assert.rejects(createV2SingleGroupingApplicationService({db:broken as unknown as Pick<PrismaClient,"$transaction">,publishKnockoutEarly:true}).publish(command),/injected failure/);
    assert.equal(await db.matchGrouping.count({where:{matchId}}),0);assert.equal(await db.matchFixture.count({where:{matchId}}),0);
    assert.equal((await db.match.findUniqueOrThrow({where:{id:matchId}})).status,"registration");
    const result=await createV2SingleGroupingApplicationService({db,publishKnockoutEarly:true}).publish(command);
    assert.equal(result.created,true);assert.equal(await db.matchKnockoutSchedule.count({where:{matchId}}),1);
    assert.equal(await db.matchFixture.count({where:{matchId,stage:"KNOCKOUT",status:"SCHEDULED",sideAEntryId:null,sideBEntryId:null}}),1);
    const publicationState = () => Promise.all([
      db.matchFixture.findMany({ where: { matchId }, orderBy: { id: "asc" } }),
      db.matchFixtureDependency.findMany({ where: { matchId }, orderBy: { id: "asc" } }),
      db.matchKnockoutSchedule.findUniqueOrThrow({ where: { matchId } }),
      db.auditLog.findMany({ where: { entityId: matchId }, orderBy: { id: "asc" } }),
    ]);
    const beforeRetry = await publicationState();
    const retry = await createV2SingleGroupingApplicationService({ db, publishKnockoutEarly: true }).publish(command);
    assert.equal(retry.created, false);
    assert.equal(retry.publishedAt.getTime(), result.publishedAt.getTime());
    assert.deepEqual(await publicationState(), beforeRetry);
    await assert.rejects(
      createV2SingleGroupingApplicationService({ db }).publish(command),
      /different or incomplete grouping publication/,
    );
    const knockout = beforeRetry[0].find(fixture => fixture.stage === "KNOCKOUT")!;
    await db.matchFixture.update({ where: { id: knockout.id }, data: {
      metadata: { ...(knockout.metadata as Prisma.JsonObject), layoutFingerprint: "f".repeat(64) },
    } });
    try {
      await assert.rejects(
        createV2SingleGroupingApplicationService({ db, publishKnockoutEarly: true }).publish(command),
        /progressive knockout graph is malformed/,
      );
    } finally {
      await db.matchFixture.update({ where: { id: knockout.id }, data: {
        metadata: knockout.metadata as Prisma.InputJsonObject,
        updatedAt: knockout.updatedAt,
      } });
    }
    assert.deepEqual(await publicationState(), beforeRetry);
    const dependency=await db.matchFixtureDependency.findFirstOrThrow({where:{matchId}});
    await assert.rejects(db.matchFixtureDependency.update({where:{id:dependency.id},data:{sourceGroupRank:null}}));
    await db.match.create({data:{id:foreignMatch,title:"Foreign source",createdBy:owner,type:"single",engineVersion:"V2",dateTime:new Date(),registrationDeadline:new Date(),maxParticipants:4}});
    const foreignGrouping=await db.matchGrouping.create({data:{matchId:foreignMatch,payload:{}}});
    const foreignGroup=await db.matchGroup.create({data:{matchId:foreignMatch,groupingId:foreignGrouping.id,groupKey:"group:0001",displayName:"第 1 组",position:1}});
    await assert.rejects(db.matchFixtureDependency.update({where:{id:dependency.id},data:{sourceGroupId:foreignGroup.id}}));
    assert.equal((await db.matchFixtureDependency.findUniqueOrThrow({where:{id:dependency.id}})).sourceGroupId,dependency.sourceGroupId);
  }finally{
    await db.matchFixtureDependency.deleteMany({where:{matchId}});await db.matchFixtureLineupMember.deleteMany({where:{matchId}});await db.matchFixture.deleteMany({where:{matchId}});
    await db.matchKnockoutSchedule.deleteMany({where:{matchId}});await db.matchGroupEntry.deleteMany({where:{matchId}});await db.matchGroup.deleteMany({where:{matchId:{in:[matchId,foreignMatch]}}});
    await db.matchGrouping.deleteMany({where:{matchId:{in:[matchId,foreignMatch]}}});await db.matchEntryMember.deleteMany({where:{matchId}});await db.matchEntry.deleteMany({where:{matchId}});
    await db.auditLog.deleteMany({where:{entityId:matchId}});await db.match.deleteMany({where:{id:{in:[matchId,foreignMatch]}}});await db.user.deleteMany({where:{id:{in:users}}});await db.$disconnect();
  }
});
