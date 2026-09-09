import { Prisma } from "@prisma/client";

import {
  buildV2KnockoutBracket,
  V2KnockoutBracketError,
} from "../domain/knockout-bracket";
import { parseV2SingleGroupTableLabelsFromMetadata } from "../domain/group-fixture-metadata";
import { V2ResultApplicationError } from "./results-errors";
import type { ResultSettlementTransaction } from "./settlements";

const KNOCKOUT_PUBLICATION = "V2_KNOCKOUT_BRACKET";
const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_POLICY_VERSION = 1;
const MAX_KNOCKOUT_FIXTURES = 1_023;
const MAX_QUALIFICATION_STANDINGS = 1_024;
const MAX_FROZEN_ROSTER_MEMBERS = 51_200;

type FixtureStatus = "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
type FixtureSide = "SIDE_A" | "SIDE_B";

export type V2KnockoutMatchContext = Readonly<{
  id: string;
  engineVersion: "LEGACY" | "V2";
  isQuickMatch: boolean;
  status: "registration" | "ongoing" | "finished";
  format: "group_only" | "group_then_knockout";
}>;

type GroupingRow = Readonly<{
  id: string;
  matchId: string;
  v2SchemaVersion: number | null;
  standingsPolicyVersion: number | null;
  qualifiersPerGroup: number | null;
  bracketPolicyVersion: number | null;
  groupCount: number;
}>;

type SnapshotRow = Readonly<{
  id: string;
  matchId: string;
  groupingId: string;
  schemaVersion: number;
  standingsPolicyVersion: number;
  sourceRevisionFingerprint: string;
}>;

type StandingRow = Readonly<{
  id: string;
  matchId: string;
  snapshotId: string;
  entryId: string;
  qualified: boolean;
  qualificationOrder: number | null;
  groupEntry: Readonly<{ rosterVersion: number }>;
}>;

type FixtureLineupRow = Readonly<{
  id: string;
  entryId: string;
  entryMemberId: string;
  side: FixtureSide;
  position: number;
}>;

type RevisionRow = Readonly<{
  id: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED";
  winnerEntryId: string | null;
  loserEntryId: string | null;
  supersedesRevisionId: string | null;
}>;

export type V2KnockoutAdministrativeResolutionRow = Readonly<{
  id: string;
  matchId: string;
  fixtureId: string;
  kind: "NO_CONTEST" | "ADMIN_BYE";
  advancingEntryId: string | null;
  advancingRosterVersion: number | null;
  resolvedById: string;
  reason: string;
  createdAt: Date;
}>;

type FixtureRow = Readonly<{
  id: string;
  matchId: string;
  fixtureKey: string;
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
  status: FixtureStatus;
  groupId: string | null;
  groupKey: string | null;
  roundNumber: number | null;
  position: number | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  sideARosterVersion: number | null;
  sideBRosterVersion: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  version: number;
  metadata: Prisma.JsonValue | null;
  lineupMembers: readonly FixtureLineupRow[];
  resultRevisions: readonly RevisionRow[];
  administrativeResolution?: V2KnockoutAdministrativeResolutionRow | null;
}>;

type DependencyRow = Readonly<{
  id: string;
  matchId: string;
  sourceFixtureId: string | null;
  sourceOutcome: "WINNER" | "LOSER" | null;
  sourceQualificationStandingId: string | null;
  targetFixtureId: string;
  targetSide: FixtureSide;
}>;

type RosterMemberRow = Readonly<{
  id: string;
  entryId: string;
  rosterVersion: number;
  slot: number;
}>;

export type V2KnockoutGraphSnapshot = Readonly<{
  match: V2KnockoutMatchContext;
  grouping: GroupingRow;
  snapshot: SnapshotRow;
  standings: readonly StandingRow[];
  fixtures: readonly FixtureRow[];
  dependencies: readonly DependencyRow[];
  rosterMembers: readonly RosterMemberRow[];
}>;

type ValidatedGraph = Readonly<{
  graph: V2KnockoutGraphSnapshot;
  fixturesById: ReadonlyMap<string, FixtureRow>;
  fixtureByKey: ReadonlyMap<string, FixtureRow>;
  dependencyByTargetSide: ReadonlyMap<string, DependencyRow>;
  winnerDependencyBySource: ReadonlyMap<string, DependencyRow>;
  finalFixture: FixtureRow;
}>;

function fail(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2ResultApplicationError(
    "AGGREGATE_INVARIANT_VIOLATION",
    message,
    details,
  );
}

function targetSideKey(fixtureId: string, side: FixtureSide) {
  return `${fixtureId}\u0000${side}`;
}

function sideValues(fixture: FixtureRow, side: FixtureSide) {
  return side === "SIDE_A"
    ? {
        entryId: fixture.sideAEntryId,
        rosterVersion: fixture.sideARosterVersion,
      }
    : {
        entryId: fixture.sideBEntryId,
        rosterVersion: fixture.sideBRosterVersion,
      };
}

function currentConfirmedRevision(fixture: FixtureRow) {
  const confirmed = fixture.resultRevisions.filter(
    (revision) => revision.status === "CONFIRMED",
  );
  if (confirmed.length > 1) {
    fail("A knockout fixture has more than one current confirmed result.", {
      fixtureId: fixture.id,
    });
  }
  return confirmed[0] ?? null;
}

function pendingCorrection(fixture: FixtureRow) {
  return fixture.resultRevisions.find(
    (revision) =>
      revision.status === "PENDING" && revision.supersedesRevisionId !== null,
  );
}

function correctionKeepsOrSwapsParticipants(
  pending: RevisionRow,
  confirmed: RevisionRow,
) {
  return (
    (pending.winnerEntryId === confirmed.winnerEntryId &&
      pending.loserEntryId === confirmed.loserEntryId) ||
    (pending.winnerEntryId === confirmed.loserEntryId &&
      pending.loserEntryId === confirmed.winnerEntryId)
  );
}

