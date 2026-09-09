import { Prisma, type PrismaClient } from "@prisma/client";
import { lockUsersForUpdate } from "../../../lib/server/user/lock-users";
import { assertEntryCanActivate } from "../domain/entries";
import {
  V2CompetitionApplicationError,
  loadV2WriteContext,
  replaceV2EntryRosterKernel,
  runV2Transaction,
  type V2Actor,
} from "./entries";

export type ReplaceCompetitionRosterCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  entryId: string;
  expectedEntryVersion: number;
  memberIds: readonly string[];
  captainId?: string;
  reason: string;
}>;

function fail(message: string): never {
  throw new V2CompetitionApplicationError("INVALID_INPUT", message);
}

/** Changes one stable competition identity; historical fixture recipients stay fixed. */
export async function replaceCompetitionRoster(
  db: Pick<PrismaClient, "$transaction">,
  command: ReplaceCompetitionRosterCommand,
) {
  if (!command.reason.trim() || command.reason.trim().length > 500) fail("请填写换人原因（最多 500 字）。");
  if (!Number.isSafeInteger(command.expectedEntryVersion) || command.expectedEntryVersion < 0) fail("名单版本无效，请刷新页面。");
  if (!Array.isArray(command.memberIds) || command.memberIds.length > 50 || new Set(command.memberIds).size !== command.memberIds.length || command.memberIds.some(id => typeof id !== "string" || !id || id.length > 191 || id !== id.trim())) fail("请选择有效且不重复的成员。");
  return runV2Transaction(db, async tx => {
    const context = await loadV2WriteContext(tx, command.matchId, command.actor);
    if (context.actor.role !== "admin") throw new V2CompetitionApplicationError("FORBIDDEN", "只有平台管理员可以更换已发布的参赛名单。");
    if (context.match.status === "finished") fail("比赛已结束，不能更换成员。");
    if (context.match.type === "single") fail("单打选手不能被替换，请使用退赛操作。");

    await tx.$queryRaw(Prisma.sql`SELECT id FROM match_entry WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM match_entry_member WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
    const entry = await tx.matchEntry.findFirst({
      where: { id: command.entryId, matchId: command.matchId },
      select: {
        id: true, kind: true, status: true, version: true, sourceMatchTeamId: true, sourceDoublesTeamId: true,
        members: { where: { status: "ACTIVE", effectiveUntil: null }, orderBy: { slot: "asc" }, select: { userId: true, role: true, rosterVersion: true } },
      },
    });
    if (!entry) throw new V2CompetitionApplicationError("ENTRY_NOT_FOUND", "参赛记录不存在。");
    if (entry.status !== "ACTIVE") fail("只有仍在参赛的组合或队伍可以换人。");
    if (entry.version !== command.expectedEntryVersion) throw new V2CompetitionApplicationError("ENTRY_VERSION_CONFLICT", "名单已变化，请刷新后重试。");
    assertEntryCanActivate({ kind: entry.kind, memberIds: command.memberIds, minimumTeamMembers: context.match.teamMinMembers ?? undefined, maximumTeamMembers: context.match.teamMaxMembers ?? undefined });

    // Source rows are the editable directory for invitations. Entry/fixture
    // snapshots remain the authority for competition identity and results.
    if (entry.sourceMatchTeamId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM match_team WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM match_team_member WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
      const conflict = await tx.matchTeamMember.findFirst({ where: { matchId: command.matchId, teamId: { not: entry.sourceMatchTeamId }, userId: { in: [...command.memberIds] } }, select: { id: true } });
      if (conflict) fail("有成员仍属于本赛事另一支队伍，请先处理其组队关系。");
    } else if (entry.sourceDoublesTeamId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM match_doubles_team WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM match_doubles_team_member WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
      const conflict = await tx.matchDoublesTeamMember.findFirst({ where: { matchId: command.matchId, teamId: { not: entry.sourceDoublesTeamId }, userId: { in: [...command.memberIds] } }, select: { id: true } });
      if (conflict) fail("有成员仍属于本赛事另一对搭档，请先处理其组队关系。");
    } else fail("参赛队伍缺少组队记录，请联系维护人员。");
    await tx.$queryRaw(Prisma.sql`SELECT id FROM match_fixture WHERE match_id = ${command.matchId} ORDER BY id FOR UPDATE`);
    await lockUsersForUpdate(tx, [...command.memberIds, ...entry.members.map(member => member.userId), command.actor.id]);
    const actor = await tx.user.findUnique({ where: { id: command.actor.id }, select: { role: true, isBanned: true, emailVerifiedAt: true } });
    if (!actor || actor.role !== "admin" || actor.isBanned || !actor.emailVerifiedAt) throw new V2CompetitionApplicationError("FORBIDDEN", "管理员权限已变化，请重新登录。");
    const users = await tx.user.findMany({ where: { id: { in: [...command.memberIds] } }, select: { id: true, nickname: true, isBanned: true, emailVerifiedAt: true } });
    if (users.length !== command.memberIds.length || users.some(user => user.isBanned || !user.emailVerifiedAt)) fail("成员必须是未封禁且已验证邮箱的用户。");
    const byId = new Map(users.map(user => [user.id, user]));
    const previousCaptain = entry.members.find(member => member.role === "captain")?.userId;
    const captainId = command.captainId ?? (previousCaptain && command.memberIds.includes(previousCaptain) ? previousCaptain : command.memberIds[0]);
    if (entry.kind === "TEAM" && !command.memberIds.includes(captainId)) fail("队长必须在新名单中。");
    const members = command.memberIds.map(userId => ({ userId, displayNameSnapshot: byId.get(userId)!.nickname, role: entry.kind === "TEAM" && userId === captainId ? "captain" as const : "player" as const }));
    if (entry.members.length === members.length && entry.members.every((member, index) => member.userId === members[index].userId && member.role === members[index].role)) fail("新名单与当前名单相同。");
    const replacement = await replaceV2EntryRosterKernel(tx, {
      matchId: command.matchId, entry, expectedVersion: command.expectedEntryVersion, members,
      settlementOrigin: "ADMIN_BULK",
      ...(entry.kind === "DOUBLES" ? { displayNameSnapshot: members.map(member => member.displayNameSnapshot).join(" / ") } : {}),
    });
    if (entry.sourceMatchTeamId) {
      await tx.matchTeamMember.deleteMany({ where: { teamId: entry.sourceMatchTeamId, matchId: command.matchId } });
      await tx.matchTeam.update({ where: { id: entry.sourceMatchTeamId }, data: { captainId } });
      await tx.matchTeamMember.createMany({ data: members.map((member, index) => ({ teamId: entry.sourceMatchTeamId!, matchId: command.matchId, userId: member.userId, joinedAt: new Date(Date.now() + index) })) });
    } else {
      await tx.matchDoublesTeamMember.deleteMany({ where: { teamId: entry.sourceDoublesTeamId!, matchId: command.matchId } });
      await tx.matchDoublesTeamMember.createMany({ data: members.map((member, index) => ({ teamId: entry.sourceDoublesTeamId!, matchId: command.matchId, userId: member.userId, slot: index + 1 })) });
    }
    const newMembers = await tx.matchEntryMember.findMany({ where: { entryId: entry.id, rosterVersion: replacement.rosterVersion }, orderBy: { slot: "asc" }, select: { id: true, slot: true } });
    const future = await tx.matchFixture.findMany({
      where: { matchId: command.matchId, OR: [{ sideAEntryId: entry.id }, { sideBEntryId: entry.id }], status: { in: ["SCHEDULED", "READY"] }, startedAt: null, resultRevisions: { none: {} }, administrativeResolution: null },
      orderBy: { id: "asc" }, select: { id: true, sideAEntryId: true, version: true },
    });
    for (const fixture of future) {
      const side = fixture.sideAEntryId === entry.id ? "SIDE_A" as const : "SIDE_B" as const;
      await tx.matchFixtureLineupMember.deleteMany({ where: { fixtureId: fixture.id, side } });
      await tx.matchFixture.update({ where: { id: fixture.id }, data: { ...(side === "SIDE_A" ? { sideARosterVersion: replacement.rosterVersion } : { sideBRosterVersion: replacement.rosterVersion }), version: { increment: 1 } } });
      await tx.matchFixtureLineupMember.createMany({ data: newMembers.map(member => ({ matchId: command.matchId, fixtureId: fixture.id, entryId: entry.id, entryMemberId: member.id, side, position: member.slot })) });
    }
    await tx.auditLog.create({ data: { actorId: command.actor.id, action: "competition_roster_replace", entityType: "MatchEntry", entityId: entry.id, details: { matchId: command.matchId, reason: command.reason.trim(), previousMemberIds: entry.members.map(member => member.userId), memberIds: [...command.memberIds], rosterVersion: replacement.rosterVersion, reboundFixtureIds: future.map(fixture => fixture.id) } } });
    return { entryId: entry.id, entryVersion: replacement.version, rosterVersion: replacement.rosterVersion, updatedFixtureCount: future.length };
  });
}
