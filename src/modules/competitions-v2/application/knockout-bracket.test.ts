import assert from "node:assert/strict";
import test from "node:test";

import {
  V2KnockoutBracketError,
  buildSingleEliminationSeedPositions,
  buildV2KnockoutBracket,
} from "../domain/knockout-bracket";

function qualifiers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    standingId: `standing-${index + 1}`,
    entryId: `entry-${index + 1}`,
    qualificationOrder: index + 1,
    rosterVersion: index + 1,
  }));
}

test("standard seed slots keep the strongest seeds in separate bracket regions", () => {
  assert.deepEqual(buildSingleEliminationSeedPositions(2), [1, 2]);
  assert.deepEqual(buildSingleEliminationSeedPositions(4), [1, 4, 2, 3]);
  assert.deepEqual(buildSingleEliminationSeedPositions(8), [
    1, 8, 4, 5, 2, 7, 3, 6,
  ]);
});

test("builds every first-round qualifier and later winner dependency once", () => {
  const bracket = buildV2KnockoutBracket(qualifiers(8).reverse());
  assert.equal(bracket.roundCount, 3);
  assert.equal(bracket.fixtureCount, 7);
  assert.deepEqual(
    bracket.fixtures.slice(0, 4).map((fixture) => [
      fixture.fixtureKey,
      fixture.sideA.kind === "QUALIFIER"
        ? fixture.sideA.qualificationOrder
        : null,
      fixture.sideB.kind === "QUALIFIER"
        ? fixture.sideB.qualificationOrder
        : null,
    ]),
    [
      ["knockout:r0001:m0001", 1, 8],
      ["knockout:r0001:m0002", 4, 5],
      ["knockout:r0001:m0003", 2, 7],
      ["knockout:r0001:m0004", 3, 6],
    ],
  );
  const final = bracket.fixtures.at(-1)!;
  assert.equal(final.fixtureKey, "knockout:r0003:m0001");
  assert.deepEqual(final.sideA, {
    kind: "WINNER",
    fixtureKey: "knockout:r0002:m0001",
  });
  assert.deepEqual(final.sideB, {
    kind: "WINNER",
    fixtureKey: "knockout:r0002:m0002",
  });

  const qualifierOrders = bracket.fixtures
    .filter((fixture) => fixture.roundNumber === 1)
    .flatMap((fixture) => [fixture.sideA, fixture.sideB])
    .map((source) => {
      assert.equal(source.kind, "QUALIFIER");
      return source.kind === "QUALIFIER" ? source.qualificationOrder : -1;
    })
    .sort((left, right) => left - right);
  assert.deepEqual(qualifierOrders, [1, 2, 3, 4, 5, 6, 7, 8]);

  const winnerSources = bracket.fixtures
    .filter((fixture) => fixture.roundNumber > 1)
    .flatMap((fixture) => [fixture.sideA, fixture.sideB]);
  assert.ok(winnerSources.every((source) => source.kind === "WINNER"));
  assert.equal(
    new Set(
      winnerSources.map((source) =>
        source.kind === "WINNER" ? source.fixtureKey : "invalid",
      ),
    ).size,
    winnerSources.length,
  );
});

test("every supported bracket size has n-1 fixtures and one final", () => {
  for (const count of [2, 4, 8, 16, 32, 64]) {
    const bracket = buildV2KnockoutBracket(qualifiers(count));
    assert.equal(bracket.fixtureCount, count - 1);
    assert.equal(bracket.roundCount, Math.log2(count));
    assert.equal(
      bracket.fixtures.filter(
        (fixture) =>
          fixture.roundNumber === bracket.roundCount && fixture.position === 1,
      ).length,
      1,
    );
    assert.equal(new Set(bracket.seedPositions).size, count);
  }
});

test("bracket creation rejects byes, missing orders, and duplicate identities", () => {
  for (const count of [0, 1, 3, 8_193]) {
    assert.throws(
      () => buildSingleEliminationSeedPositions(count),
      V2KnockoutBracketError,
    );
  }

  const missingOrder = qualifiers(4);
  missingOrder[3] = { ...missingOrder[3], qualificationOrder: 3 };
  assert.throws(
    () => buildV2KnockoutBracket(missingOrder),
    V2KnockoutBracketError,
  );

  const duplicateEntry = qualifiers(4);
  duplicateEntry[3] = { ...duplicateEntry[3], entryId: "entry-1" };
  assert.throws(
    () => buildV2KnockoutBracket(duplicateEntry),
    V2KnockoutBracketError,
  );
});