function revisionHasExactParticipants(
  fixture: FixtureRow,
  revision: RevisionRow,
) {
  return (
    fixture.sideAEntryId !== null &&
    fixture.sideBEntryId !== null &&
    revision.winnerEntryId !== null &&
    revision.loserEntryId !== null &&
    revision.winnerEntryId !== revision.loserEntryId &&
    new Set([revision.winnerEntryId, revision.loserEntryId]).size === 2 &&
    [revision.winnerEntryId, revision.loserEntryId].every(
      (entryId) =>
        entryId === fixture.sideAEntryId || entryId === fixture.sideBEntryId,
    )
  );
}

function assertActiveRevisionShape(fixture: FixtureRow) {
  const pending = fixture.resultRevisions.filter(
    (revision) => revision.status === "PENDING",
  );
  const confirmed = fixture.resultRevisions.filter(
    (revision) => revision.status === "CONFIRMED",
  );
  if (pending.length > 1 || confirmed.length > 1) {
    fail("A knockout fixture has duplicate active result revisions.", {
      fixtureId: fixture.id,
      pendingCount: pending.length,
      confirmedCount: confirmed.length,
    });
  }
  if (
    [...pending, ...confirmed].some(
      (revision) => !revisionHasExactParticipants(fixture, revision),
    )
  ) {
    fail("An active knockout result does not exactly match both fixture sides.", {
      fixtureId: fixture.id,
    });
  }

  const currentPending = pending[0] ?? null;
  const currentConfirmed = confirmed[0] ?? null;
  const administrative = fixture.administrativeResolution ?? null;
  if (fixture.status === "SCHEDULED") {
    if (
      currentPending !== null ||
      currentConfirmed !== null ||
      administrative !== null
    ) {
      fail("A scheduled knockout fixture cannot have an active result.", {
        fixtureId: fixture.id,
      });
    }
    return;
  }
  if (fixture.status === "READY") {
    if (
      currentConfirmed !== null ||
      administrative !== null ||
      (currentPending !== null && currentPending.supersedesRevisionId !== null)
    ) {
      fail("A ready knockout fixture may have only one initial pending result.", {
        fixtureId: fixture.id,
      });
    }
    return;
  }
  if (fixture.status === "COMPLETED") {
    if (
      currentConfirmed === null ||
      administrative !== null ||
      (currentPending !== null &&
        (currentPending.supersedesRevisionId !== currentConfirmed.id ||
          !correctionKeepsOrSwapsParticipants(
            currentPending,
            currentConfirmed,
          )))
    ) {
      fail(
        "A completed knockout fixture requires one confirmed result and at most its exact pending correction.",
        { fixtureId: fixture.id },
      );
    }
    return;
  }
  if (
    administrative === null ||
    administrative.fixtureId !== fixture.id ||
    administrative.matchId !== fixture.matchId ||
    currentPending !== null ||
    currentConfirmed !== null ||
    administrative.reason.trim() === "" ||
    administrative.reason !== administrative.reason.trim() ||
    administrative.reason.length > 500
  ) {
    fail("A voided knockout fixture requires one valid administrative resolution.", {
      fixtureId: fixture.id,
    });
  }
  if (
    administrative.kind === "NO_CONTEST" &&
    (administrative.advancingEntryId !== null ||
      administrative.advancingRosterVersion !== null)
  ) {
    fail("A NO_CONTEST fixture cannot advance an Entry.", {
      fixtureId: fixture.id,
    });
  }
  if (administrative.kind === "ADMIN_BYE") {
    const populatedSides = [
      {
        entryId: fixture.sideAEntryId,
        rosterVersion: fixture.sideARosterVersion,
      },
      {
        entryId: fixture.sideBEntryId,
        rosterVersion: fixture.sideBRosterVersion,
      },
    ].filter((side) => side.entryId !== null || side.rosterVersion !== null);
    if (
      populatedSides.length !== 1 ||
      populatedSides[0].entryId !== administrative.advancingEntryId ||
      populatedSides[0].rosterVersion !== administrative.advancingRosterVersion
    ) {
      fail("An ADMIN_BYE must advance the fixture's only populated side.", {
        fixtureId: fixture.id,
      });
    }
  }
}

function authoritativeAdvancement(fixture: FixtureRow) {
  const confirmed = currentConfirmedRevision(fixture);
  if (confirmed !== null) {
    return {
      entryId: confirmed.winnerEntryId,
      rosterVersion:
        confirmed.winnerEntryId === fixture.sideAEntryId
          ? fixture.sideARosterVersion
          : confirmed.winnerEntryId === fixture.sideBEntryId
            ? fixture.sideBRosterVersion
            : null,
    };
  }
  const administrative = fixture.administrativeResolution ?? null;
  if (administrative?.kind === "ADMIN_BYE") {
    return {
      entryId: administrative.advancingEntryId,
      rosterVersion: administrative.advancingRosterVersion,
    };
  }
  return { entryId: null, rosterVersion: null };
}

function assertFixtureMetadata(
  fixture: FixtureRow,
  snapshot: SnapshotRow,
  sharedPublishedAt: { value: string | null },
) {
  const metadata = fixture.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("A knockout fixture has no supported publication metadata.", {
      fixtureId: fixture.id,
    });
  }
  const expectedKeys = [
    "bracketPolicyVersion",
    "position",
    "publication",
    "publishedAt",
    "qualificationSnapshotId",
    "roundNumber",
    "schemaVersion",
    "sourceRevisionFingerprint",
  ].sort();
  const keys = Object.keys(metadata)
    .filter((key) => key !== "v2Display")
    .sort();
  const publishedAt = metadata.publishedAt;
  const tableLabels = parseV2SingleGroupTableLabelsFromMetadata(metadata);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    metadata.publication !== KNOCKOUT_PUBLICATION ||
    metadata.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
    metadata.bracketPolicyVersion !== SUPPORTED_POLICY_VERSION ||
    metadata.qualificationSnapshotId !== snapshot.id ||
    metadata.sourceRevisionFingerprint !== snapshot.sourceRevisionFingerprint ||
    metadata.roundNumber !== fixture.roundNumber ||
    metadata.position !== fixture.position ||
    typeof publishedAt !== "string" ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    tableLabels === null
  ) {
    fail("A knockout fixture's publication metadata is inconsistent.", {
      fixtureId: fixture.id,
    });
  }
  if (sharedPublishedAt.value === null) sharedPublishedAt.value = publishedAt;
  if (sharedPublishedAt.value !== publishedAt) {
    fail("Knockout fixtures were not published as one atomic bracket.", {
      fixtureId: fixture.id,
    });
  }
}

