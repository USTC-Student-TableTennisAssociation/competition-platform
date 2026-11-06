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
  collectIdentityInfo: true,
});

export type RegistrationIdentityRequirement = Readonly<{ collectIdentityInfo: boolean }>;
export type DoublesIdentityStatus = Readonly<{
  selfSubmitted: boolean;
  partnerSubmitted: boolean;
}>;

export type V2CompetitionDetailReadModel =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{ kind: "LEGACY_MATCH" }>
  | Readonly<{ kind: "UNSUPPORTED_V2_MATCH" }>
  | Readonly<{
      kind: "SINGLE_V2_DETAIL";
      model: Extract<SingleCompetitionReadModel, { kind: "SINGLE_V2_MATCH" }> & RegistrationIdentityRequirement;
    }>
  | Readonly<{
      kind: "DOUBLE_V2_DETAIL";
      model: Extract<
        V2DoubleRegistrationReadState,
        { kind: "DOUBLE_V2_REGISTRATION" }
      > & RegistrationIdentityRequirement & Readonly<{ identityStatus: DoublesIdentityStatus | null }>;
    }>
  | Readonly<{
      kind: "TEAM_V2_DETAIL";
      model: Extract<
        V2TeamRegistrationReadState,
        { kind: "TEAM_V2_REGISTRATION" }
      > & RegistrationIdentityRequirement;
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

      const { collectIdentityInfo } = discriminator;
      if (discriminator.type === "single") {
        const model = await getSingleCompetitionReadModelInTransaction(tx, matchId);
        return model.kind === "SINGLE_V2_MATCH"
          ? { kind: "SINGLE_V2_DETAIL", model: { ...model, collectIdentityInfo } }
          : { kind: "UNSUPPORTED_V2_MATCH" };
      }
      if (discriminator.type === "double") {
        const model = await getV2DoubleRegistrationReadStateInTransaction(
          tx,
          matchId,
          viewerUserId,
          now,
        );
        if (model.kind !== "DOUBLE_V2_REGISTRATION") {
          return { kind: "UNSUPPORTED_V2_MATCH" };
        }
        let identityStatus: DoublesIdentityStatus | null = null;
        const team = model.viewer.sourceTeam;
        // Unfinished submissions may still be withdrawn after the sign-up deadline.
        if (collectIdentityInfo && viewerUserId && team && (!team.entry || team.entry.status === "DRAFT")) {
          const submitted = await tx.matchRegistrationIdentity.findMany({
            where: { matchId, userId: { in: team.members.map((member) => member.userId) } },
            select: { userId: true },
          });
          identityStatus = {
            selfSubmitted: submitted.some(({ userId }) => userId === viewerUserId),
            partnerSubmitted: submitted.some(({ userId }) => userId !== viewerUserId),
          };
        }
        return { kind: "DOUBLE_V2_DETAIL", model: { ...model, collectIdentityInfo, identityStatus } };
      }
      if (discriminator.type === "team") {
        const model = await getV2TeamRegistrationReadStateInTransaction(
          tx,
          matchId,
          now,
        );
        return model.kind === "TEAM_V2_REGISTRATION"
          ? { kind: "TEAM_V2_DETAIL", model: { ...model, collectIdentityInfo } }
          : { kind: "UNSUPPORTED_V2_MATCH" };
      }
      return { kind: "UNSUPPORTED_V2_MATCH" };
    },
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
  );
}
