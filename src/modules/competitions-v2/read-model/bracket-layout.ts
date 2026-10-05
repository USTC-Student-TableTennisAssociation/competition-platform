type Feeder = Readonly<
  { kind: "QUALIFIER" } | { kind: "WINNER"; sourceFixtureId: string }
>;

type LayoutFixture = Readonly<{
  fixtureId: string;
  roundNumber: number;
  position: number;
  sideA: Readonly<{ feeder: Feeder }>;
  sideB: Readonly<{ feeder: Feeder }>;
}>;

export const BRACKET_NODE_WIDTH = 208;
export const BRACKET_NODE_HEIGHT = 100;
const COLUMN_GAP = 56;
const ROW_STEP = 124;
const TOP = 54;
const PADDING = 20;

export function bracketRoundLabel(roundNumber: number, roundCount: number) {
  const remaining = roundCount - roundNumber;
  if (remaining === 0) return "决赛";
  if (remaining === 1) return "半决赛";
  return `${2 ** (remaining + 1)} 强`;
}

/** Follow published feeder IDs: display order must never invent a new draw. */
export function buildConvergingBracketLayout(
  bracket: Readonly<{
    finalFixtureId: string;
    rounds: readonly Readonly<{
      roundNumber: number;
      fixtures: readonly LayoutFixture[];
    }>[];
  }>,
) {
  const fixtures = bracket.rounds.flatMap((round) => round.fixtures);
  const byId = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const final = byId.get(bracket.finalFixtureId);
  if (!final) throw new Error("The published bracket has no final fixture.");
  const firstRound = Math.min(
    ...fixtures.map((fixture) => fixture.roundNumber),
  );
  const sideColumns = final.roundNumber - firstRound;
  const columnStep = BRACKET_NODE_WIDTH + COLUMN_GAP;
  const columnCount = sideColumns * 2 + 1;
  const nodes: Array<{
    fixtureId: string;
    roundNumber: number;
    side: "left" | "right" | "final";
    x: number;
    y: number;
  }> = [];
  const visited = new Set<string>();

  function placeBranch(
    fixtureId: string,
    side: "left" | "right",
    cursor: { row: number },
  ): number {
    const fixture = byId.get(fixtureId);
    if (!fixture || visited.has(fixtureId))
      throw new Error(
        "The published bracket has an invalid fixture dependency.",
      );
    visited.add(fixtureId);
    const children = [fixture.sideA, fixture.sideB].flatMap((entry) =>
      entry.feeder.kind === "WINNER" ? [entry.feeder.sourceFixtureId] : [],
    );
    const childY = children.map((id) => {
      if ((byId.get(id)?.roundNumber ?? Infinity) >= fixture.roundNumber)
        throw new Error("A bracket feeder must belong to an earlier round.");
      return placeBranch(id, side, cursor);
    });
    const y = childY.length
      ? childY.reduce((sum, value) => sum + value, 0) / childY.length
      : TOP + cursor.row++ * ROW_STEP;
    const column = fixture.roundNumber - firstRound;
    nodes.push({
      fixtureId,
      roundNumber: fixture.roundNumber,
      side,
      x:
        PADDING +
        (side === "left" ? column : columnCount - 1 - column) * columnStep,
      y,
    });
    return y;
  }

  const branchY = [final.sideA, final.sideB].flatMap((entry, index) =>
    entry.feeder.kind === "WINNER"
      ? [
          placeBranch(
            entry.feeder.sourceFixtureId,
            index === 0 ? "left" : "right",
            { row: 0 },
          ),
        ]
      : [],
  );
  nodes.push({
    fixtureId: final.fixtureId,
    roundNumber: final.roundNumber,
    side: "final",
    x: PADDING + sideColumns * columnStep,
    y: branchY.length
      ? branchY.reduce((sum, y) => sum + y, 0) / branchY.length
      : TOP,
  });
  if (nodes.length !== fixtures.length)
    throw new Error(
      "The published bracket contains fixtures disconnected from the final.",
    );

  const positioned = new Map(nodes.map((node) => [node.fixtureId, node]));
  const edges = fixtures.flatMap((fixture) => {
    const target = positioned.get(fixture.fixtureId)!;
    return [fixture.sideA, fixture.sideB].flatMap((entry, slot) => {
      if (entry.feeder.kind !== "WINNER") return [];
      const source = positioned.get(entry.feeder.sourceFixtureId)!;
      const goesRight = source.x < target.x;
      const startX = source.x + (goesRight ? BRACKET_NODE_WIDTH : 0);
      const endX = target.x + (goesRight ? 0 : BRACKET_NODE_WIDTH);
      const startY = source.y + BRACKET_NODE_HEIGHT / 2;
      const endY = target.y + (slot === 0 ? 29 : 61);
      const bendX = (startX + endX) / 2;
      return [
        {
          sourceId: source.fixtureId,
          targetId: target.fixtureId,
          path: `M ${startX} ${startY} H ${bendX} V ${endY} H ${endX}`,
        },
      ];
    });
  });
  return {
    nodes,
    edges,
    width:
      PADDING * 2 +
      columnCount * BRACKET_NODE_WIDTH +
      (columnCount - 1) * COLUMN_GAP,
    height:
      Math.max(...nodes.map((node) => node.y)) + BRACKET_NODE_HEIGHT + PADDING,
    columns: Array.from({ length: columnCount }, (_, column) => ({
      x: PADDING + column * columnStep,
      roundNumber: firstRound + Math.min(column, columnCount - 1 - column),
    })),
  };
}