function assertExactLineup(
  fixture: FixtureRow,
  side: FixtureSide,
  entryId: string | null,
  rosterVersion: number | null,
  expectedMembers: readonly RosterMemberRow[] | null,
) {
  const lineup = fixture.lineupMembers
    .filter((member) => member.side === side)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  if (entryId === null || rosterVersion === null) {
    if (entryId !== null || rosterVersion !== null || lineup.length !== 0) {
      fail("An unresolved knockout side has participant or lineup residue.", {
        fixtureId: fixture.id,
        side,
      });
    }
    return;
  }
  if (expectedMembers === null || expectedMembers.length === 0) {
    fail("A resolved knockout side has no frozen roster.", {
      fixtureId: fixture.id,
      side,
      entryId,
      rosterVersion,
    });
  }
  const expected = [...expectedMembers].sort(
    (left, right) => left.slot - right.slot || left.id.localeCompare(right.id),
  );
  if (
    lineup.length !== expected.length ||
    lineup.some(
      (member, index) =>
        member.position !== index + 1 ||
        member.entryId !== entryId ||
        member.entryMemberId !== expected[index].id,
    )
  ) {
    fail("A knockout side lineup does not exactly match its frozen roster.", {
      fixtureId: fixture.id,
      side,
      entryId,
      rosterVersion,
    });
  }
}

/**
 * Validates the immutable bracket topology plus every participant projection.
 * `ignoredWinnerSourceId` is used only inside a correction confirmation: that
 * one target side is allowed to contain the previous winner until it is
 * atomically rebound later in the same transaction.
 */
