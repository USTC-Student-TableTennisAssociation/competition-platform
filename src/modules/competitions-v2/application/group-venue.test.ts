import assert from "node:assert/strict";
import test from "node:test";
import { groupVenueOptions, isGroupVenueAssignmentValid, readGroupVenueAssignment } from "../domain/group-venue";
import { isValidV2GroupTableLabels, parseV2SingleGroupFixtureMetadata } from "../domain/group-fixture-metadata";

test("campus extraction preserves unknown desk labels and keeps unassigned groups unassigned", () => {
  const labels = ["西区馆 A", "1 号台", "constructor"];
  const assignment = readGroupVenueAssignment(labels);
  assert.equal(assignment.venue, null);
  assert.deepEqual(assignment.tableLabels, labels);
  assert.equal(assignment.conflicting, false);
  assert.deepEqual(groupVenueOptions(), ["西区乒乓球馆", "东区乒乓球馆"]);
});

test("canonical and exact historical campus labels display as the same campus", () => {
  for (const label of ["东区乒乓球馆", "东区", "东区馆"]) {
    const assignment = readGroupVenueAssignment(["3 号台", label, "4 号台"]);
    assert.equal(assignment.venue, "东区乒乓球馆");
    assert.deepEqual(assignment.tableLabels, ["3 号台", "4 号台"]);
  }
});

test("new writes permit clearing but reject conflicting or duplicate campus assignments", () => {
  assert.ok(isGroupVenueAssignmentValid([]));
  assert.ok(isGroupVenueAssignmentValid(["西区乒乓球馆", "1 号台"]));
  assert.equal(isGroupVenueAssignmentValid(["西区乒乓球馆", "东区乒乓球馆"]), false);
  assert.equal(isGroupVenueAssignmentValid(["西区", "西区馆"]), false);
  assert.equal(readGroupVenueAssignment(["东区", "西区"]).conflicting, true);
});

test("campus uses one label slot and historical conflicting metadata remains readable", () => {
  const labels = ["东区乒乓球馆", ...Array.from({ length: 31 }, (_, index) => `${index + 1} 号台`)];
  assert.ok(isValidV2GroupTableLabels(labels));
  assert.equal(isValidV2GroupTableLabels([...labels, "32 号台"]), false);
  const metadata = { publication: "V2_SINGLE_GROUPING", publicationVersion: 1, groupIndex: 1,
    groupName: "第 1 组", format: "group_only", qualifiersPerGroup: null, seedMethod: "snake",
    sideAPosition: 1, sideBPosition: 2, v2Display: { schemaVersion: 1, tableLabels: ["东区馆", "西区馆"] } };
  assert.ok(parseV2SingleGroupFixtureMetadata(metadata));
});
