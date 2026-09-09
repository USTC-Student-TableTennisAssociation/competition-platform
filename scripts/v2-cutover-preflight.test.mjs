import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateV2CutoverSnapshot,
  REQUIRED_CUTOVER_MODE,
} from "./v2-cutover-preflight.mjs";

function validSnapshot(overrides = {}) {
  return {
    creationMode: REQUIRED_CUTOVER_MODE,
    localMigrations: ["001", "002"],
    appliedMigrations: ["001", "002"],
    incompleteMigrationNames: [],
    rolledBackMigrationNames: [],
    unfinishedLegacyFormalMatchCount: 0,
    pendingLegacyResultCount: 0,
    pendingV2RevisionCount: 0,
    ...overrides,
  };
}

test("the cutover is ready only from PAUSED with a clean quiet database", () => {
  assert.deepEqual(evaluateV2CutoverSnapshot(validSnapshot()), {
    ok: true,
    issues: [],
    warnings: [],
    localMigrationCount: 2,
    appliedMigrationCount: 2,
  });
});

test("registration matches block the cutover just like ongoing matches", () => {
  const result = evaluateV2CutoverSnapshot(
    validSnapshot({ unfinishedLegacyFormalMatchCount: 1 }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /registration or ongoing/);
});

test("LEGACY mode, migration drift, and pending results all fail closed", () => {
  const result = evaluateV2CutoverSnapshot(
    validSnapshot({
      creationMode: "LEGACY",
      appliedMigrations: ["001", "unexpected"],
      incompleteMigrationNames: ["003"],
      pendingLegacyResultCount: 2,
      pendingV2RevisionCount: 3,
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /must be PAUSED/);
  assert.match(result.issues.join("\n"), /local migrations not deployed: 002/);
  assert.match(result.issues.join("\n"), /absent from this release: unexpected/);
  assert.match(result.issues.join("\n"), /unfinished database migrations: 003/);
  assert.match(result.warnings.join("\n"), /2 unresolved Legacy/);
  assert.match(result.warnings.join("\n"), /3 pending V2/);
});

test("rolled-back migration attempts are visible without hiding a clean replay", () => {
  const result = evaluateV2CutoverSnapshot(
    validSnapshot({ rolledBackMigrationNames: ["001"] }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    "migration history contains rolled-back attempts: 001",
  ]);
});

test("retained evidence and active new competitions do not block an archived release", () => {
  const result = evaluateV2CutoverSnapshot(validSnapshot({ pendingLegacyResultCount: 1, pendingV2RevisionCount: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 2);
});
