import { Prisma, type PrismaClient } from "@prisma/client";

import type { CertificateEligibility } from "../../../lib/certificate";
import {
  evaluateV2CertificateEligibility,
  type V2CertificateEligibility,
} from "../application/certificate-eligibility";
import {
  loadV2CertificateMatchSource,
  toV2CertificateSnapshot,
} from "../application/certificates";

export type V2CertificateReadDatabase = Pick<PrismaClient, "$transaction">;

export type V2CertificateReadState =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{
      kind: "CERTIFICATE_STATE";
      eligibility: V2CertificateEligibility;
      identityBound: boolean;
      existingCertificateNo: string | null;
    }>;

export type V2CertificateSectionState = Readonly<{
  currentUserEmail: string;
  identityBound: boolean;
  eligibility: CertificateEligibility;
  existingCertificateNo: string | null;
}>;

/** Compatibility aliases retained while callers migrate off the old name. */
export type V2SingleCertificateReadDatabase = V2CertificateReadDatabase;
export type V2SingleCertificateReadState = V2CertificateReadState;

export function toCertificateEligibility(
  eligibility: V2CertificateEligibility,
): CertificateEligibility {
  return eligibility.state === "ELIGIBLE"
    ? { eligible: true }
    : { eligible: false, reason: eligibility.reason };
}

/**
 * Non-authoritative page projection. Issuance always repeats the same evaluator
 * after acquiring the Match aggregate lock in a Serializable transaction.
 */
export function toV2CertificateSectionState(
  state: V2CertificateReadState | null,
  currentUserEmail: string,
): V2CertificateSectionState | null {
  if (!state || state.kind !== "CERTIFICATE_STATE") return null;
  return {
    currentUserEmail,
    identityBound: state.identityBound,
    eligibility: toCertificateEligibility(state.eligibility),
    existingCertificateNo: state.existingCertificateNo,
  };
}

export async function getV2CertificateReadState(
  db: V2CertificateReadDatabase,
  matchId: string,
  userId: string,
): Promise<V2CertificateReadState> {
  return db.$transaction(
    async (tx) => {
      const source = await loadV2CertificateMatchSource(tx, matchId);
      if (!source) return { kind: "MATCH_NOT_FOUND" } as const;

      const [identity, certificate] = await Promise.all([
        tx.userIdentity.findUnique({
          where: { userId },
          select: { id: true },
        }),
        tx.participationCertificate.findUnique({
          where: { matchId_userId: { matchId, userId } },
          select: { certificateNo: true },
        }),
      ]);
      return {
        kind: "CERTIFICATE_STATE",
        eligibility: evaluateV2CertificateEligibility(
          toV2CertificateSnapshot(source),
          userId,
        ),
        identityBound: identity !== null,
        existingCertificateNo: certificate?.certificateNo ?? null,
      } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export const getV2SingleCertificateReadState = getV2CertificateReadState;
