import { createHash } from "node:crypto";
import { buildSingleEliminationSeedPositions } from "./knockout-bracket";

export const V2_PROGRESSIVE_KNOCKOUT_PUBLICATION = "V2_PROGRESSIVE_KNOCKOUT_BRACKET";
export const V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION = 1;
export const V2_PROGRESSIVE_KNOCKOUT_POLICY_VERSION = 2;

export type V2ProgressiveKnockoutSource =
  | Readonly<{
      kind: "GROUP_RANK";
      groupId: string;
      rank: number;
      qualificationOrder: number
    }>
  | Readonly<{ kind: "WINNER"; fixtureKey: string }>;
export type V2ProgressiveKnockoutFixturePlan = Readonly<{
  fixtureKey: string;
  roundNumber: number;
  position: number;
  sideA: V2ProgressiveKnockoutSource;
  sideB: V2ProgressiveKnockoutSource;
}>;
export type V2ProgressiveKnockoutPlan = Readonly<{
  layoutFingerprint: string;
  qualificationCount: number;
  roundCount: number;
  fixtureCount: number;
  fixtures: readonly V2ProgressiveKnockoutFixturePlan[];
}>;

/** The complete bracket is fixed by group identities and places, before any scores exist. */
export function buildV2ProgressiveKnockoutPlan(input: Readonly<{
  groupingId: string;
  groups: readonly Readonly<{ id: string; groupKey: string; position: number }>[];
  qualifiersPerGroup: number;
}>): V2ProgressiveKnockoutPlan {
  const stable = (id: unknown): id is string =>
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 191 &&
    id === id.trim() &&
    !/[\u0000-\u001f\u007f]/.test(id);
  const groups = [...input.groups].sort((a, b) => a.position - b.position);
  if (
    !stable(input.groupingId) ||
    groups.length < 1 ||
    groups.length > 256 ||
    !Number.isSafeInteger(input.qualifiersPerGroup) ||
    input.qualifiersPerGroup < 1 ||
    new Set(groups.map(g => g.id)).size !== groups.length ||
    groups.some((g, i) =>
      !stable(g.id) ||
      g.position !== i + 1 ||
      g.groupKey !== `group:${String(i + 1).padStart(4, "0")}`
    )
  ) {
    throw new Error("A progressive knockout plan requires canonical published groups.");
  }
  const qualificationCount = groups.length * input.qualifiersPerGroup;
  if (qualificationCount > 1024)
    throw new Error("The progressive qualifier count exceeds the competition limit.");
  const slots = buildSingleEliminationSeedPositions(qualificationCount);
  const roundCount = Math.log2(qualificationCount);
  const fixtures: V2ProgressiveKnockoutFixturePlan[] = [];
  const key = (round: number, position: number) =>
    `knockout:r${String(round).padStart(4, "0")}:m${String(position).padStart(4, "0")}`;
  const qualifier = (order: number): V2ProgressiveKnockoutSource => ({
    kind: "GROUP_RANK",
    groupId: groups[(order - 1) % groups.length].id,
    rank: Math.floor((order - 1) / groups.length) + 1,
    qualificationOrder: order,
  });
  for (let round = 1; round <= roundCount; round++) {
    for (let position = 1; position <= qualificationCount / 2 ** round; position++)
      fixtures.push({
        fixtureKey: key(round, position),
        roundNumber: round,
        position,
        sideA: round === 1
          ? qualifier(slots[(position - 1) * 2])
          : { kind: "WINNER", fixtureKey: key(round - 1, position * 2 - 1) },
        sideB: round === 1
          ? qualifier(slots[(position - 1) * 2 + 1])
          : { kind: "WINNER", fixtureKey: key(round - 1, position * 2) },
      });
  }
  const layoutFingerprint = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION,
      bracketPolicyVersion: V2_PROGRESSIVE_KNOCKOUT_POLICY_VERSION,
      groupingId: input.groupingId,
      qualifiersPerGroup: input.qualifiersPerGroup,
      groups: groups.map(g => ({ id: g.id, groupKey: g.groupKey, position: g.position })),
      fixtures,
    }))
    .digest("hex");
  return {
    layoutFingerprint,
    qualificationCount,
    roundCount,
    fixtureCount: fixtures.length,
    fixtures
  };
}
