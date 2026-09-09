import { Prisma, type PrismaClient } from "@prisma/client";

import {
  getV2DoubleRegistrationReadStateInTransaction,
  type V2DoubleRegistrationReadState,
} from "./double-registration";
import {
  getSingleCompetitionReadModelInTransaction,
  type SingleCompetitionReadModel,
} from "./single-match";
import {
  getV2TeamRegistrationReadStateInTransaction,
  type V2TeamRegistrationReadState,
} from "./team-registration";

const V2_DETAIL_DISCRIMINATOR_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  engineVersion: true,
  isQuickMatch: true,
  type: true,
});

export type V2CompetitionDetailReadModel =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{ kind: "LEGACY_MATCH" }>
  | Readonly<{ kind: "UNSUPPORTED_V2_MATCH" }>
  | Readonly<{
      kind: "SINGLE_V2_DETAIL";
      model: Extract<SingleCompetitionReadModel, { kind: "SINGLE_V2_MATCH" }>;
    }>
  | Readonly<{
      kind: "DOUBLE_V2_DETAIL";
      model: Extract<
        V2DoubleRegistrationReadState,
        { kind: "DOUBLE_V2_REGISTRATION" }
      >;
    }>
  | Readonly<{
      kind: "TEAM_V2_DETAIL";
      model: Extract<
        V2TeamRegistrationReadState,
        { kind: "TEAM_V2_REGISTRATION" }
      >;
    }>;

/**
 * Dispatches all six formal V2 detail cells inside one RepeatableRead
 * transaction. The discriminator may choose a reader, but it can never make a
 * Legacy fallback decision from a different database snapshot.
 */
export async function getV2CompetitionDetailReadModel(
  db: Pick<PrismaClient, "$transaction">,
  matchId: string,
  viewerUserId: string | null,
  now = new Date(),
): Promise<V2CompetitionDetailReadModel> {
  if (matchId.trim() === "" || matchId !== matchId.trim()) {
    throw new TypeError("matchId must be a non-empty stable identifier.");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date.");
  }
  return db.$transaction(
    async (tx) => {
      const discriminator = await tx.match.findUnique({
        where: { id: matchId },
        select: V2_DETAIL_DISCRIMINATOR_SELECT,
      });
      if (!discriminator) return { kind: "MATCH_NOT_FOUND" };
      if (discriminator.engineVersion !== "V2") return { kind: "LEGACY_MATCH" };
      if (discriminator.isQuickMatch) return { kind: "UNSUPPORTED_V2_MATCH" };

      if (discriminator.type === "single") {
        const model = await getSingleCompetitionReadModelInTransaction(tx, matchId);
        return model.kind === "SINGLE_V2_MATCH"
          ? { kind: "SINGLE_V2_DETAIL", model }
          : { kind: "UNSUPPORTED_V2_MATCH" };
      }
      if (discriminator.type === "double") {
        const model = await getV2DoubleRegistrationReadStateInTransaction(
          tx,
          matchId,
          viewerUserId,
          now,
        );
        return model.kind === "DOUBLE_V2_REGISTRATION"
          ? { kind: "DOUBLE_V2_DETAIL", model }
          : { kind: "UNSUPPORTED_V2_MATCH" };
      }
      if (discriminator.type === "team") {
        const model = await getV2TeamRegistrationReadStateInTransaction(
          tx,
          matchId,
          now,
        );
        return model.kind === "TEAM_V2_REGISTRATION"
          ? { kind: "TEAM_V2_DETAIL", model }
          : { kind: "UNSUPPORTED_V2_MATCH" };
      }
      return { kind: "UNSUPPORTED_V2_MATCH" };
    },
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
  );
}
