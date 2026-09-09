import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);
const compiledRoot = path.join(
  projectRoot,
  ".v2-test-build/modules/competitions-v2/application",
);

const {
  createV2Entry,
} = require(path.join(compiledRoot, "entries.js"));
const {
  createV2SingleMatchApplicationService,
  createV2SingleGroupThenKnockoutMatchApplicationService,
} = require(path.join(compiledRoot, "matches.js"));
const {
  createV2DoubleMatchApplicationService,
  createV2DoubleGroupThenKnockoutMatchApplicationService,
} = require(path.join(compiledRoot, "double-matches.js"));
const {
  createV2TeamMatchApplicationService,
  createV2TeamGroupThenKnockoutMatchApplicationService,
} = require(path.join(compiledRoot, "team-matches.js"));
const {
  createV2GroupOnlyGroupingApplicationService,
  V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
} = require(path.join(compiledRoot, "group-only-grouping.js"));
const {
  createV2ResultApplicationService,
} = require(path.join(compiledRoot, "results.js"));

const ADMIN_ID = "v2-acceptance-admin";
const ADMIN_EMAIL = "v2-uat-admin@example.test";
const PLAYER_COUNT = 24;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEED_TIME = new Date();
const VERIFIED_AT = new Date(SEED_TIME.getTime() - DAY_MS);
const GROUPING_DEADLINE = new Date(SEED_TIME.getTime() - HOUR_MS);
const GROUPING_TIME = SEED_TIME;
const RESULT_TIME = SEED_TIME;
const REGISTRATION_START = new Date(SEED_TIME.getTime() - 7 * DAY_MS);
const REGISTRATION_DEADLINE = new Date(SEED_TIME.getTime() + 180 * DAY_MS);
const MATCH_TIME = new Date(SEED_TIME.getTime() + 195 * DAY_MS);
const MANIFEST_PATH = path.join(
  projectRoot,
  ".local-postgres/v2-acceptance-data.json",
);

const MATCH_SPECS = Object.freeze([
  {
    key: "single-group-only",
    requestKey: "10000000-0000-4000-8000-000000000001",
    title: "[V2验收 01] 单打·纯小组赛·待确认赛果",
    description:
      "已发布一个两人小组，并预置一条待确认赛果。管理员确认后可检查完赛、积分、ELO、历史和参赛证明。",
    type: "single",
    format: "group_only",
    entryCount: 2,
    stage: "pending-result",
  },
  {
    key: "single-group-knockout",
    requestKey: "10000000-0000-4000-8000-000000000002",
    title: "[V2验收 02] 单打·小组加淘汰赛·已分组",
    description:
      "两组各四人，适合检查桌号、小组赛果、排名、晋级、淘汰赛、DQ 和冠军流程。",
    type: "single",
    format: "group_then_knockout",
    entryCount: 8,
    stage: "grouped",
  },
  {
    key: "double-group-only",
    requestKey: "10000000-0000-4000-8000-000000000003",
    title: "[V2验收 03] 双打·纯小组赛·报名中",
    description:
      "已有八组选手报名，并预置一条选手17邀请选手18的待处理搭档邀请。适合检查组队、报名与退赛。",
    type: "double",
    format: "group_only",
    entryCount: 8,
    stage: "registration",
  },
  {
    key: "double-group-knockout",
    requestKey: "10000000-0000-4000-8000-000000000004",
    title: "[V2验收 04] 双打·小组加淘汰赛·已分组",
    description:
      "八组双打选手已分成两个小组，适合检查双打阵容、赛果结算和淘汰赛晋级。",
    type: "double",
    format: "group_then_knockout",
    entryCount: 8,
    stage: "grouped",
  },
  {
    key: "team-group-only",
    requestKey: "10000000-0000-4000-8000-000000000005",
    title: "[V2验收 05] 团体·纯小组赛·组队中",
    description:
      "六支已成队队伍和两支组建中队伍，适合检查队长编辑、邀请加入、自动成队、退出与解散。",
    type: "team",
    format: "group_only",
    entryCount: 6,
    stage: "registration",
  },
  {
    key: "team-group-knockout",
    requestKey: "10000000-0000-4000-8000-000000000006",
    title: "[V2验收 06] 团体·小组加淘汰赛·已分组",
    description:
      "八支三人队伍已分成两个小组，适合检查团体阵容、分组赛果、晋级、淘汰赛和赛后记录。",
    type: "team",
    format: "group_then_knockout",
    entryCount: 8,
    stage: "grouped",
  },
]);

