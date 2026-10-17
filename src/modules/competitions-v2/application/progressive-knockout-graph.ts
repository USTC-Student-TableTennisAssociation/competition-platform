import { Prisma } from "@prisma/client";

import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import { parseV2SingleGroupTableLabelsFromMetadata } from "../domain/group-fixture-metadata";
import {
  assertActiveRevisionShape,
  assertExactLineup,
  authoritativeAdvancement,
  type DependencyRow,
  type FixtureRow,
  type RosterMemberRow,
  type V2KnockoutMatchContext,
  type ValidatedGraph,
} from "./knockout-advancement";
import { V2ResultApplicationError } from "./results-errors";
import type { ResultSettlementTransaction } from "./settlements";

type Side = "SIDE_A" | "SIDE_B";
type Standing = Readonly<{
  id: string; matchId: string; snapshotId: string; groupId: string; entryId: string;
  rank: number; qualified: boolean; qualificationOrder: number | null;
  entryVersion: number; rosterVersion: number;
  played: number; wins: number; losses: number; scoreFor: number; scoreAgainst: number; scoreDifferential: number;
  ineligibilityReason: string | null;
}>;
type Group = Readonly<{
  id: string; matchId: string; groupingId: string; groupKey: string; position: number;
  entries: readonly Readonly<{ entryId: string }>[];
  qualificationSnapshot: Readonly<{
    id: string; matchId: string; groupId: string; schemaVersion: number;
    standingsPolicyVersion: number; sourceRevisionFingerprint: string;
    standings: readonly Standing[];
  }> | null;
}>;
export type V2ProgressiveKnockoutGraph = Readonly<{
  match: V2KnockoutMatchContext;
  grouping: Readonly<{
    id: string; matchId: string; v2SchemaVersion: number | null;
    standingsPolicyVersion: number | null; qualifiersPerGroup: number | null;
    bracketPolicyVersion: number | null;
  }>;
  schedule: Readonly<{
    id: string; matchId: string; groupingId: string; schemaVersion: number;
    bracketPolicyVersion: number; layoutFingerprint: string; createdAt: Date;
  }>;
  groups: readonly Group[];
  fixtures: readonly FixtureRow[];
  dependencies: readonly DependencyRow[];
  rosterMembers: readonly RosterMemberRow[];
}>;

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new V2ResultApplicationError("AGGREGATE_INVARIANT_VIOLATION", message, details);
}
const sideKey = (fixtureId: string, side: Side) => `${fixtureId}\u0000${side}`;
const sideValues = (fixture: FixtureRow, side: Side) => side === "SIDE_A"
  ? { entryId: fixture.sideAEntryId, rosterVersion: fixture.sideARosterVersion }
  : { entryId: fixture.sideBEntryId, rosterVersion: fixture.sideBRosterVersion };

/** Unknown and terminal empty are deliberately separate states. */
export function progressiveSourceValue(
  graph: V2ProgressiveKnockoutGraph,
  dependency: DependencyRow,
): Readonly<{ known: boolean; entryId: string | null; rosterVersion: number | null }> {
  if (dependency.sourceGroupId != null) {
    const group = graph.groups.find(group => group.id === dependency.sourceGroupId);
    if (!group) fail("A progressive source references an unknown group.", { dependencyId: dependency.id });
    const snapshot = group.qualificationSnapshot;
    if (!snapshot) return { known: false, entryId: null, rosterVersion: null };
    const standing = snapshot.standings.find(standing => standing.rank === dependency.sourceGroupRank);
    return standing?.qualified
      ? { known: true, entryId: standing.entryId, rosterVersion: standing.rosterVersion }
      : { known: true, entryId: null, rosterVersion: null };
  }
  const source = graph.fixtures.find(fixture => fixture.id === dependency.sourceFixtureId);
  if (!source) fail("A progressive source references an unknown fixture.", { dependencyId: dependency.id });
  if (source.status !== "COMPLETED" && source.status !== "VOIDED") {
    return { known: false, entryId: null, rosterVersion: null };
  }
  return { known: true, ...authoritativeAdvancement(source) };
}

