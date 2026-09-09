import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("the shared grouping panel preserves group-only defaults and makes qualifier changes stale", () => {
  const source = read("src/components/match/v2/V2GroupOnlyGroupingPanel.tsx");
  assert.match(source, /format\s*=\s*["']group_only["']/);
  assert.match(source, /name=["']qualifiersPerGroup["']/);
  assert.match(
    source,
    /payload\.config\.qualifiersPerGroup\s*!==\s*qualifiersPerGroup/,
  );
  assert.match(source, /总晋级数必须是 2 的幂/);
  assert.match(source, /当前状态：尚未发布小组分组/);
  assert.match(source, /managementState === ["']GROUP_IN_PROGRESS["']/);
  assert.match(source, /managementState === ["']READY_TO_FINALIZE["']/);
  assert.match(source, /managementState === ["']KNOCKOUT_PUBLISHED["']/);
});

test("the finalize form posts csrf only and never accepts bracket authority", () => {
  const source = read("src/components/match/v2/V2GroupOnlyGroupingPanel.tsx");
  const start = source.indexOf("function FinalizeGroupStageForm");
  const end = source.indexOf("function PublishedGroupTableLabelsForm", start);
  assert.ok(start >= 0 && end > start, "missing isolated finalize form");
  const finalizeForm = source.slice(start, end);
  const inputNames = [...finalizeForm.matchAll(/name=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(inputNames, ["csrfToken"]);
  assert.doesNotMatch(
    finalizeForm,
    /snapshot|fingerprint|standing|qualifier|tableAssignments|knockout/i,
  );
});

test("all three grouping facades share the one finalize Server Action", () => {
  for (const type of ["Single", "Double", "Team"] as const) {
    const source = read(`src/components/match/v2/V2${type}GroupingPanel.tsx`);
    assert.match(source, /finalizeV2GroupStageAction/);
    assert.match(source, /finalizeAction={finalizeV2GroupStageAction}/);
    assert.doesNotMatch(source, /QualificationSnapshot|KnockoutPublication/);
  }
});