const CREATION_SERVICES = Object.freeze({
  "single:group_only": createV2SingleMatchApplicationService,
  "single:group_then_knockout":
    createV2SingleGroupThenKnockoutMatchApplicationService,
  "double:group_only": createV2DoubleMatchApplicationService,
  "double:group_then_knockout":
    createV2DoubleGroupThenKnockoutMatchApplicationService,
  "team:group_only": createV2TeamMatchApplicationService,
  "team:group_then_knockout":
    createV2TeamGroupThenKnockoutMatchApplicationService,
});

const GROUPING_PROFILES = Object.freeze({
  "single:group_only": V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  "single:group_then_knockout":
    V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  "double:group_only": V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  "double:group_then_knockout":
    V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  "team:group_only": V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  "team:group_then_knockout":
    V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
});

function playerId(index) {
  return `v2-acceptance-player-${String(index).padStart(2, "0")}`;
}

function playerEmail(index) {
  return `v2-uat-player-${String(index).padStart(2, "0")}@example.test`;
}

function playerNickname(index) {
  return `V2 验收选手 ${String(index).padStart(2, "0")}`;
}

function hashPassword(password) {
  const saltHex = randomBytes(32).toString("hex");
  const hashHex = scryptSync(password, saltHex, 64, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  }).toString("hex");
  return `s2$${1 << 15}$8$1$${saltHex}$${hashHex}`;
}

function assertDedicatedLocalDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    database !== "ustctta_v2"
  ) {
    throw new Error(
      "Acceptance data may only be seeded into 127.0.0.1:55432/ustctta_v2.",
    );
  }
}

function creationCommand(spec) {
  const base = {
    actor: { id: ADMIN_ID, role: "admin" },
    requestKey: spec.requestKey,
    title: spec.title,
    description: spec.description,
    location: "西区乒乓球馆",
    dateTime: MATCH_TIME,
    registrationDeadline: REGISTRATION_DEADLINE,
    type: spec.type,
    format: spec.format,
  };
  if (spec.type !== "team") return base;
  return {
    ...base,
    teamRegistrationStart: REGISTRATION_START,
    teamRegistrationDeadline: REGISTRATION_DEADLINE,
    teamMinMembers: 3,
    teamMaxMembers: 6,
  };
}

async function createAccounts(db, password) {
  const ids = [ADMIN_ID, ...Array.from({ length: PLAYER_COUNT }, (_, i) => playerId(i + 1))];
  const existing = await db.user.count({
    where: {
      OR: [
        { id: { in: ids } },
        { email: { startsWith: "v2-uat-", endsWith: "@example.test" } },
      ],
    },
  });
  if (existing > 0) {
    throw new Error(
      "V2 acceptance accounts already exist. Refusing to create a duplicate or overwrite modified acceptance data.",
    );
  }

  const hashedPassword = hashPassword(password);
  await db.user.createMany({
    data: [
      {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        nickname: "V2 验收管理员",
        role: "admin",
        hashedPassword,
        emailVerifiedAt: VERIFIED_AT,
      },
      ...Array.from({ length: PLAYER_COUNT }, (_, index) => ({
        id: playerId(index + 1),
        email: playerEmail(index + 1),
        nickname: playerNickname(index + 1),
        role: "user",
        hashedPassword,
        emailVerifiedAt: VERIFIED_AT,
        eloRating: 1160 + index * 7,
        points: 20 + index,
      })),
    ],
  });
}

