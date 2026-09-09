import type { Prisma } from "@prisma/client";

export type V2MatchCompletionTransaction = Pick<
  Prisma.TransactionClient,
  "match" | "matchFixture"
>;

export type LockedV2MatchCompletionContext = Readonly<{
  id: string;
  engineVersion: "LEGACY" | "V2";
  isQuickMatch: boolean;
  type: "single" | "double" | "team";
  status: "registration" | "ongoing" | "finished";
  format: "group_only" | "group_then_knockout";
}>;

function fixturePairKey(leftEntryId: string, rightEntryId: string) {
  return leftEntryId < rightEntryId
    ? `${leftEntryId}\u0000${rightEntryId}`
    : `${rightEntryId}\u0000${leftEntryId}`;
}

async function hasCompleteRelationalGroupOnlyTopology(
  tx: V2MatchCompletionTransaction,
  matchId: string,
) {
  const persisted = await tx.match.findUnique({
    where: { id: matchId },
    select: {
      groupingGeneratedAt: true,
      groupingResult: {
        select: {
          createdAt: true,
          v2SchemaVersion: true,
          seedMethod: true,
          standingsPolicyVersion: true,
          qualifiersPerGroup: true,
          bracketPolicyVersion: true,
          groups: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              groupKey: true,
              position: true,
              entries: {
                orderBy: { position: "asc" },
                select: { entryId: true, position: true },
              },
            },
          },
        },
      },
      fixtures: {
        select: {
          id: true,
          stage: true,
          status: true,
          groupId: true,
          groupKey: true,
          sideAEntryId: true,
          sideBEntryId: true,
        },
      },
    },
  });
  const grouping = persisted?.groupingResult;
  if (
    !grouping ||
    persisted.groupingGeneratedAt === null ||
    grouping.createdAt.getTime() !== persisted.groupingGeneratedAt.getTime() ||
    grouping.v2SchemaVersion !== 1 ||
    grouping.seedMethod === null ||
    grouping.standingsPolicyVersion !== 1 ||
    grouping.qualifiersPerGroup !== null ||
    grouping.bracketPolicyVersion !== null ||
    grouping.groups.length === 0
  ) {
    return false;
  }

  const groupsById = new Map<
    string,
    { groupKey: string; entryIds: Set<string>; expectedPairs: Set<string> }
  >();
  const allEntryIds = new Set<string>();
  let expectedFixtureCount = 0;
  for (let groupIndex = 0; groupIndex < grouping.groups.length; groupIndex += 1) {
    const group = grouping.groups[groupIndex];
    if (group.position !== groupIndex + 1 || group.entries.length < 2) return false;
    const entryIds = new Set<string>();
    for (let entryIndex = 0; entryIndex < group.entries.length; entryIndex += 1) {
      const membership = group.entries[entryIndex];
      if (
        membership.position !== entryIndex + 1 ||
        entryIds.has(membership.entryId) ||
        allEntryIds.has(membership.entryId)
      ) {
        return false;
      }
      entryIds.add(membership.entryId);
      allEntryIds.add(membership.entryId);
    }
    const entries = [...entryIds];
    const expectedPairs = new Set<string>();
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        expectedPairs.add(fixturePairKey(entries[left], entries[right]));
      }
    }
    expectedFixtureCount += expectedPairs.size;
    groupsById.set(group.id, {
      groupKey: group.groupKey,
      entryIds,
      expectedPairs,
    });
  }
  if (persisted.fixtures.length !== expectedFixtureCount) return false;

  const fixtureIds = new Set<string>();
  const actualPairsByGroup = new Map<string, Set<string>>();
  for (const fixture of persisted.fixtures) {
    if (
      fixtureIds.has(fixture.id) ||
      fixture.stage !== "GROUP" ||
      (fixture.status !== "COMPLETED" && fixture.status !== "VOIDED") ||
      fixture.groupId === null ||
      fixture.sideAEntryId === null ||
      fixture.sideBEntryId === null ||
      fixture.sideAEntryId === fixture.sideBEntryId
    ) {
      return false;
    }
    fixtureIds.add(fixture.id);
    const group = groupsById.get(fixture.groupId);
    if (
      !group ||
      fixture.groupKey !== group.groupKey ||
      !group.entryIds.has(fixture.sideAEntryId) ||
      !group.entryIds.has(fixture.sideBEntryId)
    ) {
      return false;
    }
    const pair = fixturePairKey(fixture.sideAEntryId, fixture.sideBEntryId);
    const actualPairs = actualPairsByGroup.get(fixture.groupId) ?? new Set<string>();
    if (!group.expectedPairs.has(pair) || actualPairs.has(pair)) return false;
    actualPairs.add(pair);
    actualPairsByGroup.set(fixture.groupId, actualPairs);
  }
  return [...groupsById].every(
    ([groupId, group]) =>
      actualPairsByGroup.get(groupId)?.size === group.expectedPairs.size,
  );
}

/**
 * Projects fixture terminal state onto a formal V2 group_only match after its
 * complete fixture set has reached a terminal state. Entry kind does not
 * change this projection: SINGLE, DOUBLE, and TEAM all use the same fixture
 * lifecycle and Match status CAS.
 *
 * The caller must already hold the Match row lock. This helper deliberately
 * takes no locks of its own, so inserting it after a fixture write cannot
 * reverse the application's Match -> Fixture lock order.
 */
export async function finishV2GroupOnlyMatchIfTerminal(
  tx: V2MatchCompletionTransaction,
  match: LockedV2MatchCompletionContext,
): Promise<boolean> {
  if (
    match.engineVersion !== "V2" ||
    match.isQuickMatch ||
    match.format !== "group_only" ||
    match.status !== "ongoing"
  ) {
    return false;
  }

  const fixtureCount = await tx.matchFixture.count({
    where: { matchId: match.id },
  });
  if (fixtureCount === 0) return false;

  const nonTerminalFixtureCount = await tx.matchFixture.count({
    where: {
      matchId: match.id,
      status: { notIn: ["COMPLETED", "VOIDED"] },
    },
  });
  if (nonTerminalFixtureCount !== 0) return false;

  if (!(await hasCompleteRelationalGroupOnlyTopology(tx, match.id))) {
    return false;
  }

  const updated = await tx.match.updateMany({
    where: {
      id: match.id,
      engineVersion: "V2",
      isQuickMatch: false,
      type: match.type,
      format: "group_only",
      status: "ongoing",
    },
    data: { status: "finished" },
  });
  return updated.count === 1;
}

/**
 * Backwards-compatible export for existing SINGLE callers. The implementation
 * is intentionally generic so DOUBLE and TEAM callers cannot silently skip
 * completion once their result adapters are enabled.
 */
export const finishV2SingleGroupOnlyMatchIfTerminal =
  finishV2GroupOnlyMatchIfTerminal;
