import { CompetitionDomainError } from "./errors";
import type { FixtureStage } from "./values";

export type FixtureStageMetadata =
  | Readonly<{
      stage: "GROUP";
      groupKey: string;
    }>
  | Readonly<{
      stage: "KNOCKOUT";
      roundNumber: number;
      position: number;
    }>
  | Readonly<{
      stage: "FREE_PLAY";
    }>;

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

export function assertFixtureStageMetadata(metadata: FixtureStageMetadata) {
  if (metadata.stage === "GROUP") {
    if (metadata.groupKey.trim() !== "") return;
    throw new CompetitionDomainError(
      "INVALID_FIXTURE_METADATA",
      "A group fixture requires a non-empty group key.",
      { stage: metadata.stage },
    );
  }

  if (metadata.stage === "KNOCKOUT") {
    if (
      isPositiveInteger(metadata.roundNumber) &&
      isPositiveInteger(metadata.position)
    ) {
      return;
    }
    throw new CompetitionDomainError(
      "INVALID_FIXTURE_METADATA",
      "A knockout fixture requires positive integer round and position values.",
      {
        stage: metadata.stage,
        roundNumber: metadata.roundNumber,
        position: metadata.position,
      },
    );
  }
}

/** A READY fixture must have two distinct, stable entry identities. */
export function assertFixtureReadyParticipants(input: Readonly<{
  stage: FixtureStage;
  homeEntryId: string | null;
  awayEntryId: string | null;
}>) {
  const homeEntryId = input.homeEntryId?.trim() ?? "";
  const awayEntryId = input.awayEntryId?.trim() ?? "";
  if (
    homeEntryId !== "" &&
    awayEntryId !== "" &&
    homeEntryId !== awayEntryId
  ) {
    return;
  }

  throw new CompetitionDomainError(
    "INVALID_FIXTURE_PARTICIPANTS",
    "A ready fixture requires two distinct entries.",
    {
      stage: input.stage,
      hasHomeEntry: homeEntryId !== "",
      hasAwayEntry: awayEntryId !== "",
      entriesAreDistinct: homeEntryId !== awayEntryId,
    },
  );
}

