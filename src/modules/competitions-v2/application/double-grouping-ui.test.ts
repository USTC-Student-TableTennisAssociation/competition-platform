import assert from "node:assert/strict";
import test from "node:test";

import { V2ActionBoundaryError } from "../adapters/action-boundary";
import {
  parseV2DoubleGroupingPublication,
} from "../adapters/double-grouping-boundary";
import {
  getV2DoubleGroupingPublishIssues,
  moveV2DoubleGroupingEntry,
  parseV2DoubleGroupingUiPreview,
  serializeV2DoubleGroupingUiPayload,
  type V2DoubleGroupingUiPayload,
} from "../adapters/double-grouping-ui";

function previewValue() {
  return {
    generatedAt: "2026-09-05T08:00:00.000Z",
    competitorType: "team",
    format: "group_only",
    config: { groupCount: 2, seedMethod: "snake" },
    groups: [
      {
        name: "第 1 组",
        averagePoints: 1_400,
        players: [
          { id: "entry-a", nickname: "双打 A", points: 10, eloRating: 1_500 },
          { id: "entry-b", nickname: "双打 B", points: 8, eloRating: 1_300 },
        ],
      },
      {
        name: "第 2 组",
        averagePoints: 1_100,
        players: [
          { id: "entry-c", nickname: "双打 C", points: 6, eloRating: 1_200 },
          { id: "entry-d", nickname: "双打 D", points: 4, eloRating: 1_000 },
        ],
      },
    ],
    v2Preview: {
      schemaVersion: 1,
      matchId: "double-match",
      expectedEntries: [
        { entryId: "entry-a", version: 2 },
        { entryId: "entry-b", version: 4 },
        { entryId: "entry-c", version: 6 },
        { entryId: "entry-d", version: 8 },
      ],
    },
  };
}

function publicationForm(value: unknown) {
  const formData = new FormData();
  formData.set("csrfToken", "token");
  formData.set("previewJson", JSON.stringify(value));
  return formData;
}

test("DOUBLE UI and server boundaries accept only team Entry previews", () => {
  const parsed = parseV2DoubleGroupingUiPreview(
    JSON.stringify(previewValue()),
    "double-match",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  assert.equal(parsed.payload.competitorType, "team");
  assert.deepEqual(getV2DoubleGroupingPublishIssues(parsed.payload), []);
  assert.ok(serializeV2DoubleGroupingUiPayload(parsed.payload));

  assert.deepEqual(
    parseV2DoubleGroupingPublication(
      publicationForm(previewValue()),
      "double-match",
    ),
    {
      expectedEntries: previewValue().v2Preview.expectedEntries,
      draft: {
        format: "group_only",
        seedMethod: "snake",
        groups: [
          { entryIds: ["entry-a", "entry-b"] },
          { entryIds: ["entry-c", "entry-d"] },
        ],
      },
    },
  );
});

test("DOUBLE boundaries reject SINGLE identity and client-owned command fields", () => {
  const wrongCompetitor = { ...previewValue(), competitorType: "user" };
  assert.deepEqual(
    parseV2DoubleGroupingUiPreview(
      JSON.stringify(wrongCompetitor),
      "double-match",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );
  assert.throws(
    () =>
      parseV2DoubleGroupingPublication(
        publicationForm(wrongCompetitor),
        "double-match",
      ),
    (error: unknown) =>
      error instanceof V2ActionBoundaryError &&
      error.code === "INVALID_FORM_FIELD",
  );

  const protectedForm = publicationForm(previewValue());
  protectedForm.set("expectedEntries", "attacker-controlled");
  assert.throws(
    () =>
      parseV2DoubleGroupingPublication(protectedForm, "double-match"),
    (error: unknown) =>
      error instanceof V2ActionBoundaryError &&
      error.code === "INVALID_FORM_FIELD",
  );

  const forgedInMemory = {
    ...previewValue(),
    competitorType: "user",
  } as unknown as V2DoubleGroupingUiPayload;
  assert.ok(
    getV2DoubleGroupingPublishIssues(forgedInMemory).includes(
      "INVALID_STRUCTURE",
    ),
  );
  assert.equal(serializeV2DoubleGroupingUiPayload(forgedInMemory), null);
});

test("DOUBLE movement preserves Entry/version identity and blocks undersized groups", () => {
  const parsed = parseV2DoubleGroupingUiPreview(
    JSON.stringify(previewValue()),
    "double-match",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  const expectedSnapshot = JSON.stringify(parsed.payload.v2Preview);
  const moved = moveV2DoubleGroupingEntry(parsed.payload, "entry-a", 0, 1);
  assert.ok(moved);
  assert.deepEqual(
    moved.groups.map((group) => group.players.map((player) => player.id)),
    [["entry-b"], ["entry-c", "entry-d", "entry-a"]],
  );
  assert.equal(JSON.stringify(moved.v2Preview), expectedSnapshot);
  assert.deepEqual(getV2DoubleGroupingPublishIssues(moved), ["GROUP_TOO_SMALL"]);
  assert.equal(serializeV2DoubleGroupingUiPayload(moved), null);
});

test("DOUBLE group-then-knockout UI and boundary preserve only qualifier policy and Entry identities", () => {
  const value = {
    ...previewValue(),
    format: "group_then_knockout",
    config: {
      ...previewValue().config,
      qualifiersPerGroup: 1,
    },
  };
  const parsed = parseV2DoubleGroupingUiPreview(
    JSON.stringify(value),
    "double-match",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  assert.equal(parsed.payload.config.qualifiersPerGroup, 1);
  assert.deepEqual(getV2DoubleGroupingPublishIssues(parsed.payload), []);
  assert.deepEqual(
    parseV2DoubleGroupingPublication(publicationForm(value), "double-match"),
    {
      expectedEntries: previewValue().v2Preview.expectedEntries,
      draft: {
        format: "group_then_knockout",
        qualifiersPerGroup: 1,
        seedMethod: "snake",
        groups: [
          { entryIds: ["entry-a", "entry-b"] },
          { entryIds: ["entry-c", "entry-d"] },
        ],
      },
    },
  );

  for (const protectedField of [
    "tableAssignments",
    "knockout",
    "qualificationSnapshotId",
    "sourceRevisionFingerprint",
    "fingerprint",
  ]) {
    const overposted = { ...value, [protectedField]: "attacker-controlled" };
    assert.throws(
      () =>
        parseV2DoubleGroupingPublication(
          publicationForm(overposted),
          "double-match",
        ),
      V2ActionBoundaryError,
    );
  }
});