async function createSingleEntries(db, matchId, count) {
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const userId = playerId(index);
    const entry = await createV2Entry(db, {
      actor: { id: userId, role: "user" },
      matchId,
      kind: "INDIVIDUAL",
      sourceId: userId,
      status: "ACTIVE",
    });
    entries.push({ ...entry, userIds: [userId] });
  }
  return entries;
}

async function createDoubleEntries(db, matchId, specKey, count) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const userIds = [playerId(index * 2 + 1), playerId(index * 2 + 2)];
    const sourceId = `v2-acceptance-${specKey}-pair-${index + 1}`;
    await db.matchDoublesTeam.create({
      data: {
        id: sourceId,
        matchId,
        createdById: userIds[0],
        registeredAt: VERIFIED_AT,
        members: {
          create: userIds.map((userId, memberIndex) => ({
            userId,
            slot: memberIndex + 1,
          })),
        },
      },
    });
    const entry = await createV2Entry(db, {
      actor: { id: userIds[0], role: "user" },
      matchId,
      kind: "DOUBLES",
      sourceId,
      status: "ACTIVE",
    });
    entries.push({ ...entry, userIds });
  }
  return entries;
}

async function createTeamSource(
  db,
  matchId,
  specKey,
  teamIndex,
  status,
  memberCount = 3,
) {
  const firstPlayer = (teamIndex - 1) * 3 + 1;
  const userIds = [
    playerId(firstPlayer),
    playerId(firstPlayer + 1),
    playerId(firstPlayer + 2),
  ].slice(0, memberCount);
  const sourceId = `v2-acceptance-${specKey}-team-${teamIndex}`;
  await db.matchTeam.create({
    data: {
      id: sourceId,
      matchId,
      captainId: userIds[0],
      name: `V2 验收队伍 ${String(teamIndex).padStart(2, "0")}`,
      inviteCode: `v2-uat-${specKey}-${teamIndex}`,
      contact: `验收联系人 ${teamIndex}`,
      remark: "本地 V2 验收数据",
      status,
      submittedAt: status === "draft" ? null : VERIFIED_AT,
      reviewedAt: status === "approved" ? VERIFIED_AT : null,
      reviewedById: status === "approved" ? ADMIN_ID : null,
      members: {
        create: userIds.map((userId) => ({ userId })),
      },
    },
  });
  return { sourceId, userIds };
}

async function createTeamEntries(db, matchId, specKey, count) {
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const { sourceId, userIds } = await createTeamSource(
      db,
      matchId,
      specKey,
      index,
      "approved",
    );
    const entry = await createV2Entry(db, {
      actor: { id: userIds[0], role: "user" },
      matchId,
      kind: "TEAM",
      sourceId,
      status: "ACTIVE",
    });
    entries.push({ ...entry, userIds });
  }
  return entries;
}

async function createEntries(db, match, spec) {
  if (spec.type === "single") {
    return createSingleEntries(db, match.id, spec.entryCount);
  }
  if (spec.type === "double") {
    return createDoubleEntries(db, match.id, spec.key, spec.entryCount);
  }
  return createTeamEntries(db, match.id, spec.key, spec.entryCount);
}

async function publishGrouping(db, match, spec, entries) {
  await db.match.update({
    where: { id: match.id },
    data: {
      registrationDeadline: GROUPING_DEADLINE,
      ...(spec.type === "team"
        ? { teamRegistrationDeadline: GROUPING_DEADLINE }
        : {}),
    },
  });
  const profile = GROUPING_PROFILES[`${spec.type}:${spec.format}`];
  const service = createV2GroupOnlyGroupingApplicationService(
    { db, clock: () => GROUPING_TIME },
    profile,
  );
  await service.publish({
    actor: { id: ADMIN_ID, role: "admin" },
    matchId: match.id,
    expectedEntries: entries.map((entry) => ({
      entryId: entry.id,
      version: entry.version,
    })),
    draft: {
      format: spec.format,
      ...(spec.format === "group_then_knockout"
        ? { qualifiersPerGroup: 2 }
        : {}),
      seedMethod: "snake",
      groups:
        entries.length <= 4
          ? [{ entryIds: entries.map((entry) => entry.id) }]
          : [
              { entryIds: entries.slice(0, 4).map((entry) => entry.id) },
              { entryIds: entries.slice(4, 8).map((entry) => entry.id) },
            ],
    },
  });
}

