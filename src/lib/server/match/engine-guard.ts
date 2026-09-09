import { Prisma, type MatchEngineVersion } from '@prisma/client'

type MatchEngineGuardTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>

export type MatchEngineGuardErrorCode =
  | 'MATCH_NOT_FOUND'
  | 'ENGINE_MISMATCH'
  | 'QUICK_MATCH_MISMATCH'

export class MatchEngineGuardError extends Error {
  readonly code: MatchEngineGuardErrorCode
  readonly matchId: string
  readonly expectedEngine: MatchEngineVersion
  readonly actualEngine?: MatchEngineVersion
  readonly expectedQuickMatch?: boolean
  readonly actualQuickMatch?: boolean

  constructor(
    code: MatchEngineGuardErrorCode,
    message: string,
    details: {
      matchId: string
      expectedEngine: MatchEngineVersion
      actualEngine?: MatchEngineVersion
      expectedQuickMatch?: boolean
      actualQuickMatch?: boolean
    },
  ) {
    super(message)
    this.name = 'MatchEngineGuardError'
    this.code = code
    this.matchId = details.matchId
    this.expectedEngine = details.expectedEngine
    this.actualEngine = details.actualEngine
    this.expectedQuickMatch = details.expectedQuickMatch
    this.actualQuickMatch = details.actualQuickMatch
  }
}

export type LockedMatchEngine = {
  id: string
  engineVersion: MatchEngineVersion
  isQuickMatch: boolean
}

/**
 * Acquires one legacy MatchResult row lock. Match-scoped writers must lock and
 * validate the owning Match before calling this helper.
 */
export async function lockMatchResultForUpdate(
  tx: MatchEngineGuardTransaction,
  resultId: string,
) {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MatchResult"
    WHERE "id" = ${resultId}
    FOR UPDATE
  `)
}

/**
 * Acquires the Match aggregate lock before checking which write engine owns it.
 * Callers must invoke this before locking Result/Entry/User rows or mutating any
 * match-scoped state in the same transaction.
 */
export async function lockMatchForEngine(
  tx: MatchEngineGuardTransaction,
  input: {
    matchId: string
    expectedEngine: MatchEngineVersion
    expectedQuickMatch?: boolean
  },
): Promise<LockedMatchEngine> {
  const rows = await tx.$queryRaw<LockedMatchEngine[]>(Prisma.sql`
    SELECT
      "id",
      "engine_version" AS "engineVersion",
      "isQuickMatch"
    FROM "Match"
    WHERE "id" = ${input.matchId}
    FOR UPDATE
  `)

  const match = rows[0]
  if (!match) {
    throw new MatchEngineGuardError(
      'MATCH_NOT_FOUND',
      'The match does not exist.',
      {
        matchId: input.matchId,
        expectedEngine: input.expectedEngine,
      },
    )
  }

  if (match.engineVersion !== input.expectedEngine) {
    throw new MatchEngineGuardError(
      'ENGINE_MISMATCH',
      `The ${input.expectedEngine} writer cannot modify a ${match.engineVersion} match.`,
      {
        matchId: input.matchId,
        expectedEngine: input.expectedEngine,
        actualEngine: match.engineVersion,
      },
    )
  }

  if (
    input.expectedQuickMatch !== undefined &&
    match.isQuickMatch !== input.expectedQuickMatch
  ) {
    throw new MatchEngineGuardError(
      'QUICK_MATCH_MISMATCH',
      input.expectedQuickMatch
        ? 'The requested match is not a quick match.'
        : 'Quick matches cannot use the formal-match writer.',
      {
        matchId: input.matchId,
        expectedEngine: input.expectedEngine,
        actualEngine: match.engineVersion,
        expectedQuickMatch: input.expectedQuickMatch,
        actualQuickMatch: match.isQuickMatch,
      },
    )
  }

  return match
}
