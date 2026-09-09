import assert from "node:assert/strict";
import test from "node:test";

import {
  getV2SingleGroupingPublishIssues,
  moveV2SingleGroupingEntry,
  parseV2SingleGroupingUiPreview,
  serializeV2SingleGroupingUiPayload,
  type V2SingleGroupingUiPayload,
} from "../adapters/single-grouping-ui";

function validPreviewValue() {
  return {
    generatedAt: "2026-09-04T08:00:00.000Z",
    competitorType: "user",
    format: "group_only",
    config: { groupCount: 2, seedMethod: "snake" },
    groups: [
      {
        name: "第 1 组",
        averagePoints: 1_300,
        players: [
          { id: "entry-a", nickname: "选手 A", points: 10, eloRating: 1_400 },
          { id: "entry-b", nickname: "选手 B", points: 8, eloRating: 1_200 },
        ],
      },
      {
        name: "第 2 组",
        averagePoints: 900,
        players: [
          { id: "entry-c", nickname: "选手 C", points: 6, eloRating: 1_000 },
          { id: "entry-d", nickname: "选手 D", points: 4, eloRating: 800 },
        ],
      },
    ],
    v2Preview: {
      schemaVersion: 1,
      matchId: "match-v2",
      expectedEntries: [
        { entryId: "entry-a", version: 2 },
        { entryId: "entry-b", version: 4 },
        { entryId: "entry-c", version: 6 },
        { entryId: "entry-d", version: 8 },
      ],
    },
  };
}

function parseValidPreview() {
  const result = parseV2SingleGroupingUiPreview(
    JSON.stringify(validPreviewValue()),
    "match-v2",
  );
  if (!result.ok) assert.fail(`unexpected parse failure: ${result.reason}`);
  return result.payload;
}

test("the V2 grouping UI parser accepts the versioned group-phase preview contract", () => {
  const payload = parseValidPreview();

  assert.equal(payload.format, "group_only");
  assert.equal(payload.config.seedMethod, "snake");
  assert.deepEqual(
    payload.v2Preview.expectedEntries.map(({ entryId, version }) => ({
      entryId,
      version,
    })),
    [
      { entryId: "entry-a", version: 2 },
      { entryId: "entry-b", version: 4 },
      { entryId: "entry-c", version: 6 },
      { entryId: "entry-d", version: 8 },
    ],
  );
  assert.deepEqual(getV2SingleGroupingPublishIssues(payload), []);
  assert.ok(serializeV2SingleGroupingUiPayload(payload));
});

test("SINGLE group-then-knockout preview requires a valid power-of-two qualifier policy", () => {
  const knockout = {
    ...validPreviewValue(),
    format: "group_then_knockout",
    config: {
      ...validPreviewValue().config,
      qualifiersPerGroup: 1,
    },
  };
  const parsed = parseV2SingleGroupingUiPreview(
    JSON.stringify(knockout),
    "match-v2",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  assert.equal(parsed.payload.format, "group_then_knockout");
  assert.equal(parsed.payload.config.qualifiersPerGroup, 1);
  assert.deepEqual(getV2SingleGroupingPublishIssues(parsed.payload), []);

  const missingQualifier = {
    ...knockout,
    config: validPreviewValue().config,
  };
  assert.deepEqual(
    parseV2SingleGroupingUiPreview(
      JSON.stringify(missingQualifier),
      "match-v2",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );
  const tooManyQualifiers = {
    ...knockout,
    config: { ...knockout.config, qualifiersPerGroup: 3 },
  };
  assert.deepEqual(
    parseV2SingleGroupingUiPreview(
      JSON.stringify(tooManyQualifiers),
      "match-v2",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );
});

test("the V2 grouping UI parser rejects unknown structure, another match, and oversized data", () => {
  const withUnknownRoot = {
    ...validPreviewValue(),
    tableAssignments: { group: { "第 1 组": ["1"] } },
  };
  assert.deepEqual(
    parseV2SingleGroupingUiPreview(
      JSON.stringify(withUnknownRoot),
      "match-v2",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );

  const withUnknownPlayerField = validPreviewValue();
  Object.assign(withUnknownPlayerField.groups[0].players[0], {
    role: "admin",
  });
  assert.deepEqual(
    parseV2SingleGroupingUiPreview(
      JSON.stringify(withUnknownPlayerField),
      "match-v2",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );

  assert.deepEqual(
    parseV2SingleGroupingUiPreview(
      JSON.stringify(validPreviewValue()),
      "another-match",
    ),
    { ok: false, reason: "MATCH_MISMATCH" },
  );
  assert.deepEqual(
    parseV2SingleGroupingUiPreview("x".repeat(512 * 1_024 + 1), "match-v2"),
    { ok: false, reason: "TOO_LARGE" },
  );
});

test("moving an Entry preserves the version snapshot and blocks publication of a one-person group", () => {
  const payload = parseValidPreview();
  const expectedSnapshot = JSON.stringify(payload.v2Preview);
  const moved = moveV2SingleGroupingEntry(payload, "entry-a", 0, 1);

  assert.ok(moved);
  assert.deepEqual(
    moved.groups.map((group) => group.players.map((player) => player.id)),
    [["entry-b"], ["entry-c", "entry-d", "entry-a"]],
  );
  assert.deepEqual(
    moved.groups.map((group) => group.averagePoints),
    [1_200, 1_067],
  );
  assert.equal(JSON.stringify(moved.v2Preview), expectedSnapshot);
  assert.deepEqual(getV2SingleGroupingPublishIssues(moved), [
    "GROUP_TOO_SMALL",
  ]);
  assert.equal(serializeV2SingleGroupingUiPayload(moved), null);

  const restored = moveV2SingleGroupingEntry(moved, "entry-a", 1, 0);
  assert.ok(restored);
  assert.deepEqual(getV2SingleGroupingPublishIssues(restored), []);
  assert.equal(JSON.stringify(restored.v2Preview), expectedSnapshot);
  const serialized = serializeV2SingleGroupingUiPayload(restored);
  assert.ok(serialized);
  assert.equal(
    parseV2SingleGroupingUiPreview(serialized, "match-v2").ok,
    true,
  );
});

test("movement and publication fail closed on invalid identity placement", () => {
  const payload = parseValidPreview();
  assert.equal(moveV2SingleGroupingEntry(payload, "missing-entry", 0, 1), null);
  assert.equal(moveV2SingleGroupingEntry(payload, "entry-a", 0, 0), null);
  assert.equal(moveV2SingleGroupingEntry(payload, "entry-a", -1, 1), null);

  const mismatched = {
    ...payload,
    groups: [
      {
        ...payload.groups[0],
        players: [payload.groups[0].players[0], payload.groups[0].players[0]],
      },
      payload.groups[1],
    ],
  } as V2SingleGroupingUiPayload;
  assert.ok(
    getV2SingleGroupingPublishIssues(mismatched).includes(
      "ENTRY_SET_MISMATCH",
    ),
  );
  assert.equal(serializeV2SingleGroupingUiPayload(mismatched), null);
});
