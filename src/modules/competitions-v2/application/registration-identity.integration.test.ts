import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createV2SingleActionHandlers } from "../adapters/single-actions";
import { createV2DoubleActionHandlers } from "../adapters/double-actions";
import { createV2Entry } from "./entries";
import { reconcileV2TeamEntryRegistration, lockV2TeamEntryRegistrationContext, reconcileV2TeamEntryRegistrationInTransaction } from "./team-entry-registration";
import { replaceCompetitionRoster } from "./roster-management";
import { saveRegistrationIdentity } from "../../../lib/server/registration-identity";

const url = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
// Intentionally fictitious region code; only exercise the format/checksum locally.
const stem = "99000020000101001";
const checksum = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2].reduce((sum,n,i) => sum+n*Number(stem[i]),0);
const identity = { realName: "测试选手", idNumber: stem + "10X98765432"[checksum % 11], consent: true };
function form(fields: Record<string,string> = {}) {
  const result = new FormData();
  for (const [key,value] of Object.entries({csrfToken: "test", ...fields})) result.set(key,value);
  return result;
}
const fields = { realName: identity.realName, idNumber: identity.idNumber, identityConsent: "on" };

test("registration identities: member-only, atomic with enrollment, two-party confirmation, no delegate bypass", { skip: !url }, async t => {
  const oldKey = process.env.REGISTRATION_IDENTITY_KEY;
  process.env.REGISTRATION_IDENTITY_KEY = randomBytes(32).toString("base64");
  t.after(() => { if (oldKey === undefined) delete process.env.REGISTRATION_IDENTITY_KEY; else process.env.REGISTRATION_IDENTITY_KEY = oldKey; });
  const db = new PrismaClient({ datasourceUrl: url! });
  const suffix = randomUUID();
  const [admin, a, b, c, outsider] = ["admin","a","b","c","other"].map(p => p+"-"+suffix);
  t.after(async () => {
    try { await db.user.updateMany({where:{id:admin},data:{role:"user"}}); }
    finally { await db.$disconnect(); }
  });
  await db.user.createMany({ data: [admin,a,b,c,outsider].map(id=>({
    id,email:id+"@example.test",nickname:"合成测试用户",emailVerifiedAt:new Date(),role:id===admin?"admin":"user",
  })) });
  const match = (type: "single"|"double"|"team",enabled=true) => db.match.create({data:{
    type,title:"Synthetic registration test",format:"group_only",engineVersion:"V2",status:"registration",
    dateTime:new Date("2099-03-01"),registrationDeadline:new Date("2099-02-01"),maxParticipants:40,createdBy:admin,
    collectIdentityInfo: enabled, ...(type==="team"?{teamMinMembers:2,teamMaxMembers:4}:{}),
  }});
  const deps = (id:string) => ({db,validateCsrfToken:async()=>null,getCurrentUser:async()=>({id,role:"user" as const})});
  const identityCount = (matchId:string) => db.matchRegistrationIdentity.count({where:{matchId}});

  await t.test("single: missing consent, admin bulk registration and duplicate fields fail; opt-in creates encrypted row, cancellation clears it", async () => {
    const {id} = await match("single");
    const self = createV2SingleActionHandlers(deps(a));
    assert.ok((await self.register(id, form({...fields, identityConsent:""}))).error);
    const duplicate = form(fields); duplicate.append("idNumber","malformed");
    assert.ok((await self.register(id, duplicate)).error);
    await assert.rejects(createV2Entry(db,{matchId:id,actor:{id:admin,role:"admin"},sourceId:a,kind:"INDIVIDUAL",status:"ACTIVE",adminOverride:true,overrideReason:"Synthetic override test"}), /亲自提交/);
    assert.equal(await identityCount(id),0);
    assert.equal(await db.matchEntry.count({where:{matchId:id}}),0);
    assert.ok((await self.register(id,form(fields))).success);
    const record = await db.matchRegistrationIdentity.findUniqueOrThrow({where:{matchId_userId:{matchId:id,userId:a}}});
    assert.ok(!record.encryptedData.includes(identity.realName) && !record.encryptedData.includes(identity.idNumber));
    assert.ok((await self.register(id,form(fields))).success);
    assert.equal(await identityCount(id),1);
    assert.ok((await self.cancelRegistration(id,form())).success);
    assert.equal(await identityCount(id),0);
    const disabled = await match("single",false);
    assert.ok((await self.register(disabled.id,form({realName:"ignored",idNumber:"malformed"}))).success);
    assert.equal(await identityCount(disabled.id),0);
  });

  await t.test("doubles: withdrawal of pending consent, concurrent independent submissions, idempotent activation and cleanup", async () => {
    const {id} = await match("double");
    await db.matchDoublesTeam.create({data:{matchId:id,createdById:a,members:{create:[{userId:a,slot:1},{userId:b,slot:2}]}}});
    const aa = createV2DoubleActionHandlers(deps(a)), bb = createV2DoubleActionHandlers(deps(b));
    assert.match((await aa.register(id,form(fields))).success??"", /等待搭档/);
    assert.equal(await identityCount(id),1);
    assert.equal(await db.matchEntry.count({where:{matchId:id}}),0);
    assert.ok((await bb.register(id,form())).error);
    assert.ok((await aa.cancelRegistration(id,form({pendingIdentityOnly:"1"}))).success);
    assert.equal(await identityCount(id),0);
    const both = await Promise.all([aa.register(id,form(fields)),bb.register(id,form(fields))]);
    assert.ok(both.every(result=>result.success),JSON.stringify(both));
    assert.equal(await identityCount(id),2);
    assert.equal(await db.matchEntry.count({where:{matchId:id,status:"ACTIVE"}}),1);
    assert.ok((await aa.cancelRegistration(id,form({pendingIdentityOnly:"1"}))).error);
    assert.equal(await identityCount(id),2);
    assert.ok((await bb.cancelRegistration(id,form())).success);
    assert.equal(await identityCount(id),0);
  });

  await t.test("team: reconciliation failure rolls back submitted identity; admins cannot substitute unconsenting members; departing player's row is erased", async () => {
    const {id} = await match("team");
    const team=await db.matchTeam.create({data:{matchId:id,name:"Synthetic team",captainId:a,inviteCode:randomUUID(),status:"approved",members:{create:[a,b,c].map(userId=>({userId}))}}});
    const lockInput={matchId:id,teamId:team.id};
    await assert.rejects(db.$transaction(async tx=>{
      const context=await lockV2TeamEntryRegistrationContext(tx,lockInput);
      await saveRegistrationIdentity(tx,{matchId:id,userId:a,identity});
      await reconcileV2TeamEntryRegistrationInTransaction(tx,context);
    }),/亲自提交/);
    assert.equal(await identityCount(id),0);
    await db.$transaction(async tx=>{for (const userId of [a,b,c]) await saveRegistrationIdentity(tx,{matchId:id,userId,identity});});
    const entry=await reconcileV2TeamEntryRegistration(db,lockInput);
    assert.ok(entry.entryId && entry.version !== null);
    const command={matchId:id,entryId:entry.entryId,actor:{id:admin,role:"admin" as const},expectedEntryVersion:entry.version,reason:"Synthetic roster change"};
    await assert.rejects(replaceCompetitionRoster(db,{...command,memberIds:[a,b,outsider]}),/亲自提交/);
    await replaceCompetitionRoster(db,{...command,memberIds:[a,b]});
    assert.equal(await identityCount(id),2);
    assert.equal(await db.matchRegistrationIdentity.count({where:{matchId:id,userId:c}}),0);
  });
});
