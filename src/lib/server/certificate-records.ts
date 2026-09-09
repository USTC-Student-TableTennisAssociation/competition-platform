import type {
  ParticipationCertificate,
  PrismaClient,
  UserIdentity,
} from '@prisma/client'

type CertificateRecordDatabase = Pick<
  PrismaClient,
  'participationCertificate' | 'userIdentity'
>

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

/**
 * The caller has already observed that this user has no identity. If another
 * request wins the create race, return that row so the caller can verify the
 * submitted values against the winning hashes.
 */
export async function createUserIdentityOrReadConcurrent(
  db: CertificateRecordDatabase,
  input: {
    userId: string
    nameHash: string
    studentIdHash: string
  },
): Promise<UserIdentity> {
  try {
    return await db.userIdentity.create({ data: input })
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const existing = await db.userIdentity.findUnique({
      where: { userId: input.userId },
    })
    if (existing) return existing
    throw error
  }
}

/**
 * Reuses the certificate created by a concurrent request. A P2002 without a
 * row for this match/user is a certificate-number collision, so only that case
 * consumes another generated number.
 */
export async function findOrCreateParticipationCertificate(
  db: CertificateRecordDatabase,
  input: {
    matchId: string
    userId: string
    generateCertificateNumber: () => string
    maximumAttempts?: number
  },
): Promise<ParticipationCertificate | null> {
  const businessKey = {
    matchId_userId: {
      matchId: input.matchId,
      userId: input.userId,
    },
  }
  const existing = await db.participationCertificate.findUnique({
    where: businessKey,
  })
  if (existing) return existing

  const maximumAttempts = input.maximumAttempts ?? 3
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await db.participationCertificate.create({
        data: {
          matchId: input.matchId,
          userId: input.userId,
          certificateNo: input.generateCertificateNumber(),
        },
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error

      const concurrent = await db.participationCertificate.findUnique({
        where: businessKey,
      })
      if (concurrent) return concurrent
    }
  }

  return null
}
