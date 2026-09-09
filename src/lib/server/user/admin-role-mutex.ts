import { Prisma } from '@prisma/client'

type AdminRoleMutexTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw'
>

/** Serializes every role change that can affect the last-administrator check. */
export async function lockAdminRoleChangeMutex(
  tx: AdminRoleMutexTransaction,
) {
  await tx.$queryRaw<Array<{ locked: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(207698976, 20260904)::text AS locked
  `)
}
