import type { MatchEntryStatus, Prisma } from "@prisma/client";

export type V2GroupFixtureVoidBlock = Readonly<{
  reason: "MALFORMED_SIDES" | "ACTIVE_PAIRING";
  sideAStatus: MatchEntryStatus | null;
  sideBStatus: MatchEntryStatus | null;
}>;

/**
 * A group_then_knockout qualification snapshot requires every pairing between
 * still-active Entries to have a completed result. Because VOIDED is terminal,
 * voiding such a pairing would make the bracket impossible to publish.
 *
 * Callers already hold the Match mutex before reaching this helper. All
 * supported Entry writers acquire that same mutex first, so these status reads
 * are authoritative for the current write transaction without acquiring a new
 * Entry row lock after the Fixture has already been locked.
 */
export async function findV2GroupFixtureVoidBlock(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    matchId: string;
    format: "group_only" | "group_then_knockout";
    stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
    sideAEntryId: string | null;
    sideBEntryId: string | null;
  }>,
): Promise<V2GroupFixtureVoidBlock | null> {
  if (input.format !== "group_then_knockout" || input.stage !== "GROUP") {
    return null;
  }

  if (
    input.sideAEntryId === null ||
    input.sideBEntryId === null ||
    input.sideAEntryId === input.sideBEntryId
  ) {
    return {
      reason: "MALFORMED_SIDES",
      sideAStatus: null,
      sideBStatus: null,
    };
  }

  const entries = await tx.matchEntry.findMany({
    where: {
      matchId: input.matchId,
      id: { in: [input.sideAEntryId, input.sideBEntryId] },
    },
    select: { id: true, status: true },
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry.status]));
  const sideAStatus = byId.get(input.sideAEntryId) ?? null;
  const sideBStatus = byId.get(input.sideBEntryId) ?? null;
  if (entries.length !== 2 || sideAStatus === null || sideBStatus === null) {
    return { reason: "MALFORMED_SIDES", sideAStatus, sideBStatus };
  }
  if (sideAStatus === "ACTIVE" && sideBStatus === "ACTIVE") {
    return { reason: "ACTIVE_PAIRING", sideAStatus, sideBStatus };
  }
  return null;
}
