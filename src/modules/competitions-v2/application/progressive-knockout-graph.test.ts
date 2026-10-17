import assert from "node:assert/strict";
import test from "node:test";
import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import {
  progressiveSourceValue,
  validateV2ProgressiveKnockoutGraph,
  type V2ProgressiveKnockoutGraph,
} from "./progressive-knockout-graph";

const now = new Date("2026-10-16T00:00:00.000Z");

function baseGraph(qualificationOrderBySlot?: readonly number[]): V2ProgressiveKnockoutGraph {
  const groups = Array.from({ length: 4 }, (_, index) => ({
    id: `group-${index + 1}`, matchId: "match", groupingId: "grouping",
    groupKey: `group:${String(index + 1).padStart(4, "0")}`, position: index + 1,
    entries: [{ entryId: `entry-${index + 1}` }], qualificationSnapshot: null,
  }));
  const plan = buildV2ProgressiveKnockoutPlan({ groupingId: "grouping", groups, qualifiersPerGroup: 1, qualificationOrderBySlot });
  const fixtures = plan.fixtures.map(fixture => ({
    id: fixture.fixtureKey, matchId: "match", fixtureKey: fixture.fixtureKey,
    stage: "KNOCKOUT" as const, status: "SCHEDULED" as const,
    groupId: null, groupKey: null, roundNumber: fixture.roundNumber, position: fixture.position,
    sideAEntryId: null, sideBEntryId: null, sideARosterVersion: null, sideBRosterVersion: null,
    startedAt: null, completedAt: null, version: 0, lineupMembers: [], resultRevisions: [],
    metadata: { publication: "V2_PROGRESSIVE_KNOCKOUT_BRACKET", schemaVersion: 1, bracketPolicyVersion: plan.bracketPolicyVersion,
      groupingId: "grouping", layoutFingerprint: plan.layoutFingerprint, publishedAt: now.toISOString(),
      roundNumber: fixture.roundNumber, position: fixture.position,
      ...(qualificationOrderBySlot ? { qualificationOrderBySlot: [...qualificationOrderBySlot] } : {}) },
  }));
  return {
    match: { id: "match", engineVersion: "V2", isQuickMatch: false, status: "ongoing", format: "group_then_knockout" },
    grouping: { id: "grouping", matchId: "match", v2SchemaVersion: 1, standingsPolicyVersion: 1, qualifiersPerGroup: 1, bracketPolicyVersion: 1 },
    schedule: { id: "schedule", matchId: "match", groupingId: "grouping", schemaVersion: 1, bracketPolicyVersion: plan.bracketPolicyVersion, layoutFingerprint: plan.layoutFingerprint, createdAt: now },
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

test("conventional policy 2 retains its published fingerprints exactly", () => {
  const graph = baseGraph();
  assert.equal(graph.schedule.bracketPolicyVersion, 2);
  assert.equal(graph.schedule.layoutFingerprint, "7d253f629cd80677829596c86f84ffcc0d6b30456fabbeb7f1f255f83dd9ee8a");
  const groups = Array.from({ length: 32 }, (_, index) => ({
    id: `group-${index + 1}`, groupKey: `group:${String(index + 1).padStart(4, "0")}`, position: index + 1,
  }));
  const plan = buildV2ProgressiveKnockoutPlan({ groupingId: "grouping", groups, qualifiersPerGroup: 2 });
  assert.equal(plan.bracketPolicyVersion, 2);
  assert.equal(plan.layoutFingerprint, "baec816065f74f9020d356abb048f0f491aa8a29626ef6b21edfb93247e70d6d");
});

test("explicit policy 3 binds frozen slot order while preserving original qualification identities", () => {
  const graph = baseGraph([1, 2, 3, 4]);
  assert.equal(graph.schedule.bracketPolicyVersion, 3);
  const validated = validateV2ProgressiveKnockoutGraph(graph);
  const first = validated.fixtureByKey.get("knockout:r0001:m0001")!;
  assert.deepEqual(graph.dependencies.filter(row => row.targetFixtureId === first.id).map(row => row.sourceGroupId), ["group-1", "group-2"]);
  let populated = frozenGroup(graph, 1);
  populated = frozenGroup(populated, 2);
  populated = projectFrozenSources(populated);
  assert.equal(validateV2ProgressiveKnockoutGraph(populated).fixtureByKey.get(first.fixtureKey)?.status, "READY");
  assert.equal(populated.groups[0].qualificationSnapshot?.standings[0].qualificationOrder, 1);
  assert.equal(populated.groups[1].qualificationSnapshot?.standings[0].qualificationOrder, 2);
  validateV2ProgressiveKnockoutGraph({ ...graph, fixtures: [...graph.fixtures].reverse() });
});

test("a 64-slot frozen campus layout keeps both opening rounds inside each campus", () => {
  const groups = Array.from({ length: 32 }, (_, index) => ({
    id: `group-${index + 1}`, groupKey: `group:${String(index + 1).padStart(4, "0")}`, position: index + 1,
  }));
  const qualificationOrderBySlot = [
    ...Array.from({ length: 16 }, (_, index) => index + 1),
    ...Array.from({ length: 16 }, (_, index) => index + 33),
    ...Array.from({ length: 16 }, (_, index) => index + 17),
    ...Array.from({ length: 16 }, (_, index) => index + 49),
  ];
  const input = { groupingId: "grouping", groups, qualifiersPerGroup: 2 };
  const conventional = buildV2ProgressiveKnockoutPlan(input);
  const explicit = buildV2ProgressiveKnockoutPlan({ ...input, qualificationOrderBySlot });
  assert.equal(explicit.bracketPolicyVersion, 3);
  const firstRound = explicit.fixtures.filter(fixture => fixture.roundNumber === 1);
  const firstRoundCampuses = firstRound.map(fixture => {
    assert.equal(fixture.sideA.kind, "GROUP_RANK");
    assert.equal(fixture.sideB.kind, "GROUP_RANK");
    const campus = (groupId: string) => Number(groupId.slice(6)) <= 16 ? "east" : "west";
    if (fixture.sideA.kind !== "GROUP_RANK" || fixture.sideB.kind !== "GROUP_RANK") throw new Error("missing rank");
    assert.equal(campus(fixture.sideA.groupId), campus(fixture.sideB.groupId));
    return campus(fixture.sideA.groupId);
  });
  for (let index = 0; index < firstRoundCampuses.length; index += 2) {
    assert.equal(firstRoundCampuses[index], firstRoundCampuses[index + 1]);
  }
  assert.deepEqual(explicit.fixtures.filter(fixture => fixture.roundNumber > 1), conventional.fixtures.filter(fixture => fixture.roundNumber > 1));
  assert.notEqual(explicit.layoutFingerprint, conventional.layoutFingerprint);
});

test("explicit layouts reject missing, duplicate, fractional, sparse and out-of-range qualification orders", () => {
  const graph = baseGraph();
  const invalid: unknown[] = [null, {}, [], [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 2, 4],
    [0, 2, 3, 4], [1, 2, 3, 5], [1, 2, 3, 3.5], [1, 2, 3, "4"], [1, 2, 3, NaN],
    [1, 2, 3, Infinity], [1, 2, 3, undefined], [, 2, 3, 4]];
  for (const slots of invalid) {
    assert.throws(() => buildV2ProgressiveKnockoutPlan({ groupingId: "grouping", groups: graph.groups,
      qualifiersPerGroup: 1, qualificationOrderBySlot: slots as readonly number[] }));
  }
});

test("policy 3 fails closed on omitted, mismatched, partial or unauthoritative frozen slot metadata", () => {
  const graph = baseGraph([1, 2, 3, 4]);
  const changeMetadata = (index: number, change: (metadata: Record<string, unknown>) => Record<string, unknown>) => ({
    ...graph,
    fixtures: graph.fixtures.map((fixture, fixtureIndex) => fixtureIndex === index
      ? { ...fixture, metadata: change({ ...fixture.metadata as Record<string, unknown> }) as typeof fixture.metadata }
      : fixture),
  });
  for (const index of [0, 1, 2]) {
    assert.throws(() => validateV2ProgressiveKnockoutGraph(changeMetadata(index, metadata => {
      delete metadata.qualificationOrderBySlot;
      return metadata;
    })));
    for (const slots of [null, [1, 2, 2, 4], [1, 2, 4, 3], [1, 2, 3, "4"], [1, 2, 3], [, 2, 3, 4]]) {
      assert.throws(() => validateV2ProgressiveKnockoutGraph(changeMetadata(index, metadata => ({ ...metadata, qualificationOrderBySlot: slots }))));
    }
    assert.throws(() => validateV2ProgressiveKnockoutGraph(changeMetadata(index, metadata => ({ ...metadata, bracketPolicyVersion: 2 }))));
  }
  const conventional = baseGraph();
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, dependencies: conventional.dependencies }));
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, schedule: { ...graph.schedule, layoutFingerprint: conventional.schedule.layoutFingerprint } }));
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...graph, schedule: { ...graph.schedule, bracketPolicyVersion: 4 } }));
  assert.throws(() => validateV2ProgressiveKnockoutGraph({ ...conventional, fixtures: graph.fixtures.map(fixture => ({ ...fixture,
    metadata: { ...fixture.metadata as Record<string, never>, bracketPolicyVersion: 2,
      layoutFingerprint: conventional.schedule.layoutFingerprint } })) }));
});