export function validateV2KnockoutGraph(
  graph: V2KnockoutGraphSnapshot,
  ignoredWinnerSourceId?: string,
): ValidatedGraph {
  if (
    graph.match.engineVersion !== "V2" ||
    graph.match.isQuickMatch ||
    graph.match.format !== "group_then_knockout" ||
    (graph.match.status !== "ongoing" && graph.match.status !== "finished")
  ) {
    fail("Knockout advancement requires a formal V2 group-then-knockout match.", {
      matchId: graph.match.id,
    });
  }
  if (
    graph.grouping.matchId !== graph.match.id ||
    graph.grouping.v2SchemaVersion !== SUPPORTED_SCHEMA_VERSION ||
    graph.grouping.standingsPolicyVersion !== SUPPORTED_POLICY_VERSION ||
    graph.grouping.bracketPolicyVersion !== SUPPORTED_POLICY_VERSION ||
    !Number.isSafeInteger(graph.grouping.qualifiersPerGroup) ||
    (graph.grouping.qualifiersPerGroup ?? 0) < 1 ||
    !Number.isSafeInteger(graph.grouping.groupCount) ||
    graph.grouping.groupCount < 1 ||
    graph.snapshot.matchId !== graph.match.id ||
    graph.snapshot.groupingId !== graph.grouping.id ||
    graph.snapshot.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
    graph.snapshot.standingsPolicyVersion !== SUPPORTED_POLICY_VERSION ||
    !/^[a-f0-9]{64}$/.test(graph.snapshot.sourceRevisionFingerprint)
  ) {
    fail("The knockout bracket is not bound to a supported qualification snapshot.", {
      matchId: graph.match.id,
    });
  }
  if (
    graph.standings.length < 2 ||
    graph.standings.length > MAX_QUALIFICATION_STANDINGS
  ) {
    fail("The qualification snapshot has an unsupported size.", {
      standingCount: graph.standings.length,
    });
  }
  const qualified = graph.standings
    .filter((standing) => standing.qualified)
    .map((standing) => {
      if (
        standing.matchId !== graph.match.id ||
        standing.snapshotId !== graph.snapshot.id ||
        standing.qualificationOrder === null ||
        !Number.isSafeInteger(standing.groupEntry.rosterVersion) ||
        standing.groupEntry.rosterVersion < 1
      ) {
        fail("A qualified standing is not bound to a valid frozen roster.", {
          standingId: standing.id,
        });
      }
      return {
        standingId: standing.id,
        entryId: standing.entryId,
        qualificationOrder: standing.qualificationOrder,
        rosterVersion: standing.groupEntry.rosterVersion,
      };
    });
  if (
    qualified.length !==
    graph.grouping.groupCount * graph.grouping.qualifiersPerGroup!
  ) {
    fail("The frozen qualifier count does not match the grouping policy.", {
      qualificationCount: qualified.length,
      groupCount: graph.grouping.groupCount,
      qualifiersPerGroup: graph.grouping.qualifiersPerGroup,
    });
  }
  if (
    graph.standings.some(
      (standing) =>
        standing.matchId !== graph.match.id ||
        standing.snapshotId !== graph.snapshot.id ||
        standing.qualified !== (standing.qualificationOrder !== null),
    )
  ) {
    fail("Qualification standing identity or decision fields are inconsistent.");
  }

  let plan;
  try {
    plan = buildV2KnockoutBracket(qualified);
  } catch (error) {
    if (error instanceof V2KnockoutBracketError) {
      fail("The qualification snapshot cannot produce a complete knockout bracket.", {
        reason: error.message,
      });
    }
    throw error;
  }
  if (
    graph.fixtures.length !== plan.fixtureCount ||
    graph.fixtures.length > MAX_KNOCKOUT_FIXTURES ||
    graph.dependencies.length !== plan.fixtureCount * 2 ||
    graph.rosterMembers.length > MAX_FROZEN_ROSTER_MEMBERS
  ) {
    fail("The persisted knockout graph has an unexpected row count.", {
      fixtureCount: graph.fixtures.length,
      dependencyCount: graph.dependencies.length,
    });
  }

  const fixturesById = new Map<string, FixtureRow>();
  const fixtureByKey = new Map<string, FixtureRow>();
  const sharedPublishedAt = { value: null as string | null };
  for (const fixture of graph.fixtures) {
    if (
      fixture.matchId !== graph.match.id ||
      fixture.stage !== "KNOCKOUT" ||
      fixture.groupId !== null ||
      fixture.groupKey !== null ||
      fixtureByKey.has(fixture.fixtureKey) ||
      fixturesById.has(fixture.id)
    ) {
      fail("A persisted knockout fixture has an invalid identity or stage.", {
        fixtureId: fixture.id,
      });
    }
    fixtureByKey.set(fixture.fixtureKey, fixture);
    fixturesById.set(fixture.id, fixture);
    assertFixtureMetadata(fixture, graph.snapshot, sharedPublishedAt);
    assertActiveRevisionShape(fixture);
  }
  for (const expected of plan.fixtures) {
    const actual = fixtureByKey.get(expected.fixtureKey);
    if (
      !actual ||
      actual.roundNumber !== expected.roundNumber ||
      actual.position !== expected.position
    ) {
      fail("A planned knockout fixture is missing or misplaced.", {
        fixtureKey: expected.fixtureKey,
      });
    }
  }

  const dependencyByTargetSide = new Map<string, DependencyRow>();
  const winnerDependencyBySource = new Map<string, DependencyRow>();
  for (const dependency of graph.dependencies) {
    const target = fixturesById.get(dependency.targetFixtureId);
    const key = targetSideKey(dependency.targetFixtureId, dependency.targetSide);
    if (
      dependency.matchId !== graph.match.id ||
      !target ||
      dependencyByTargetSide.has(key)
    ) {
      fail("A knockout dependency has an invalid or duplicate target side.", {
        dependencyId: dependency.id,
      });
    }
    dependencyByTargetSide.set(key, dependency);
    if (dependency.sourceFixtureId !== null) {
      if (
        dependency.sourceOutcome !== "WINNER" ||
        dependency.sourceQualificationStandingId !== null ||
        !fixturesById.has(dependency.sourceFixtureId) ||
        winnerDependencyBySource.has(dependency.sourceFixtureId)
      ) {
        fail("Only one WINNER edge may leave a non-final knockout fixture.", {
          dependencyId: dependency.id,
        });
      }
      winnerDependencyBySource.set(dependency.sourceFixtureId, dependency);
    } else if (
      dependency.sourceOutcome !== null ||
      dependency.sourceQualificationStandingId === null
    ) {
      fail("A first-round dependency must have exactly one qualification source.", {
        dependencyId: dependency.id,
      });
    }
  }

  const standingsById = new Map(graph.standings.map((standing) => [standing.id, standing]));
  for (const expected of plan.fixtures) {
    const target = fixtureByKey.get(expected.fixtureKey)!;
    for (const [side, source] of [
      ["SIDE_A", expected.sideA],
      ["SIDE_B", expected.sideB],
    ] as const) {
      const dependency = dependencyByTargetSide.get(targetSideKey(target.id, side));
      if (!dependency) {
        fail("A knockout target side is missing its relational source.", {
          fixtureId: target.id,
          side,
        });
      }
      if (source.kind === "QUALIFIER") {
        const standing = standingsById.get(source.standingId);
        if (
          dependency.sourceQualificationStandingId !== source.standingId ||
          dependency.sourceFixtureId !== null ||
          dependency.sourceOutcome !== null ||
          !standing?.qualified ||
          standing.entryId !== source.entryId
        ) {
          fail("A first-round side is not bound to its planned qualifier.", {
            fixtureId: target.id,
            side,
          });
        }
      } else {
        const sourceFixture = fixtureByKey.get(source.fixtureKey);
        if (
          !sourceFixture ||
          dependency.sourceFixtureId !== sourceFixture.id ||
          dependency.sourceOutcome !== "WINNER" ||
          dependency.sourceQualificationStandingId !== null
        ) {
          fail("A later-round side is not bound to its planned feeder fixture.", {
            fixtureId: target.id,
            side,
          });
        }
      }
    }
  }

  const rosterByEntryVersion = new Map<string, RosterMemberRow[]>();
  for (const member of graph.rosterMembers) {
    const key = `${member.entryId}\u0000${member.rosterVersion}`;
    const members = rosterByEntryVersion.get(key) ?? [];
    members.push(member);
    rosterByEntryVersion.set(key, members);
  }
  const ignoredDependency =
    ignoredWinnerSourceId === undefined
      ? null
      : winnerDependencyBySource.get(ignoredWinnerSourceId) ?? null;
  for (const fixture of graph.fixtures) {
    for (const side of ["SIDE_A", "SIDE_B"] as const) {
      const values = sideValues(fixture, side);
      const dependency = dependencyByTargetSide.get(targetSideKey(fixture.id, side))!;
      let expectedEntryId: string | null = null;
      let expectedRosterVersion: number | null = null;
      if (dependency.sourceQualificationStandingId !== null) {
        const standing = standingsById.get(dependency.sourceQualificationStandingId)!;
        expectedEntryId = standing.entryId;
        expectedRosterVersion = standing.groupEntry.rosterVersion;
      } else {
        const source = fixturesById.get(dependency.sourceFixtureId!)!;
        const advancement = authoritativeAdvancement(source);
        expectedEntryId = advancement.entryId;
        expectedRosterVersion = advancement.rosterVersion;
        if ((expectedEntryId === null) !== (expectedRosterVersion === null)) {
          fail("A feeder fixture has an incomplete authoritative advancement.", {
            fixtureId: source.id,
          });
        }
      }
      const isIgnored = ignoredDependency?.id === dependency.id;
      if (
        !isIgnored &&
        (values.entryId !== expectedEntryId ||
          (expectedRosterVersion === null ? values.rosterVersion !== null : (values.rosterVersion ?? 0) < expectedRosterVersion))
      ) {
        fail("A knockout target side does not reflect its authoritative source.", {
          fixtureId: fixture.id,
          side,
        });
      }
      if (!isIgnored) {
        const roster =
          expectedEntryId === null || expectedRosterVersion === null
            ? null
            : rosterByEntryVersion.get(
                `${expectedEntryId}\u0000${values.rosterVersion}`,
              ) ?? null;
        assertExactLineup(
          fixture,
          side,
          expectedEntryId,
          values.rosterVersion,
          roster,
        );
      }
    }
    const hasBothSides =
      fixture.sideAEntryId !== null && fixture.sideBEntryId !== null;
    const confirmed = currentConfirmedRevision(fixture);
    const administrative = fixture.administrativeResolution ?? null;
    if (
      (fixture.status === "SCHEDULED" && hasBothSides) ||
      (fixture.status === "READY" && !hasBothSides) ||
      (fixture.status === "COMPLETED" &&
        (!hasBothSides || fixture.completedAt === null || confirmed === null)) ||
      ((fixture.status === "SCHEDULED" || fixture.status === "READY") &&
        fixture.completedAt !== null) ||
      (fixture.status === "VOIDED" && fixture.completedAt === null) ||
      ((fixture.status === "SCHEDULED" || fixture.status === "READY") &&
        confirmed !== null) ||
      (fixture.status === "VOIDED" && administrative === null)
    ) {
      fail("A knockout fixture has an impossible lifecycle projection.", {
        fixtureId: fixture.id,
        status: fixture.status,
      });
    }
  }

  const finalFixture = fixtureByKey.get(
    `knockout:r${String(plan.roundCount).padStart(4, "0")}:m0001`,
  );
  if (!finalFixture || winnerDependencyBySource.has(finalFixture.id)) {
    fail("The knockout graph has no unique terminal final fixture.");
  }
  if (winnerDependencyBySource.size !== graph.fixtures.length - 1) {
    fail("Every non-final knockout fixture must have one WINNER edge.");
  }
  return {
    graph,
    fixturesById,
    fixtureByKey,
    dependencyByTargetSide,
    winnerDependencyBySource,
    finalFixture,
  };
}

