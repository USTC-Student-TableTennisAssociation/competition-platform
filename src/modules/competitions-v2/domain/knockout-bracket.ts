const MAX_KNOCKOUT_ENTRIES = 8_192;
const IDENTIFIER_PADDING = 4;

export class V2KnockoutBracketError extends Error {
  readonly code = "INVALID_KNOCKOUT_BRACKET" as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "V2KnockoutBracketError";
    this.details = details;
  }
}

export type V2QualifiedBracketEntry = Readonly<{
  standingId: string;
  entryId: string;
  qualificationOrder: number;
  rosterVersion: number;
}>;

export type V2KnockoutQualifierSource = Readonly<{
  kind: "QUALIFIER";
  standingId: string;
  entryId: string;
  qualificationOrder: number;
  rosterVersion: number;
}>;

export type V2KnockoutWinnerSource = Readonly<{
  kind: "WINNER";
  fixtureKey: string;
}>;

export type V2KnockoutSideSource =
  | V2KnockoutQualifierSource
  | V2KnockoutWinnerSource;

export type V2KnockoutFixturePlan = Readonly<{
  fixtureKey: string;
  roundNumber: number;
  position: number;
  sideA: V2KnockoutSideSource;
  sideB: V2KnockoutSideSource;
}>;

export type V2KnockoutBracketPlan = Readonly<{
  entryCount: number;
  roundCount: number;
  fixtureCount: number;
  seedPositions: readonly number[];
  fixtures: readonly V2KnockoutFixturePlan[];
}>;

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new V2KnockoutBracketError(message, details);
}

function isStableIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 191 &&
    value === value.trim()
  );
}

function isPowerOfTwo(value: number) {
  return value >= 2 && (value & (value - 1)) === 0;
}

function fixtureKey(roundNumber: number, position: number) {
  return `knockout:r${String(roundNumber).padStart(IDENTIFIER_PADDING, "0")}:m${String(position).padStart(IDENTIFIER_PADDING, "0")}`;
}

/**
 * Returns the conventional single-elimination seed slots. Adjacent values are
 * first-round opponents and the recursive order keeps seeds 1 and 2 in
 * opposite halves, 1..4 in separate quarters, and so on.
 */
export function buildSingleEliminationSeedPositions(entryCount: number) {
  if (
    !Number.isSafeInteger(entryCount) ||
    !isPowerOfTwo(entryCount) ||
    entryCount > MAX_KNOCKOUT_ENTRIES
  ) {
    fail("A knockout bracket requires 2..8192 entries in a power of two.", {
      entryCount,
    });
  }

  let positions = [1, 2];
  while (positions.length < entryCount) {
    const complement = positions.length * 2 + 1;
    positions = positions.flatMap((seed) => [seed, complement - seed]);
  }
  return Object.freeze(positions);
}

/** Builds an immutable no-bye, no-third-place single-elimination graph. */
export function buildV2KnockoutBracket(
  rawQualifiedEntries: readonly V2QualifiedBracketEntry[],
): V2KnockoutBracketPlan {
  if (!Array.isArray(rawQualifiedEntries)) {
    fail("Qualified entries must be an array.");
  }
  const entryCount = rawQualifiedEntries.length;
  const seedPositions = buildSingleEliminationSeedPositions(entryCount);
  const standingIds = new Set<string>();
  const entryIds = new Set<string>();
  const qualificationOrders = new Set<number>();
  const qualifiedByOrder = new Map<number, V2QualifiedBracketEntry>();

  for (const [index, entry] of rawQualifiedEntries.entries()) {
    if (!entry || typeof entry !== "object") {
      fail("Each qualified bracket entry must be an object.", { index });
    }
    if (
      !isStableIdentifier(entry.standingId) ||
      !isStableIdentifier(entry.entryId) ||
      !Number.isSafeInteger(entry.qualificationOrder) ||
      entry.qualificationOrder < 1 ||
      entry.qualificationOrder > entryCount ||
      !Number.isSafeInteger(entry.rosterVersion) ||
      entry.rosterVersion < 1
    ) {
      fail("A qualified bracket entry has invalid identity or version fields.", {
        index,
      });
    }
    if (
      standingIds.has(entry.standingId) ||
      entryIds.has(entry.entryId) ||
      qualificationOrders.has(entry.qualificationOrder)
    ) {
      fail("Qualification standing, Entry, and order identities must be unique.", {
        index,
      });
    }
    standingIds.add(entry.standingId);
    entryIds.add(entry.entryId);
    qualificationOrders.add(entry.qualificationOrder);
    qualifiedByOrder.set(entry.qualificationOrder, entry);
  }
  for (let order = 1; order <= entryCount; order += 1) {
    if (!qualifiedByOrder.has(order)) {
      fail("Qualification orders must be contiguous from one.", { order });
    }
  }

  const fixtures: V2KnockoutFixturePlan[] = [];
  let previousRoundKeys: string[] = [];
  const roundCount = Math.log2(entryCount);
  for (let roundNumber = 1; roundNumber <= roundCount; roundNumber += 1) {
    const matchCount = entryCount / 2 ** roundNumber;
    const currentRoundKeys: string[] = [];
    for (let position = 1; position <= matchCount; position += 1) {
      const key = fixtureKey(roundNumber, position);
      currentRoundKeys.push(key);
      if (roundNumber === 1) {
        const sideAOrder = seedPositions[(position - 1) * 2];
        const sideBOrder = seedPositions[(position - 1) * 2 + 1];
        const sideAEntry = qualifiedByOrder.get(sideAOrder)!;
        const sideBEntry = qualifiedByOrder.get(sideBOrder)!;
        fixtures.push({
          fixtureKey: key,
          roundNumber,
          position,
          sideA: { kind: "QUALIFIER", ...sideAEntry },
          sideB: { kind: "QUALIFIER", ...sideBEntry },
        });
      } else {
        fixtures.push({
          fixtureKey: key,
          roundNumber,
          position,
          sideA: {
            kind: "WINNER",
            fixtureKey: previousRoundKeys[(position - 1) * 2],
          },
          sideB: {
            kind: "WINNER",
            fixtureKey: previousRoundKeys[(position - 1) * 2 + 1],
          },
        });
      }
    }
    previousRoundKeys = currentRoundKeys;
  }

  if (fixtures.length !== entryCount - 1) {
    fail("The complete knockout fixture graph was not produced.", {
      entryCount,
      fixtureCount: fixtures.length,
    });
  }
  return Object.freeze({
    entryCount,
    roundCount,
    fixtureCount: fixtures.length,
    seedPositions,
    fixtures: Object.freeze(fixtures),
  });
}