async function seedPendingSingleResult(db, matchId) {
  const fixture = await db.matchFixture.findFirstOrThrow({
    where: { matchId, stage: "GROUP" },
    orderBy: { fixtureKey: "asc" },
  });
  if (!fixture.sideAEntryId || !fixture.sideBEntryId) {
    throw new Error("The acceptance fixture does not have two entries.");
  }
  const reporter = await db.matchEntry.findUniqueOrThrow({
    where: { id: fixture.sideAEntryId },
    select: { sourceUserId: true },
  });
  if (!reporter.sourceUserId) {
    throw new Error("The acceptance fixture reporter is missing.");
  }
  const service = createV2ResultApplicationService({
    db,
    clock: () => RESULT_TIME,
  });
  await service.submitRevision({
    actor: { actorId: reporter.sourceUserId, role: "user" },
    matchId,
    fixtureId: fixture.id,
    expectedFixtureVersion: fixture.version,
    requiredFixtureStage: "GROUP",
    winnerEntryId: fixture.sideAEntryId,
    loserEntryId: fixture.sideBEntryId,
    score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
  });
}

async function addRegistrationStageExamples(db, match, spec) {
  if (spec.key === "double-group-only") {
    await db.matchDoublesInvite.create({
      data: {
        matchId: match.id,
        inviterId: playerId(17),
        inviteeId: playerId(18),
        status: "pending",
      },
    });
  }
  if (spec.key === "team-group-only") {
    await createTeamSource(db, match.id, spec.key, 7, "draft", 2);
    await createTeamSource(db, match.id, spec.key, 8, "draft", 1);
  }
}

async function main() {
  assertDedicatedLocalDatabase();
  const db = new PrismaClient();
  const password = `${randomBytes(9).toString("base64url")}!Aa1`;
  const manifest = {
    generatedAt: new Date().toISOString(),
    database: "127.0.0.1:55432/ustctta_v2",
    creationMode: "V2",
    accounts: {
      sharedPassword: password,
      admin: { email: ADMIN_EMAIL, nickname: "V2 验收管理员" },
      players: Array.from({ length: PLAYER_COUNT }, (_, index) => ({
        number: index + 1,
        email: playerEmail(index + 1),
        nickname: playerNickname(index + 1),
      })),
    },
    matches: [],
  };

  try {
    await createAccounts(db, password);
    for (const spec of MATCH_SPECS) {
      const createService = CREATION_SERVICES[`${spec.type}:${spec.format}`]({
        db,
      });
      const match = await createService.create(creationCommand(spec));
      const entries = await createEntries(db, match, spec);
      await addRegistrationStageExamples(db, match, spec);
      if (spec.stage !== "registration") {
        await publishGrouping(db, match, spec, entries);
      }
      if (spec.stage === "pending-result") {
        await seedPendingSingleResult(db, match.id);
      }
      manifest.matches.push({
        key: spec.key,
        id: match.id,
        title: spec.title,
        type: spec.type,
        format: spec.format,
        stage: spec.stage,
        entryCount: entries.length,
        path: `/matchs/${match.id}`,
      });
      console.log(`seeded ${spec.title}`);
    }

    await mkdir(path.dirname(MANIFEST_PATH), { recursive: true, mode: 0o700 });
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`manifest=${MANIFEST_PATH}`);
    console.log(`admin=${ADMIN_EMAIL}`);
    console.log(`shared-password=${password}`);
  } finally {
    await db.$disconnect();
  }
}

await main();