async function lockAndLoadGraph(
  tx: ResultSettlementTransaction,
  match: V2KnockoutMatchContext,
): Promise<V2KnockoutGraphSnapshot> {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${match.id} AND "stage" = 'KNOCKOUT'
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture_dependency"
    WHERE "match_id" = ${match.id}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT revision."id"
    FROM "result_revision" AS revision
    INNER JOIN "match_fixture" AS fixture ON fixture."id" = revision."fixture_id"
    WHERE fixture."match_id" = ${match.id} AND fixture."stage" = 'KNOCKOUT'
    ORDER BY revision."id" FOR UPDATE OF revision
  `);

  const [grouping, snapshot, fixtures, dependencies] = await Promise.all([
    tx.matchGrouping.findUnique({
      where: { matchId: match.id },
      select: {
        id: true,
        matchId: true,
        v2SchemaVersion: true,
        standingsPolicyVersion: true,
        qualifiersPerGroup: true,
        bracketPolicyVersion: true,
        _count: { select: { groups: true } },
      },
    }),
    tx.matchQualificationSnapshot.findFirst({
      where: { matchId: match.id },
      select: {
        id: true,
        matchId: true,
        groupingId: true,
        schemaVersion: true,
        standingsPolicyVersion: true,
        sourceRevisionFingerprint: true,
        standings: {
          orderBy: [{ qualificationOrder: "asc" }, { id: "asc" }],
          select: {
            id: true,
            matchId: true,
            snapshotId: true,
            entryId: true,
            qualified: true,
            qualificationOrder: true,
            groupEntry: { select: { rosterVersion: true } },
          },
        },
      },
    }),
    tx.matchFixture.findMany({
      where: { matchId: match.id, stage: "KNOCKOUT" },
      orderBy: [{ roundNumber: "asc" }, { position: "asc" }, { id: "asc" }],
      select: {
        id: true,
        matchId: true,
        fixtureKey: true,
        stage: true,
        status: true,
        groupId: true,
        groupKey: true,
        roundNumber: true,
        position: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideARosterVersion: true,
        sideBRosterVersion: true,
        startedAt: true,
        completedAt: true,
        version: true,
        metadata: true,
        lineupMembers: {
          orderBy: [{ side: "asc" }, { position: "asc" }, { id: "asc" }],
          select: {
            id: true,
            entryId: true,
            entryMemberId: true,
            side: true,
            position: true,
          },
        },
        resultRevisions: {
          orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
          select: {
            id: true,
            status: true,
            winnerEntryId: true,
            loserEntryId: true,
            supersedesRevisionId: true,
          },
        },
        administrativeResolution: {
          select: {
            id: true,
            matchId: true,
            fixtureId: true,
            kind: true,
            advancingEntryId: true,
            advancingRosterVersion: true,
            resolvedById: true,
            reason: true,
            createdAt: true,
          },
        },
      },
    }),
    tx.matchFixtureDependency.findMany({
      where: { matchId: match.id },
      orderBy: { id: "asc" },
      select: {
        id: true,
        matchId: true,
        sourceFixtureId: true,
        sourceOutcome: true,
        sourceQualificationStandingId: true,
        targetFixtureId: true,
        targetSide: true,
      },
    }),
  ]);
  if (!grouping || !snapshot) {
    fail("The knockout bracket has no grouping or qualification snapshot.", {
      matchId: match.id,
    });
  }
  const qualifiedEntryIds = snapshot.standings
    .filter((standing) => standing.qualified)
    .map((standing) => standing.entryId);
  const rosterMembers = await tx.matchEntryMember.findMany({
    where: { matchId: match.id, entryId: { in: qualifiedEntryIds } },
    orderBy: [{ entryId: "asc" }, { rosterVersion: "asc" }, { slot: "asc" }],
    select: { id: true, entryId: true, rosterVersion: true, slot: true },
  });
  return {
    match,
    grouping: { ...grouping, groupCount: grouping._count.groups },
    snapshot,
    standings: snapshot.standings,
    fixtures,
    dependencies,
    rosterMembers,
  };
}

function assertNoPendingAncestorCorrection(
  validated: ValidatedGraph,
  fixtureId: string,
) {
  let current = validated.fixturesById.get(fixtureId);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) fail("The knockout dependency graph contains a cycle.");
    visited.add(current.id);
    const incoming = ["SIDE_A", "SIDE_B"]
      .map((side) =>
        validated.dependencyByTargetSide.get(
          targetSideKey(current!.id, side as FixtureSide),
        ),
      )
      .filter(
        (dependency): dependency is DependencyRow =>
          dependency?.sourceFixtureId !== null,
      );
    for (const dependency of incoming) {
      const source = validated.fixturesById.get(dependency.sourceFixtureId!);
      if (source && pendingCorrection(source)) {
        throw new V2ResultApplicationError(
          "INVALID_CORRECTION",
          "A pending correction freezes every downstream knockout result.",
          { sourceFixtureId: source.id, targetFixtureId: fixtureId },
        );
      }
      if (source) assertNoPendingAncestorCorrection(validated, source.id);
    }
    current = undefined;
  }
}

function assertDirectTargetMutable(
  validated: ValidatedGraph,
  sourceFixtureId: string,
) {
  const dependency = validated.winnerDependencyBySource.get(sourceFixtureId);
  if (!dependency) return null;
  const target = validated.fixturesById.get(dependency.targetFixtureId)!;
  if (
    target.startedAt !== null ||
    target.resultRevisions.length !== 0 ||
    (target.status !== "SCHEDULED" && target.status !== "READY")
  ) {
    throw new V2ResultApplicationError(
      "INVALID_CORRECTION",
      "A knockout result cannot change after its direct downstream fixture has started.",
      {
        sourceFixtureId,
        targetFixtureId: target.id,
        targetStatus: target.status,
        targetRevisionCount: target.resultRevisions.length,
      },
    );
  }
  return { dependency, target };
}

/** Ensures a new result is not downstream of a pending correction. */
export async function assertV2KnockoutResultMayStart(
  tx: ResultSettlementTransaction,
  match: V2KnockoutMatchContext,
  fixtureId: string,
) {
  if (match.status !== "ongoing") {
    throw new V2ResultApplicationError(
      "INVALID_FIXTURE_STATE",
      "A new knockout result requires an ongoing match.",
      { matchId: match.id, matchStatus: match.status },
    );
  }
  const validated = validateV2KnockoutGraph(await lockAndLoadGraph(tx, match));
  if (!validated.fixturesById.has(fixtureId)) {
    fail("The result fixture is absent from the published knockout graph.", {
      fixtureId,
    });
  }
  assertNoPendingAncestorCorrection(validated, fixtureId);
}

/** Guards correction submission/confirmation against irreversible descendants. */
export async function assertV2KnockoutCorrectionMayProceed(
  tx: ResultSettlementTransaction,
  match: V2KnockoutMatchContext,
  fixtureId: string,
) {
  const validated = validateV2KnockoutGraph(await lockAndLoadGraph(tx, match));
  if (!validated.fixturesById.has(fixtureId)) {
    fail("The correction fixture is absent from the published knockout graph.", {
      fixtureId,
    });
  }
  assertDirectTargetMutable(validated, fixtureId);
}

function sourceWinnerProjection(source: FixtureRow, winnerEntryId: string) {
  const side =
    source.sideAEntryId === winnerEntryId
      ? "SIDE_A"
      : source.sideBEntryId === winnerEntryId
        ? "SIDE_B"
        : null;
  if (side === null) {
    fail("The confirmed knockout winner is not a source fixture participant.", {
      fixtureId: source.id,
      winnerEntryId,
    });
  }
  const rosterVersion =
    side === "SIDE_A" ? source.sideARosterVersion : source.sideBRosterVersion;
  const lineup = source.lineupMembers
    .filter((member) => member.side === side)
    .sort((left, right) => left.position - right.position);
  if (rosterVersion === null || lineup.length === 0) {
    fail("The confirmed knockout winner has no frozen roster or complete lineup.", {
      fixtureId: source.id,
      winnerEntryId,
    });
  }
  return { rosterVersion, lineup };
}

async function finishMatchIfFinalIsAuthoritative(
  tx: ResultSettlementTransaction,
  validated: ValidatedGraph,
  sourceFixtureId: string,
) {
  if (validated.finalFixture.id !== sourceFixtureId) return false;
  const incomplete = validated.graph.fixtures.filter((fixture) => {
    const confirmed = currentConfirmedRevision(fixture);
    const administrative = fixture.administrativeResolution ?? null;
    return (
      fixture.completedAt === null ||
      !(
        (fixture.status === "COMPLETED" && confirmed !== null) ||
        (fixture.status === "VOIDED" && administrative !== null)
      ) ||
      fixture.resultRevisions.some((revision) => revision.status === "PENDING")
    );
  });
  if (incomplete.length !== 0) {
    fail("The final cannot finish a match before the complete bracket is authoritative.", {
      incompleteFixtureIds: incomplete.map((fixture) => fixture.id),
    });
  }
  if (validated.graph.match.status === "finished") return false;
  const updated = await tx.match.updateMany({
    where: {
      id: validated.graph.match.id,
      engineVersion: "V2",
      isQuickMatch: false,
      format: "group_then_knockout",
      status: "ongoing",
    },
    data: { status: "finished" },
  });
  if (updated.count !== 1) {
    fail("The knockout Match status changed before finalization.", {
      matchId: validated.graph.match.id,
    });
  }
  return true;
}

/**
 * Projects a confirmed PLAYED/FORFEIT winner into its unique next-round side.
 * The caller already owns the Match row lock and invokes this inside the same
 * SERIALIZABLE transaction that confirms the ResultRevision.
 */
async function advanceAuthoritativeV2KnockoutOutcome(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    match: V2KnockoutMatchContext;
    fixtureId: string;
    requiredConfirmedWinnerEntryId?: string;
  }>,
) {
  const graph = await lockAndLoadGraph(tx, input.match);
  const validated = validateV2KnockoutGraph(graph, input.fixtureId);
  const source = validated.fixturesById.get(input.fixtureId);
  if (!source) {
    fail("The confirmed fixture is absent from the published knockout graph.", {
      fixtureId: input.fixtureId,
    });
  }
  const confirmed = currentConfirmedRevision(source);
  if (input.requiredConfirmedWinnerEntryId !== undefined && (
    source.status !== "COMPLETED" ||
    source.completedAt === null ||
    confirmed?.winnerEntryId !== input.requiredConfirmedWinnerEntryId
  )) {
    fail("Knockout advancement requires the fixture's current confirmed winner.", {
      fixtureId: source.id,
      winnerEntryId: input.requiredConfirmedWinnerEntryId,
    });
  }
  const advancement = authoritativeAdvancement(source);
  if (
    source.completedAt === null ||
    (source.status !== "COMPLETED" && source.status !== "VOIDED") ||
    (source.status === "COMPLETED" && advancement.entryId === null)
  ) {
    fail("Knockout advancement requires an authoritative terminal outcome.", {
      fixtureId: source.id,
    });
  }
  const dependency = validated.winnerDependencyBySource.get(source.id);
  if (dependency === undefined) {
    await finishMatchIfFinalIsAuthoritative(tx, validated, source.id);
    return { advanced: false, finished: true, targetFixtureId: null } as const;
  }
  if (advancement.entryId === null) {
    return {
      advanced: false,
      finished: false,
      targetFixtureId: dependency.targetFixtureId,
    } as const;
  }
  const winnerEntryId = advancement.entryId;
  const target = validated.fixturesById.get(dependency.targetFixtureId)!;
  let projection: { rosterVersion: number; lineup: readonly { entryMemberId: string }[] } = sourceWinnerProjection(source, winnerEntryId);
  const current = sideValues(target, dependency.targetSide);
  const latest = await tx.matchEntryMember.findMany({
    where: { matchId: input.match.id, entryId: winnerEntryId, status: "ACTIVE", effectiveUntil: null },
    orderBy: { slot: "asc" }, select: { id: true, rosterVersion: true, slot: true },
  });
  // A progressed target must stay bound to the roster with which it started.
  if (current.entryId === winnerEntryId && current.rosterVersion !== null) {
    projection = { rosterVersion: current.rosterVersion, lineup: target.lineupMembers.filter(member => member.side === dependency.targetSide).sort((a, b) => a.position - b.position).map(member => ({ entryMemberId: member.entryMemberId })) };
  } else if (latest.length && latest.every(member => member.rosterVersion === latest[0].rosterVersion) && latest[0].rosterVersion > projection.rosterVersion) {
    projection = { rosterVersion: latest[0].rosterVersion, lineup: latest.map(member => ({ entryMemberId: member.id })) };
  }
  const otherSide = sideValues(
    target,
    dependency.targetSide === "SIDE_A" ? "SIDE_B" : "SIDE_A",
  );
  if (otherSide.entryId === winnerEntryId) {
    fail("The same Entry cannot occupy both sides of a knockout fixture.", {
      targetFixtureId: target.id,
      entryId: winnerEntryId,
    });
  }
  const targetLineup = target.lineupMembers
    .filter((member) => member.side === dependency.targetSide)
    .sort((left, right) => left.position - right.position);
  const exactLineup =
    targetLineup.length === projection.lineup.length &&
    targetLineup.every(
      (member, index) =>
        member.entryId === winnerEntryId &&
        member.entryMemberId === projection.lineup[index].entryMemberId &&
        member.position === index + 1,
    );
  const targetReady = otherSide.entryId !== null;
  const desiredStatus: FixtureStatus = targetReady ? "READY" : "SCHEDULED";
  const participantProjectionIsExact =
    current.entryId === winnerEntryId &&
    current.rosterVersion === projection.rosterVersion &&
    exactLineup;
  const progressedExactProjection =
    participantProjectionIsExact &&
    ((targetReady &&
      (target.status === "READY" || target.status === "COMPLETED")) ||
      (!targetReady && target.status === "SCHEDULED"));
  if (progressedExactProjection) {
    return {
      advanced: false,
      finished: false,
      targetFixtureId: target.id,
    } as const;
  }
  assertDirectTargetMutable(validated, source.id);
  const isExact =
    participantProjectionIsExact && target.status === desiredStatus;
  if (!isExact) {
    await tx.matchFixtureLineupMember.deleteMany({
      where: {
        matchId: input.match.id,
        fixtureId: target.id,
        side: dependency.targetSide,
      },
    });
    const sideData =
      dependency.targetSide === "SIDE_A"
        ? {
            sideAEntryId: winnerEntryId,
            sideARosterVersion: projection.rosterVersion,
          }
        : {
            sideBEntryId: winnerEntryId,
            sideBRosterVersion: projection.rosterVersion,
          };
    const updated = await tx.matchFixture.updateMany({
      where: {
        id: target.id,
        matchId: input.match.id,
        version: target.version,
        status: target.status,
      },
      data: {
        ...sideData,
        status: desiredStatus,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new V2ResultApplicationError(
        "CONCURRENT_WRITE_CONFLICT",
        "The downstream knockout fixture changed during advancement.",
        { targetFixtureId: target.id },
      );
    }
    const created = await tx.matchFixtureLineupMember.createMany({
      data: projection.lineup.map((member, index) => ({
        matchId: input.match.id,
        fixtureId: target.id,
        entryId: winnerEntryId,
        entryMemberId: member.entryMemberId,
        side: dependency.targetSide,
        position: index + 1,
      })),
    });
    if (created.count !== projection.lineup.length) {
      fail("The downstream winning lineup was not persisted completely.", {
        targetFixtureId: target.id,
        expectedLineupSize: projection.lineup.length,
        createdLineupSize: created.count,
      });
    }
  }
  return {
    advanced: !isExact,
    finished: false,
    targetFixtureId: target.id,
  } as const;
}

/**
 * Projects a confirmed PLAYED/FORFEIT winner into its unique next-round side.
 * The caller already owns the Match row lock and invokes this inside the same
 * SERIALIZABLE transaction that confirms the ResultRevision.
 */
export async function advanceConfirmedV2KnockoutWinner(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    match: V2KnockoutMatchContext;
    fixtureId: string;
    winnerEntryId: string;
  }>,
) {
  return advanceAuthoritativeV2KnockoutOutcome(tx, {
    match: input.match,
    fixtureId: input.fixtureId,
    requiredConfirmedWinnerEntryId: input.winnerEntryId,
  });
}

/**
 * Records a settlement-free terminal knockout adjudication, then projects its
 * authoritative advancement (if any). This is a trusted transaction kernel:
 * the caller must own manager authorization and the Match mutex.
 */
export async function resolveV2KnockoutFixtureAdministratively(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    match: V2KnockoutMatchContext;
    actorId: string;
    fixtureId: string;
    kind: "NO_CONTEST" | "ADMIN_BYE";
    reason: string;
    clock?: () => Date;
  }>,
) {
  const reason = input.reason.trim();
  if (
    reason.length < 1 ||
    reason.length > 500 ||
    reason !== input.reason ||
    input.match.status !== "ongoing"
  ) {
    fail("An administrative knockout resolution has invalid input.", {
      fixtureId: input.fixtureId,
    });
  }
  const validated = validateV2KnockoutGraph(
    await lockAndLoadGraph(tx, input.match),
  );
  const fixture = validated.fixturesById.get(input.fixtureId);
  if (!fixture) {
    fail("The administrative target is absent from the knockout graph.", {
      fixtureId: input.fixtureId,
    });
  }
  if (
    fixture.status !== "SCHEDULED" &&
    fixture.status !== "READY"
  ) {
    fail("Only an unresolved knockout fixture can be administratively resolved.", {
      fixtureId: fixture.id,
      fixtureStatus: fixture.status,
    });
  }
  if (
    fixture.startedAt !== null ||
    fixture.resultRevisions.some(
      (revision) => revision.status === "PENDING" || revision.status === "CONFIRMED",
    ) ||
    fixture.administrativeResolution != null
  ) {
    fail("The knockout fixture already has active match state.", {
      fixtureId: fixture.id,
    });
  }
  const populatedSides = [
    { entryId: fixture.sideAEntryId, rosterVersion: fixture.sideARosterVersion },
    { entryId: fixture.sideBEntryId, rosterVersion: fixture.sideBRosterVersion },
  ].filter((side) => side.entryId !== null || side.rosterVersion !== null);
  if (
    input.kind === "ADMIN_BYE" &&
    (populatedSides.length !== 1 ||
      populatedSides[0].entryId === null ||
      populatedSides[0].rosterVersion === null)
  ) {
    fail("ADMIN_BYE requires exactly one fully populated fixture side.", {
      fixtureId: fixture.id,
    });
  }
  const now = (input.clock ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("The administrative resolution clock returned an invalid instant.");
  }
  const advancing = input.kind === "ADMIN_BYE" ? populatedSides[0] : null;
  const updated = await tx.matchFixture.updateMany({
    where: {
      id: fixture.id,
      matchId: fixture.matchId,
      version: fixture.version,
      status: fixture.status,
    },
    data: {
      status: "VOIDED",
      completedAt: now,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new V2ResultApplicationError(
      "CONCURRENT_WRITE_CONFLICT",
      "The knockout fixture changed during administrative resolution.",
      { fixtureId: fixture.id },
    );
  }
  const resolution = await tx.matchFixtureAdministrativeResolution.create({
    data: {
      matchId: fixture.matchId,
      fixtureId: fixture.id,
      kind: input.kind,
      advancingEntryId: advancing?.entryId ?? null,
      advancingRosterVersion: advancing?.rosterVersion ?? null,
      resolvedById: input.actorId,
      reason,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action:
        input.kind === "ADMIN_BYE"
          ? "v2_knockout_admin_bye"
          : "v2_knockout_no_contest",
      entityType: "MatchFixtureAdministrativeResolution",
      entityId: resolution.id,
      details: {
        matchId: fixture.matchId,
        fixtureId: fixture.id,
        kind: input.kind,
        advancingEntryId: advancing?.entryId ?? null,
        settlement: "NONE",
      },
    },
  });
  const advancement = await advanceAuthoritativeV2KnockoutOutcome(tx, {
    match: input.match,
    fixtureId: fixture.id,
  });
  return { resolution, advancement } as const;
}