/** Validates the fixed slot graph without manufacturing qualification standings. */
export function validateV2ProgressiveKnockoutGraph(
  graph: V2ProgressiveKnockoutGraph,
  options: Readonly<{ ignoredWinnerSourceId?: string; allowRefreshSources?: boolean }> = {},
): ValidatedGraph {
  const { match, grouping, schedule } = graph;
  if (match.engineVersion !== "V2" || match.isQuickMatch || match.format !== "group_then_knockout" ||
      (match.status !== "ongoing" && match.status !== "finished") ||
      grouping.matchId !== match.id || grouping.v2SchemaVersion !== 1 || grouping.standingsPolicyVersion !== 1 || grouping.bracketPolicyVersion !== 1 ||
      schedule.matchId !== match.id || schedule.groupingId !== grouping.id ||
      schedule.schemaVersion !== 1 || ![2, 3].includes(schedule.bracketPolicyVersion) ||
      !/^[a-f0-9]{64}$/.test(schedule.layoutFingerprint) || !Number.isFinite(schedule.createdAt.getTime())) {
    fail("The progressive knockout schedule has incompatible authority fields.", { matchId: match.id });
  }
  let qualificationOrderBySlot: readonly number[] | undefined;
  if (schedule.bracketPolicyVersion === 3) {
    const first = graph.fixtures.find(fixture => fixture.fixtureKey === "knockout:r0001:m0001");
    const metadata = first?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        !Array.isArray(metadata.qualificationOrderBySlot)) {
      fail("An explicit progressive schedule has no frozen qualification slot order.", { matchId: match.id });
    }
    // The plan builder verifies the complete integer permutation before it is used.
    qualificationOrderBySlot = metadata.qualificationOrderBySlot as readonly number[];
  }
  let plan;
  try {
    plan = buildV2ProgressiveKnockoutPlan({ groupingId: grouping.id, groups: graph.groups,
      qualifiersPerGroup: grouping.qualifiersPerGroup!, qualificationOrderBySlot });
  } catch (error) {
    fail("The progressive grouping cannot produce a complete knockout layout.", { matchId: match.id, reason: error instanceof Error ? error.message : "invalid layout" });
  }
  if (plan.bracketPolicyVersion !== schedule.bracketPolicyVersion || plan.layoutFingerprint !== schedule.layoutFingerprint ||
      graph.fixtures.length !== plan.fixtureCount || graph.fixtures.length > 1_023 ||
      graph.dependencies.length !== plan.fixtureCount * 2 || graph.rosterMembers.length > 51_200) {
    fail("The progressive knockout graph does not match its published layout.", { matchId: match.id });
  }
  const qualifiedEntries = new Set<string>();
  const standingIds = new Set<string>();
  for (const group of graph.groups) {
    if (group.matchId !== match.id || group.groupingId !== grouping.id) fail("A progressive source group belongs to another grouping.");
    const snapshot = group.qualificationSnapshot;
    if (!snapshot) continue;
    if (snapshot.matchId !== match.id || snapshot.groupId !== group.id || snapshot.schemaVersion !== 1 ||
        snapshot.standingsPolicyVersion !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.sourceRevisionFingerprint) ||
        snapshot.standings.length !== group.entries.length) {
      fail("A progressive group snapshot is incomplete or has incompatible authority fields.", { groupId: group.id });
    }
    const members = new Set(group.entries.map(entry => entry.entryId));
    const ranks = new Set<number>();
    const entries = new Set<string>();
    for (const standing of snapshot.standings) {
      const expectedOrder = (standing.rank - 1) * graph.groups.length + group.position;
      if (standing.matchId !== match.id || standing.snapshotId !== snapshot.id || standing.groupId !== group.id ||
          !members.has(standing.entryId) || entries.has(standing.entryId) || standingIds.has(standing.id) ||
          !Number.isSafeInteger(standing.rank) || standing.rank < 1 || standing.rank > members.size || ranks.has(standing.rank) ||
          !Number.isSafeInteger(standing.entryVersion) || standing.entryVersion < 0 ||
          !Number.isSafeInteger(standing.rosterVersion) || standing.rosterVersion < 1 ||
          [standing.played, standing.wins, standing.losses, standing.scoreFor, standing.scoreAgainst].some(value => !Number.isSafeInteger(value) || value < 0) ||
          !Number.isSafeInteger(standing.scoreDifferential) || standing.played !== standing.wins + standing.losses ||
          standing.scoreDifferential !== standing.scoreFor - standing.scoreAgainst ||
          (standing.qualified && standing.ineligibilityReason !== null) ||
          (standing.ineligibilityReason !== null && (standing.ineligibilityReason.trim() === "" || standing.ineligibilityReason !== standing.ineligibilityReason.trim())) ||
          (!standing.qualified && standing.rank <= grouping.qualifiersPerGroup! && standing.ineligibilityReason === null) ||
          (standing.qualified ? standing.rank > grouping.qualifiersPerGroup! || standing.qualificationOrder !== expectedOrder
            : standing.qualificationOrder !== null)) {
        fail("A progressive frozen standing is malformed.", { standingId: standing.id });
      }
      if (standing.qualified && qualifiedEntries.has(standing.entryId)) fail("An Entry qualifies from more than one group.");
      if (standing.qualified) qualifiedEntries.add(standing.entryId);
      standingIds.add(standing.id); entries.add(standing.entryId); ranks.add(standing.rank);
    }
  }
  const fixturesById = new Map<string, FixtureRow>();
  const fixtureByKey = new Map<string, FixtureRow>();
  for (const fixture of graph.fixtures) {
    if (fixture.matchId !== match.id || fixture.stage !== "KNOCKOUT" || fixture.groupId !== null || fixture.groupKey !== null ||
        fixturesById.has(fixture.id) || fixtureByKey.has(fixture.fixtureKey)) fail("A progressive fixture has invalid identity.", { fixtureId: fixture.id });
    const metadata = fixture.metadata;
    const keys = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Object.keys(metadata).filter(key => key !== "v2Display").sort().join("|") : "";
    const expectedKeys = ["publication", "schemaVersion", "bracketPolicyVersion", "groupingId", "layoutFingerprint", "publishedAt", "roundNumber", "position",
      ...(schedule.bracketPolicyVersion === 3 ? ["qualificationOrderBySlot"] : [])].sort().join("|");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || keys !== expectedKeys ||
        metadata.publication !== "V2_PROGRESSIVE_KNOCKOUT_BRACKET" || metadata.schemaVersion !== 1 ||
        metadata.bracketPolicyVersion !== schedule.bracketPolicyVersion || metadata.groupingId !== grouping.id ||
        metadata.layoutFingerprint !== schedule.layoutFingerprint || metadata.publishedAt !== schedule.createdAt.toISOString() ||
        metadata.roundNumber !== fixture.roundNumber || metadata.position !== fixture.position ||
        (schedule.bracketPolicyVersion === 3 && (!Array.isArray(metadata.qualificationOrderBySlot) ||
          metadata.qualificationOrderBySlot.length !== qualificationOrderBySlot!.length ||
          Array.from(metadata.qualificationOrderBySlot).some((order, index) => order !== qualificationOrderBySlot![index]))) ||
        parseV2SingleGroupTableLabelsFromMetadata(metadata) === null) {
      fail("A progressive fixture has inconsistent publication metadata.", { fixtureId: fixture.id });
    }
    assertActiveRevisionShape(fixture);
    fixturesById.set(fixture.id, fixture); fixtureByKey.set(fixture.fixtureKey, fixture);
  }
  const dependencyByTargetSide = new Map<string, DependencyRow>();
  const winnerDependencyBySource = new Map<string, DependencyRow>();
  for (const dependency of graph.dependencies) {
    const key = sideKey(dependency.targetFixtureId, dependency.targetSide);
    if (dependency.matchId !== match.id || !fixturesById.has(dependency.targetFixtureId) || dependencyByTargetSide.has(key) ||
        (dependency.targetSide !== "SIDE_A" && dependency.targetSide !== "SIDE_B") || dependency.sourceQualificationStandingId !== null) {
      fail("A progressive dependency has invalid identity or an unsupported standing source.", { dependencyId: dependency.id });
    }
    dependencyByTargetSide.set(key, dependency);
    if (dependency.sourceFixtureId !== null) {
      if (dependency.sourceOutcome !== "WINNER" || dependency.sourceGroupId != null || dependency.sourceGroupRank != null ||
          !fixturesById.has(dependency.sourceFixtureId) || winnerDependencyBySource.has(dependency.sourceFixtureId)) {
        fail("A progressive winner edge has conflicting sources.", { dependencyId: dependency.id });
      }
      winnerDependencyBySource.set(dependency.sourceFixtureId, dependency);
    } else if (dependency.sourceGroupId == null || dependency.sourceGroupRank == null || dependency.sourceOutcome !== null) {
      fail("A progressive first-round dependency has no complete group/rank source.", { dependencyId: dependency.id });
    }
  }
  const rosterByVersion = new Map<string, RosterMemberRow[]>();
  const rosterMemberIds = new Set<string>();
  for (const member of graph.rosterMembers) {
    if (rosterMemberIds.has(member.id) || !Number.isSafeInteger(member.rosterVersion) || member.rosterVersion < 1 || !Number.isSafeInteger(member.slot) || member.slot < 1) fail("A progressive frozen roster member has malformed identity.");
    rosterMemberIds.add(member.id);
    const key = `${member.entryId}\u0000${member.rosterVersion}`;
    rosterByVersion.set(key, [...(rosterByVersion.get(key) ?? []), member]);
  }
  for (const members of rosterByVersion.values()) {
    if ([...members].sort((a,b) => a.slot-b.slot).some((member,index) => member.slot !== index+1)) fail("A progressive frozen roster has incomplete slots.");
  }
  for (const expected of plan.fixtures) {
    const fixture = fixtureByKey.get(expected.fixtureKey);
    if (!fixture || fixture.roundNumber !== expected.roundNumber || fixture.position !== expected.position) fail("A progressive fixture is missing or misplaced.", { fixtureKey: expected.fixtureKey });
    for (const [side, source] of [["SIDE_A", expected.sideA], ["SIDE_B", expected.sideB]] as const) {
      const dependency = dependencyByTargetSide.get(sideKey(fixture.id, side));
      if (!dependency) fail("A progressive fixture side has no feeder.", { fixtureId: fixture.id, side });
      if (source.kind === "GROUP_RANK"
        ? dependency.sourceGroupId !== source.groupId || dependency.sourceGroupRank !== source.rank || dependency.sourceFixtureId !== null
        : dependency.sourceFixtureId !== fixtureByKey.get(source.fixtureKey)?.id || dependency.sourceGroupId != null || dependency.sourceGroupRank != null) {
        fail("A progressive dependency differs from the fixed layout.", { dependencyId: dependency.id });
      }
      const value = progressiveSourceValue(graph, dependency);
      const actual = sideValues(fixture, side);
      const ignored = dependency.sourceFixtureId === options.ignoredWinnerSourceId;
      const refreshable = options.allowRefreshSources && fixture.startedAt === null && fixture.resultRevisions.length === 0 &&
        (fixture.status === "SCHEDULED" || fixture.status === "READY");
      if (!ignored && !refreshable && (actual.entryId !== value.entryId ||
          (value.rosterVersion === null ? actual.rosterVersion !== null : (actual.rosterVersion ?? 0) < value.rosterVersion))) {
        fail("A progressive fixture side differs from its authoritative source.", { fixtureId: fixture.id, side });
      }
      // Even during an atomic refresh, any existing participant must have a complete frozen lineup.
      if (!ignored) assertExactLineup(fixture, side, actual.entryId, actual.rosterVersion,
        actual.entryId === null || actual.rosterVersion === null ? null : rosterByVersion.get(`${actual.entryId}\u0000${actual.rosterVersion}`) ?? null);
    }
    const bothSides = fixture.sideAEntryId !== null && fixture.sideBEntryId !== null;
    if ((fixture.sideAEntryId !== null && fixture.sideAEntryId === fixture.sideBEntryId) ||
        (fixture.status === "READY" && !bothSides) || (fixture.status === "SCHEDULED" && bothSides) ||
        (fixture.status === "COMPLETED" && (!bothSides || fixture.completedAt === null)) ||
        (fixture.status === "VOIDED" && fixture.completedAt === null) ||
        ((fixture.status === "READY" || fixture.status === "SCHEDULED") && fixture.completedAt !== null)) {
      fail("A progressive fixture has an impossible lifecycle state.", { fixtureId: fixture.id });
    }
    if (fixture.administrativeResolution && ["SIDE_A", "SIDE_B"].some(side =>
      !progressiveSourceValue(graph, dependencyByTargetSide.get(sideKey(fixture.id, side as Side))!).known)) {
      fail("An unknown progressive source cannot be resolved as a bye or no-contest.", { fixtureId: fixture.id });
    }
  }
  const finalFixture = fixtureByKey.get(`knockout:r${String(plan.roundCount).padStart(4, "0")}:m0001`);
  if (!finalFixture || winnerDependencyBySource.has(finalFixture.id) || winnerDependencyBySource.size !== graph.fixtures.length - 1) fail("A progressive bracket has no unique terminal final.");
  return { graph, fixturesById, fixtureByKey, dependencyByTargetSide, winnerDependencyBySource, finalFixture };
}

