import assert from "node:assert/strict";
import test from "node:test";
import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import {
  progressiveSourceValue,
  validateV2ProgressiveKnockoutGraph,
  type V2ProgressiveKnockoutGraph,
} from "./progressive-knockout-graph";

const now = new Date("2026-10-16T00:00:00.000Z");

function baseGraph(): V2ProgressiveKnockoutGraph {
  const groups = Array.from({ length: 4 }, (_, index) => ({
    id: `group-${index + 1}`, matchId: "match", groupingId: "grouping",
    groupKey: `group:${String(index + 1).padStart(4, "0")}`, position: index + 1,
    entries: [{ entryId: `entry-${index + 1}` }], qualificationSnapshot: null,
  }));
  const plan = buildV2ProgressiveKnockoutPlan({ groupingId: "grouping", groups, qualifiersPerGroup: 1 });
  const fixtures = plan.fixtures.map(fixture => ({
    id: fixture.fixtureKey, matchId: "match", fixtureKey: fixture.fixtureKey,
    stage: "KNOCKOUT" as const, status: "SCHEDULED" as const,
    groupId: null, groupKey: null, roundNumber: fixture.roundNumber, position: fixture.position,
    sideAEntryId: null, sideBEntryId: null, sideARosterVersion: null, sideBRosterVersion: null,
    startedAt: null, completedAt: null, version: 0, lineupMembers: [], resultRevisions: [],
    metadata: { publication: "V2_PROGRESSIVE_KNOCKOUT_BRACKET", schemaVersion: 1, bracketPolicyVersion: 2,
      groupingId: "grouping", layoutFingerprint: plan.layoutFingerprint, publishedAt: now.toISOString(),
      roundNumber: fixture.roundNumber, position: fixture.position },
  }));
  return {
    match: { id: "match", engineVersion: "V2", isQuickMatch: false, status: "ongoing", format: "group_then_knockout" },
    grouping: { id: "grouping", matchId: "match", v2SchemaVersion: 1, standingsPolicyVersion: 1, qualifiersPerGroup: 1, bracketPolicyVersion: 1 },
    schedule: { id: "schedule", matchId: "match", groupingId: "grouping", schemaVersion: 1, bracketPolicyVersion: 2, layoutFingerprint: plan.layoutFingerprint, createdAt: now },
    groups, fixtures,
    dependencies: plan.fixtures.flatMap(fixture => ([ ["SIDE_A", fixture.sideA], ["SIDE_B", fixture.sideB] ] as const).map(([side, source]) => ({
      id: `${fixture.fixtureKey}:${side}`, matchId: "match", sourceQualificationStandingId: null,
      sourceFixtureId: source.kind === "WINNER" ? source.fixtureKey : null,
      sourceOutcome: source.kind === "WINNER" ? "WINNER" as const : null,
      sourceGroupId: source.kind === "GROUP_RANK" ? source.groupId : null,
      sourceGroupRank: source.kind === "GROUP_RANK" ? source.rank : null,
      targetFixtureId: fixture.fixtureKey, targetSide: side,
    }))),
    rosterMembers: groups.map((_, index) => ({ id: `member-${index+1}`, entryId: `entry-${index+1}`, rosterVersion: 1, slot: 1 })),
  };
}

function frozenGroup(graph: V2ProgressiveKnockoutGraph, groupNumber: number, qualified = true): V2ProgressiveKnockoutGraph {
  const groupId = `group-${groupNumber}`;
  return { ...graph, groups: graph.groups.map(group => group.id !== groupId ? group : { ...group,
    qualificationSnapshot: {
      id: `snapshot-${groupNumber}`, matchId: "match", groupId, schemaVersion: 1,
      standingsPolicyVersion: 1, sourceRevisionFingerprint: "a".repeat(64),
      standings: [{ id: `standing-${groupNumber}`, matchId: "match", snapshotId: `snapshot-${groupNumber}`,
        groupId, entryId: `entry-${groupNumber}`, rank: 1, qualified,
        qualificationOrder: qualified ? groupNumber : null, entryVersion: 1, rosterVersion: 1,
        played: 0, wins: 0, losses: 0, scoreFor: 0, scoreAgainst: 0, scoreDifferential: 0, ineligibilityReason: qualified ? null : "Withdrawn" }],
    },
  }) };
}

