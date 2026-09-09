import assert from "node:assert/strict";
import test from "node:test";

import { V2ActionBoundaryError } from "../adapters/action-boundary";
import { parseV2TeamGroupingPublication } from "../adapters/team-grouping-boundary";
import {
  getV2TeamGroupingPublishIssues,
  moveV2TeamGroupingEntry,
  parseV2TeamGroupingUiPreview,
  serializeV2TeamGroupingUiPayload,
  type V2TeamGroupingUiPayload,
} from "../adapters/team-grouping-ui";

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
          { id: "entry-a", nickname: "团体 A", points: 10, eloRating: 1_500 },
          { id: "entry-b", nickname: "团体 B", points: 8, eloRating: 1_300 },
        ],
      },
      {
        name: "第 2 组",
        averagePoints: 1_100,
        players: [
          { id: "entry-c", nickname: "团体 C", points: 6, eloRating: 1_200 },
          { id: "entry-d", nickname: "团体 D", points: 4, eloRating: 1_000 },
        ],
      },
    ],
    v2Preview: {
      schemaVersion: 1,
      matchId: "team-match",
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

test("TEAM UI and server facades accept only team Entry previews", () => {
  const parsed = parseV2TeamGroupingUiPreview(
    JSON.stringify(previewValue()),
    "team-match",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  assert.deepEqual(getV2TeamGroupingPublishIssues(parsed.payload), []);
  assert.ok(serializeV2TeamGroupingUiPayload(parsed.payload));
  assert.deepEqual(
    parseV2TeamGroupingPublication(
      publicationForm(previewValue()),
      "team-match",
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

test("TEAM facades reject user identity and protected fields", () => {
  const wrongCompetitor = { ...previewValue(), competitorType: "user" };
  assert.deepEqual(
    parseV2TeamGroupingUiPreview(
      JSON.stringify(wrongCompetitor),
      "team-match",
    ),
    { ok: false, reason: "UNSUPPORTED_STRUCTURE" },
  );
  assert.throws(
    () =>
      parseV2TeamGroupingPublication(
        publicationForm(wrongCompetitor),
        "team-match",
      ),
    V2ActionBoundaryError,
  );

  const protectedForm = publicationForm(previewValue());
  protectedForm.set("expectedEntries", "attacker-controlled");
  assert.throws(
    () => parseV2TeamGroupingPublication(protectedForm, "team-match"),
    V2ActionBoundaryError,
  );

  const knockout = {
    ...previewValue(),
    format: "group_then_knockout",
    config: { ...previewValue().config, qualifiersPerGroup: 1 },
  };
  const parsedKnockout = parseV2TeamGroupingUiPreview(
    JSON.stringify(knockout),
    "team-match",
  );
  if (!parsedKnockout.ok) {
    assert.fail(`unexpected parse failure: ${parsedKnockout.reason}`);
  }
  assert.deepEqual(
    parseV2TeamGroupingPublication(publicationForm(knockout), "team-match").draft,
    {
      format: "group_then_knockout",
      seedMethod: "snake",
      qualifiersPerGroup: 1,
      groups: [
        { entryIds: ["entry-a", "entry-b"] },
        { entryIds: ["entry-c", "entry-d"] },
      ],
    },
  );

  const snapshotOverpost = {
    ...knockout,
    v2Preview: {
      ...knockout.v2Preview,
      snapshotId: "attacker-controlled",
    },
  };
  assert.throws(
    () =>
      parseV2TeamGroupingPublication(
        publicationForm(snapshotOverpost),
        "team-match",
      ),
    V2ActionBoundaryError,
  );

  const forged = wrongCompetitor as unknown as V2TeamGroupingUiPayload;
  assert.ok(getV2TeamGroupingPublishIssues(forged).includes("INVALID_STRUCTURE"));
  assert.equal(serializeV2TeamGroupingUiPayload(forged), null);
});

test("TEAM movement preserves Entry versions and blocks an undersized group", () => {
  const parsed = parseV2TeamGroupingUiPreview(
    JSON.stringify(previewValue()),
    "team-match",
  );
  if (!parsed.ok) assert.fail(`unexpected parse failure: ${parsed.reason}`);
  const snapshot = JSON.stringify(parsed.payload.v2Preview);
  const moved = moveV2TeamGroupingEntry(parsed.payload, "entry-a", 0, 1);
  assert.ok(moved);
  assert.equal(JSON.stringify(moved.v2Preview), snapshot);
  assert.deepEqual(getV2TeamGroupingPublishIssues(moved), ["GROUP_TOO_SMALL"]);
  assert.equal(serializeV2TeamGroupingUiPayload(moved), null);
});
