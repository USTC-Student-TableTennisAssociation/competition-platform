import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const adminActions = readFileSync('src/app/admin/actions.ts', 'utf8')
const deletionGuard = readFileSync(
  'src/lib/server/user/hard-delete-users.ts',
  'utf8',
)
const adminRoleMutex = readFileSync(
  'src/lib/server/user/admin-role-mutex.ts',
  'utf8',
)
const adminDashboard = readFileSync(
  'src/app/admin/AdminDashboardClient.tsx',
  'utf8',
)

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing section start: ${start}`)
  assert.notEqual(endIndex, -1, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

function assertBefore(source, first, second) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.notEqual(firstIndex, -1, `missing expected operation: ${first}`)
  assert.notEqual(secondIndex, -1, `missing expected operation: ${second}`)
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`)
}

test('admin single and bulk deletes use the guarded transaction boundary', () => {
  const singleDelete = section(
    adminActions,
    "if (intent === 'deleteUser')",
    "if (intent === 'bulkDeleteUsers')",
  )
  const bulkDelete = section(
    adminActions,
    "if (intent === 'bulkDeleteUsers')",
    "if (intent === 'updateUser')",
  )

  for (const body of [singleDelete, bulkDelete]) {
    assert.match(body, /prisma\.\$transaction/)
    assert.match(body, /hardDeleteUsersWithoutBusinessHistory/)
    assert.match(body, /isolationLevel: 'Serializable'/)
    assert.doesNotMatch(body, /prisma\.user\.(?:delete|deleteMany)/)
    assert.doesNotMatch(body, /writeAuditLog/)
  }
})

test('guard locks rows and completes all history reads before deletion', () => {
  assertBefore(deletionGuard, 'lockUsersForUpdate(tx', 'tx.user.findMany')
  assertBefore(deletionGuard, 'tx.user.findMany', 'tx.user.deleteMany')
  assertBefore(deletionGuard, 'tx.matchResult.findMany', 'tx.user.deleteMany')
  assertBefore(deletionGuard, 'tx.leaderboardCache.groupBy', 'tx.user.deleteMany')
  assertBefore(deletionGuard, 'tx.auditLog.findMany', 'tx.user.deleteMany')
  assertBefore(deletionGuard, 'tx.user.deleteMany', 'tx.auditLog.create')
})

test('guard explicitly covers non-relational legacy history references', () => {
  assert.match(deletionGuard, /winnerTeamIds: \{ hasSome: targetIds \}/)
  assert.match(deletionGuard, /loserTeamIds: \{ hasSome: targetIds \}/)
  assert.match(deletionGuard, /leaderboardCache\.groupBy/)
  assert.match(deletionGuard, /entityType: 'User'/)
  assert.match(deletionGuard, /entityId: \{ in: targetIds \}/)
})

test('certificate identity is treated as business data and blocks deletion', () => {
  assert.match(deletionGuard, /identity: \{ select: \{ id: true \} \}/)
  assert.match(deletionGuard, /target\.identity/)
})

test('role changes serialize the last-admin check and revalidate the actor', () => {
  const roleChange = section(
    adminActions,
    "if (intent === 'updateUserRole')",
    'let createdTestAccounts:',
  )

  assert.match(roleChange, /lockAdminRoleChangeMutex\(tx\)/)
  assert.match(
    adminRoleMutex,
    /pg_advisory_xact_lock\(207698976, 20260904\)::text/,
  )
  assert.match(roleChange, /isolationLevel: 'Serializable'/)
  assertBefore(roleChange, 'lockAdminRoleChangeMutex(tx', 'lockUsersForUpdate(tx')
  assertBefore(roleChange, 'lockUsersForUpdate(tx', 'const [actor, target]')
  assertBefore(roleChange, 'const [actor, target]', 'const otherAdminCount = await tx.user.count')
  assertBefore(roleChange, 'const otherAdminCount = await tx.user.count', 'await tx.user.update')
  assertBefore(roleChange, 'await tx.user.update', 'await tx.auditLog.create')
  assert.doesNotMatch(roleChange, /prisma\.user\.(?:count|update)/)
})

test('bulk registration lists only matches supported by its guarded writer', () => {
  assert.match(
    adminActions,
    /resolveAdminBulkRegistrationPolicy\(\{[\s\S]*?\.\.\.identity,[\s\S]*?status:\s*match\.status,[\s\S]*?groupingGeneratedAt:\s*match\.groupingGeneratedAt,[\s\S]*?\}\)/,
  )
  assert.doesNotMatch(
    adminDashboard,
    /state\.matches\s*\.filter\(\(match\) => match\.canBulkRegister\)/,
  )
  assert.match(adminDashboard, /disabled=\{!match\.canBulkRegister\}/)
  assert.match(adminDashboard, /match\.bulkRegisterDisabledReason/)
})

test('admin last activity includes V2 result reports', () => {
  assert.match(
    adminActions,
    /resultRevisionsReported:\s*\{[^]*orderBy: \{ createdAt: 'desc' \}[^]*select: \{ createdAt: true \}/,
  )
  assert.match(
    adminActions,
    /user\.resultRevisionsReported\[0\]\?\.createdAt/,
  )
})