function projectFrozenSources(graph: V2ProgressiveKnockoutGraph): V2ProgressiveKnockoutGraph {
  return { ...graph, fixtures: graph.fixtures.map(fixture => {
    const sides = (["SIDE_A", "SIDE_B"] as const).map(side => ({ side, value: progressiveSourceValue(graph, graph.dependencies.find(dependency => dependency.targetFixtureId === fixture.id && dependency.targetSide === side)!) }));
    return { ...fixture, sideAEntryId: sides[0].value.entryId, sideBEntryId: sides[1].value.entryId,
      sideARosterVersion: sides[0].value.rosterVersion, sideBRosterVersion: sides[1].value.rosterVersion,
      status: sides.every(({value}) => value.entryId !== null) ? "READY" : "SCHEDULED",
      lineupMembers: sides.flatMap(({side,value}) => value.entryId === null ? [] : [{ id: `${fixture.id}:${side}`, entryId: value.entryId,
        entryMemberId: `member-${value.entryId.slice(6)}`, side, position: 1 }]),
    };
  }) };
}

test("progressive graph is complete and valid while every group is still unknown", () => {
  const graph = baseGraph();
  assert.equal(validateV2ProgressiveKnockoutGraph(graph).fixturesById.size, 3);
  assert.equal(progressiveSourceValue(graph, graph.dependencies[0]).known, false);
});

test("only frozen source groups populate real fixtures; unrelated groups may continue", () => {
  let graph = frozenGroup(baseGraph(), 1);
  graph = frozenGroup(graph, 4);
  graph = projectFrozenSources(graph);
  const validated = validateV2ProgressiveKnockoutGraph(graph);
  assert.equal(validated.fixtureByKey.get("knockout:r0001:m0001")?.status, "READY");
  assert.equal(validated.fixtureByKey.get("knockout:r0001:m0002")?.status, "SCHEDULED");
  assert.equal(graph.groups.filter(group => group.qualificationSnapshot === null).length, 2);
});

test("frozen ineligible rank is terminal empty, independently of unknown ranks", () => {
  const graph = frozenGroup(baseGraph(), 1, false);
  validateV2ProgressiveKnockoutGraph(graph);
  assert.deepEqual(progressiveSourceValue(graph, graph.dependencies[0]), { known: true, entryId: null, rosterVersion: null });
  assert.equal(progressiveSourceValue(graph, graph.dependencies[1]).known, false);
});

test("unknown source cannot be treated as an administrative bye", () => {
  const graph = projectFrozenSources(frozenGroup(baseGraph(), 1));
  const fixture = graph.fixtures[0];
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, fixtures: [{ ...fixture, status: "VOIDED", completedAt: now,
    administrativeResolution: { id: "admin", matchId: "match", fixtureId: fixture.id, kind: "ADMIN_BYE", advancingEntryId: "entry-1", advancingRosterVersion: 1, resolvedById: "manager", reason: "bye", createdAt: now },
  }, ...graph.fixtures.slice(1)] }), /unknown progressive source/);
});

test("unknown group, swapped slots, fabricated standing arms, and layout changes fail closed", () => {
  const graph = baseGraph();
  for (const data of [
    { sourceGroupId: "missing" }, { sourceGroupId: "group-2" }, { sourceGroupRank: 2 },
    { sourceQualificationStandingId: "fabricated" },
  ]) assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, dependencies: [{ ...graph.dependencies[0], ...data }, ...graph.dependencies.slice(1)] }));
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, schedule: { ...graph.schedule, layoutFingerprint: "f".repeat(64) } }));
});

test("frozen qualifiers require the complete admitted lineup", () => {
  const graph = projectFrozenSources(frozenGroup(baseGraph(), 1));
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, fixtures: [{ ...graph.fixtures[0], lineupMembers: [] }, ...graph.fixtures.slice(1)] }), /lineup/);
});

test("snapshot coverage and qualification order cannot be forged", () => {
  const graph = frozenGroup(baseGraph(), 1);
  const group = graph.groups[0];
  const snapshot = group.qualificationSnapshot!;
  for (const standings of [[], [{ ...snapshot.standings[0], qualificationOrder: 2 }], [{ ...snapshot.standings[0], entryId: "entry-2" }]]) {
    assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, groups: [{ ...group, qualificationSnapshot: { ...snapshot, standings } }, ...graph.groups.slice(1)] }));
  }
});
