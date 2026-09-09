import { Prisma } from '@prisma/client'

type UserRowLockTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Locks user aggregate rows in one canonical order so concurrent result
 * settlements cannot overwrite each other's ELO/stat/points updates.
 */
export async function lockUsersForUpdate(
  tx: UserRowLockTransaction,
  userIds: readonly string[],
) {
  const sortedUserIds = [...new Set(userIds)].sort()
  if (sortedUserIds.length === 0) return sortedUserIds

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" IN (${Prisma.join(sortedUserIds)})
    ORDER BY "id"
    FOR UPDATE
  `)

  return sortedUserIds
}
