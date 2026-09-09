import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { setUserBanState } from "../../../lib/server/user/ban-user";

const url = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
test("PostgreSQL archive migration preserves confirmed history and every personal ledger, excludes unconfirmed reports, and leaves quick matches independent", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const prefix = `archive-${randomUUID()}`;
  const adminId = `${prefix}-admin`, userId = `${prefix}-user`, opponentId = `${prefix}-opponent`;
  const matchId = `${prefix}-formal`, quickId = `${prefix}-quick`;
  try {
    await db.user.createMany({ data: [adminId, userId, opponentId].map(id => ({ id, email: `${id}@example.test`, nickname: id, role: id === adminId ? "admin" : "user", emailVerifiedAt: new Date(), points: 19, eloRating: 1337, wins: 4, losses: 2, matchesPlayed: 6 })) });
    for (const id of [matchId, quickId]) await db.match.create({ data: { id, title: id, type: "single", engineVersion: "LEGACY", isQuickMatch: id === quickId, status: "ongoing", dateTime: new Date(), registrationDeadline: new Date(), maxParticipants: 2, createdBy: adminId, groupingResult: { create: { payload: { obsolete: true } } }, registrations: { create: { userId } } } });
    const result = (id: string, confirmed: boolean) => ({ matchId: id, confirmed, winnerId: userId, loserId: opponentId, winnerTeamIds: [userId], loserTeamIds: [opponentId], score: { text: "3:1" }, reportedBy: adminId, ...(confirmed ? { resultVerifiedAt: new Date(), verifierId: adminId } : {}) });
    const played = await db.matchResult.create({ data: result(matchId, true) });
    const pending = await db.matchResult.create({ data: result(matchId, false) });
    const anomalous = await db.matchResult.create({ data: result(matchId, false) });
    const quickPending = await db.matchResult.create({ data: result(quickId, false) });
    await db.eloHistory.createMany({ data: [played, anomalous].map(row => ({ userId, matchId, matchResultId: row.id, eloBefore: 1327, eloAfter: 1337, delta: 10 })) });
    await db.pointsTransaction.create({ data: { userId, amount: 1, balanceAfter: 19, type: "earn", reason: "Historical entry", referenceId: matchId } });
    const personal = () => db.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true, eloRating: true, wins: true, losses: true, matchesPlayed: true } });
    const ledgers = () => Promise.all([db.eloHistory.findMany({ where: { userId }, orderBy: { id: "asc" } }), db.pointsTransaction.findMany({ where: { userId }, orderBy: { id: "asc" } })]);
    const beforePersonal = await personal(), beforeLedgers = await ledgers();
    const statements = readFileSync("prisma/migrations/20260907130000_archive_legacy_formal/migration.sql", "utf8").replace(/--[^\n]*/g, "").split(";").map(sql => sql.trim()).filter(sql => sql && sql !== "BEGIN" && sql !== "COMMIT");
    await db.$transaction(async tx => { for (const sql of statements) await tx.$executeRawUnsafe(sql); });
    assert.equal((await db.match.findUniqueOrThrow({ where: { id: matchId } })).status, "finished");
    assert.equal((await db.match.findUniqueOrThrow({ where: { id: quickId } })).status, "ongoing");
    assert.equal(await db.matchGrouping.count({ where: { matchId } }), 0);
    assert.equal(await db.matchGrouping.count({ where: { matchId: quickId } }), 1);
    assert.equal(await db.matchResult.count({ where: { id: pending.id } }), 0);
    assert.equal(await db.matchResult.count({ where: { id: anomalous.id } }), 1);
    assert.equal(await db.matchResult.count({ where: { id: quickPending.id } }), 1);
    assert.deepEqual(await db.matchResult.findMany({ where: { matchId, confirmed: true } }), [played]);
    assert.deepEqual(await personal(), beforePersonal);
    assert.deepEqual(await ledgers(), beforeLedgers);
    // A stale historical status must still never reopen old ban reconciliation.
    await db.match.update({ where: { id: matchId }, data: { status: "ongoing" } });
    await db.registration.deleteMany({ where: { matchId: quickId } });
    await db.$transaction(tx => setUserBanState(tx, { actorId: adminId, userId, banned: true }), { isolationLevel: "Serializable" });
    assert.equal(await db.registration.count({ where: { matchId, userId } }), 1);
    assert.deepEqual(await personal(), beforePersonal);
    assert.deepEqual(await ledgers(), beforeLedgers);
    assert.deepEqual(await db.matchResult.findUniqueOrThrow({ where: { id: played.id } }), played);
  } finally {
    await db.user.updateMany({ where: { id: adminId }, data: { role: "user" } });
    await db.$disconnect();
  }
});
