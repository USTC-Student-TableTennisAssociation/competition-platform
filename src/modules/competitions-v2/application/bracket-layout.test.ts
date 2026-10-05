import assert from "node:assert/strict";
import test from "node:test";
import {
  BRACKET_NODE_HEIGHT,
  BRACKET_NODE_WIDTH,
  buildConvergingBracketLayout,
} from "../read-model/bracket-layout";

type Bracket = Parameters<typeof buildConvergingBracketLayout>[0];
type Fixture = Bracket["rounds"][number]["fixtures"][number];

function draw(entrants: number): Bracket {
  const rounds: Array<{ roundNumber: number; fixtures: Fixture[] }> = [];
  for (let roundNumber = 1; roundNumber <= Math.log2(entrants); roundNumber++) {
    const fixtures = Array.from(
      { length: entrants / 2 ** roundNumber },
      (_, position) => ({
        fixtureId: `round-${roundNumber}-match-${position + 1}`,
        roundNumber,
        position: position + 1,
        sideA: {
          feeder:
            roundNumber === 1
              ? { kind: "QUALIFIER" as const }
              : {
                  kind: "WINNER" as const,
                  sourceFixtureId:
                    rounds[roundNumber - 2].fixtures[position * 2].fixtureId,
                },
        },
        sideB: {
          feeder:
            roundNumber === 1
              ? { kind: "QUALIFIER" as const }
              : {
                  kind: "WINNER" as const,
                  sourceFixtureId:
                    rounds[roundNumber - 2].fixtures[position * 2 + 1]
                      .fixtureId,
                },
        },
      }),
    );
    rounds.push({ roundNumber, fixtures });
  }
  return {
    rounds,
    finalFixtureId: rounds[rounds.length - 1].fixtures[0].fixtureId,
  };
}

test("sports bracket connects every published feeder and converges into one central final", () => {
  for (const entrants of [2, 4, 8, 16, 32]) {
    const bracket = draw(entrants);
    const layout = buildConvergingBracketLayout(bracket);
    assert.equal(layout.nodes.length, entrants - 1);
    assert.equal(layout.edges.length, entrants - 2);
    const final = layout.nodes.find(
      (node) => node.fixtureId === bracket.finalFixtureId,
    )!;
    assert.equal(final.side, "final");
    assert.equal(final.x + BRACKET_NODE_WIDTH / 2, layout.width / 2);
    for (const node of layout.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
      assert.ok(node.x >= 0 && node.x + BRACKET_NODE_WIDTH <= layout.width);
      assert.ok(node.y >= 0 && node.y + BRACKET_NODE_HEIGHT <= layout.height);
      if (node.side === "left") assert.ok(node.x < final.x);
      if (node.side === "right") assert.ok(node.x > final.x);
    }
    for (const fixture of bracket.rounds.flatMap((round) => round.fixtures)) {
      for (const side of [fixture.sideA, fixture.sideB]) {
        if (side.feeder.kind !== "WINNER") continue;
        const sourceId = side.feeder.sourceFixtureId;
        assert.ok(
          layout.edges.some(
            (edge) =>
              edge.sourceId === sourceId && edge.targetId === fixture.fixtureId,
          ),
        );
      }
    }
    for (const column of layout.columns) {
      const nodes = layout.nodes
        .filter((node) => node.x === column.x)
        .sort((a, b) => a.y - b.y);
      for (let index = 1; index < nodes.length; index++)
        assert.ok(nodes[index].y >= nodes[index - 1].y + BRACKET_NODE_HEIGHT);
    }
  }
});

test("bracket sides follow final feeder IDs even when array order and draw halves differ", () => {
  const original = draw(16);
  const final = original.rounds.at(-1)!.fixtures[0];
  const swapped = {
    ...original,
    rounds: original.rounds.map((round) => ({
      ...round,
      fixtures: round.fixtures.map((fixture) =>
        fixture.fixtureId === final.fixtureId
          ? { ...fixture, sideA: final.sideB, sideB: final.sideA }
          : fixture,
      ),
    })),
  };
  const expected = buildConvergingBracketLayout(swapped);
  const shuffled = buildConvergingBracketLayout({
    ...swapped,
    rounds: [...swapped.rounds]
      .reverse()
      .map((round) => ({ ...round, fixtures: [...round.fixtures].reverse() })),
  });
  assert.deepEqual(shuffled.nodes, expected.nodes);
  assert.equal(
    expected.nodes.find((node) => node.fixtureId === "round-3-match-2")!.side,
    "left",
  );
  assert.equal(
    expected.nodes.find((node) => node.fixtureId === "round-3-match-1")!.side,
    "right",
  );
});

test("invalid bracket dependencies fail instead of displaying invented advancement paths", () => {
  const original = draw(4);
  const final = original.rounds[1].fixtures[0];
  assert.throws(
    () =>
      buildConvergingBracketLayout({
        ...original,
        rounds: [
          original.rounds[0],
          {
            roundNumber: 2,
            fixtures: [
              {
                ...final,
                sideA: {
                  feeder: {
                    kind: "WINNER",
                    sourceFixtureId: "missing-fixture",
                  },
                },
              },
            ],
          },
        ],
      }),
    /invalid fixture dependency/,
  );
});