export async function loadV2ProgressiveKnockoutGraph(tx: ResultSettlementTransaction, match: V2KnockoutMatchContext): Promise<V2ProgressiveKnockoutGraph> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "match_fixture" WHERE "match_id" = ${match.id} AND "stage" = 'KNOCKOUT' ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "match_fixture_dependency" WHERE "match_id" = ${match.id} ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT revision."id" FROM "result_revision" AS revision INNER JOIN "match_fixture" AS fixture ON fixture."id" = revision."fixture_id" WHERE fixture."match_id" = ${match.id} AND fixture."stage" = 'KNOCKOUT' ORDER BY revision."id" FOR UPDATE OF revision`);
  const [grouping, schedule, groups, fixtures, dependencies, rosterMembers, legacy] = await Promise.all([
    tx.matchGrouping.findUnique({ where: { matchId: match.id }, select: { id: true, matchId: true, v2SchemaVersion: true, standingsPolicyVersion: true, qualifiersPerGroup: true, bracketPolicyVersion: true } }),
    tx.matchKnockoutSchedule.findUnique({ where: { matchId: match.id } }),
    tx.matchGroup.findMany({ where: { matchId: match.id }, orderBy: { position: "asc" }, include: { entries: { select: { entryId: true } }, qualificationSnapshot: { include: { standings: true } } } }),
    tx.matchFixture.findMany({ where: { matchId: match.id, stage: "KNOCKOUT" }, orderBy: [{ roundNumber: "asc" }, { position: "asc" }], include: { lineupMembers: true, resultRevisions: true, administrativeResolution: true } }),
    tx.matchFixtureDependency.findMany({ where: { matchId: match.id }, orderBy: { id: "asc" } }),
    tx.matchEntryMember.findMany({ where: { matchId: match.id }, orderBy: [{ entryId: "asc" }, { rosterVersion: "asc" }, { slot: "asc" }], select: { id: true, entryId: true, rosterVersion: true, slot: true } }),
    tx.matchQualificationSnapshot.findFirst({ where: { matchId: match.id }, select: { id: true } }),
  ]);
  if (!grouping || !schedule || legacy) fail("A progressive graph has missing or conflicting publication authority.", { matchId: match.id });
  return { match, grouping, schedule, groups, fixtures, dependencies, rosterMembers };
}

export async function loadAndValidateV2ProgressiveKnockoutGraph(tx: ResultSettlementTransaction, match: V2KnockoutMatchContext, ignoredWinnerSourceId?: string) {
  return validateV2ProgressiveKnockoutGraph(await loadV2ProgressiveKnockoutGraph(tx, match), { ignoredWinnerSourceId });
}

/** Runs inside the caller's Match mutex and SERIALIZABLE transaction. */
export async function reconcileV2ProgressiveKnockoutInTransaction(
  tx: ResultSettlementTransaction,
  matchId: string,
  options: Readonly<{ actorId: string; clock?: () => Date }>,
) {
  if (!await tx.matchKnockoutSchedule?.findUnique({ where: { matchId }, select: { id: true } })) return;
  const match = await tx.match.findUnique({ where: { id: matchId }, select: { id: true, engineVersion: true, isQuickMatch: true, status: true, format: true } });
  if (!match) fail("The progressive Match no longer exists.", { matchId });
  let graph = await loadV2ProgressiveKnockoutGraph(tx, match);
  validateV2ProgressiveKnockoutGraph(graph, { allowRefreshSources: true });
  const now = (options.clock ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime()) || options.actorId.trim() === "") fail("Progressive reconciliation needs a valid actor and clock.");
  const availability = new Map((await tx.matchEntry.findMany({ where: { matchId }, select: {
    id: true, status: true, members: { select: { rosterVersion: true, user: { select: { isBanned: true, emailVerifiedAt: true } } } },
  } })).map(entry => [entry.id, entry]));
  const sideIsAvailable = (entryId: string | null, rosterVersion: number | null) => {
    if (entryId === null || rosterVersion === null) return false;
    const entry = availability.get(entryId);
    const members = entry?.members.filter(member => member.rosterVersion === rosterVersion) ?? [];
    return entry?.status === "ACTIVE" && members.length > 0 && members.every(member => !member.user.isBanned && member.user.emailVerifiedAt !== null);
  };
  for (const original of graph.fixtures) {
    let fixture = graph.fixtures.find(item => item.id === original.id)!;
    const incoming = graph.dependencies.filter(dependency => dependency.targetFixtureId === fixture.id);
    const values = new Map(incoming.map(dependency => [dependency.targetSide, progressiveSourceValue(graph, dependency)]));
    if (fixture.status === "SCHEDULED" || fixture.status === "READY") {
      for (const side of ["SIDE_A", "SIDE_B"] as const) {
        const expected = values.get(side)!;
        const actual = sideValues(fixture, side);
        if (actual.entryId === expected.entryId && (expected.rosterVersion === null ? actual.rosterVersion === null : (actual.rosterVersion ?? 0) >= expected.rosterVersion)) continue;
        if (fixture.startedAt !== null || fixture.resultRevisions.length !== 0) fail("A progressed progressive fixture cannot rebind a source.", { fixtureId: fixture.id });
        let rosterVersion = expected.rosterVersion;
        let members = graph.rosterMembers.filter(member => member.entryId === expected.entryId && member.rosterVersion === rosterVersion);
        if (expected.entryId !== null) {
          const latest = await tx.matchEntryMember.findMany({ where: { matchId, entryId: expected.entryId, status: "ACTIVE", effectiveUntil: null }, orderBy: { slot: "asc" }, select: { id: true, entryId: true, rosterVersion: true, slot: true } });
          if (latest.length && latest.every(member => member.rosterVersion === latest[0].rosterVersion) && latest[0].rosterVersion >= rosterVersion!) {
            rosterVersion = latest[0].rosterVersion; members = latest;
          }
          if (members.length === 0) fail("A progressive qualifier has no admitted frozen lineup.", { fixtureId: fixture.id });
        }
        await tx.matchFixtureLineupMember.deleteMany({ where: { matchId, fixtureId: fixture.id, side } });
        const data = side === "SIDE_A" ? { sideAEntryId: expected.entryId, sideARosterVersion: rosterVersion } : { sideBEntryId: expected.entryId, sideBRosterVersion: rosterVersion };
        const both = side === "SIDE_A" ? expected.entryId !== null && fixture.sideBEntryId !== null : expected.entryId !== null && fixture.sideAEntryId !== null;
        const status = both ? "READY" as const : "SCHEDULED" as const;
        const updated = await tx.matchFixture.updateMany({ where: { id: fixture.id, matchId, version: fixture.version }, data: { ...data, status, version: { increment: 1 } } });
        if (updated.count !== 1) fail("A progressive target changed during participant reconciliation.", { fixtureId: fixture.id });
        const lineup = members.sort((a, b) => a.slot - b.slot).map((member, index) => ({ matchId, fixtureId: fixture.id, entryId: expected.entryId!, entryMemberId: member.id, side, position: index + 1 }));
        if (lineup.length) await tx.matchFixtureLineupMember.createMany({ data: lineup });
        fixture = { ...fixture, ...data, status, version: fixture.version + 1, lineupMembers: [...fixture.lineupMembers.filter(member => member.side !== side), ...lineup.map((member, index) => ({ ...member, id: `reconciled:${fixture.id}:${side}:${index}` }))] };
      }
      // A still-unknown group is never a bye. Only two terminal sources can close an empty fixture.
      if (values.get("SIDE_A")!.known && values.get("SIDE_B")!.known &&
          (fixture.sideAEntryId === null || fixture.sideBEntryId === null) && fixture.startedAt === null && fixture.resultRevisions.length === 0) {
        const populatedEntryId = fixture.sideAEntryId ?? fixture.sideBEntryId;
        const populatedRosterVersion = fixture.sideAEntryId !== null ? fixture.sideARosterVersion : fixture.sideBRosterVersion;
        const entryId = sideIsAvailable(populatedEntryId, populatedRosterVersion) ? populatedEntryId : null;
        const rosterVersion = entryId === null ? null : populatedRosterVersion;
        const kind = entryId === null ? "NO_CONTEST" as const : "ADMIN_BYE" as const;
        const resolution = await tx.matchFixtureAdministrativeResolution.create({ data: { matchId, fixtureId: fixture.id, kind, advancingEntryId: entryId, advancingRosterVersion: rosterVersion, resolvedById: options.actorId, reason: "小组晋级名额已确认，按既定签表处理空缺" } });
        const updated = await tx.matchFixture.updateMany({ where: { id: fixture.id, matchId, version: fixture.version, status: fixture.status }, data: { status: "VOIDED", completedAt: now, version: { increment: 1 } } });
        if (updated.count !== 1) fail("A progressive empty fixture changed during resolution.", { fixtureId: fixture.id });
        await tx.auditLog.create({ data: { actorId: options.actorId, action: "v2_progressive_knockout_empty_source", entityType: "MatchFixtureAdministrativeResolution", entityId: resolution.id, details: { matchId, fixtureId: fixture.id, kind, advancingEntryId: entryId, settlement: "NONE" } } });
        fixture = { ...fixture, status: "VOIDED", completedAt: now, version: fixture.version + 1, administrativeResolution: resolution };
      }
      graph = { ...graph, fixtures: graph.fixtures.map(item => item.id === fixture.id ? fixture : item) };
    }
  }
  // Read persisted lineups again; temporary in-memory ids are never exposed as authority.
  graph = await loadV2ProgressiveKnockoutGraph(tx, match);
  const validated = validateV2ProgressiveKnockoutGraph(graph);
  if ((validated.finalFixture.status === "COMPLETED" || validated.finalFixture.status === "VOIDED") &&
      graph.groups.every(group => group.qualificationSnapshot !== null) && graph.fixtures.every(fixture =>
        (fixture.status === "COMPLETED" || fixture.status === "VOIDED") && !fixture.resultRevisions.some(revision => revision.status === "PENDING"))) {
    await tx.match.updateMany({ where: { id: matchId, status: "ongoing", engineVersion: "V2", format: "group_then_knockout" }, data: { status: "finished" } });
  }
}
