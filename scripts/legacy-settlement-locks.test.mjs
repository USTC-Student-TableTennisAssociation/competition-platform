import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const matchActions = readFileSync('src/app/matchs/actions.ts', 'utf8')
const quickMatchActions = readFileSync('src/app/quick-match/actions.ts', 'utf8')
const adminActions = readFileSync('src/app/admin/actions.ts', 'utf8')
const teamEntryRegistration = readFileSync(
  'src/modules/competitions-v2/application/team-entry-registration.ts',
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

test('quick result confirmation locks the result and users before settlement reads', () => {
  const eloBody = section(
    quickMatchActions,
    'async function applyQuickMatchElo',
    'async function invalidateQuickResult',
  )
  assertBefore(eloBody, 'lockUsersForUpdate(tx, allParticipantIds)', 'tx.user.findMany')

  const confirmBody = section(
    quickMatchActions,
    'export async function confirmQuickMatchResultAction',
    'export async function rejectQuickMatchResultAction',
  )
  assertBefore(confirmBody, 'lockMatchForEngine(tx', 'lockMatchResultForUpdate(tx')
  assertBefore(confirmBody, 'lockMatchResultForUpdate(tx, result.id)', 'tx.matchResult.findUnique')
  assertBefore(confirmBody, 'lockMatchResultForUpdate(tx, result.id)', 'applyQuickMatchElo(tx')
  assertBefore(confirmBody, "result.match.engineVersion !== 'LEGACY'", "initialState === 'confirmed'")
  assert.match(confirmBody, /expectedEngine:\s*['"]LEGACY['"]/)
  assert.match(confirmBody, /expectedQuickMatch:\s*true/)
})

test('all editable team sources share the Match-source-User lock protocol', () => {
  const actions = [
    ['export async function createMatchTeamAction', 'export async function updateMatchTeamAction'],
    ['export async function updateMatchTeamAction', 'export async function joinMatchTeamByInviteAction'],
    ['export async function joinMatchTeamByInviteAction', 'export async function leaveMatchTeamAction'],
    ['export async function leaveMatchTeamAction', 'export async function removeMatchTeamMemberAction'],
    ['export async function removeMatchTeamMemberAction', 'export async function submitMatchTeamAction'],
    ['export async function submitMatchTeamAction', 'export async function cancelMatchTeamAction'],
  ]

  for (const [index, [start, end]] of actions.entries()) {
    const body = section(matchActions, start, end)
    const v2ContextLock = index === 0
      ? 'lockV2TeamEntryRegistrationCreationContext(tx'
      : 'lockV2TeamEntryRegistrationContext(tx'
    assertBefore(body, 'lockTeamSourceMatch(tx', v2ContextLock)
    assertBefore(body, v2ContextLock, 'reconcileV2TeamEntryRegistrationInTransaction(tx')
    assertBefore(body, 'lockTeamSourceRows(tx', 'lockUsersForUpdate(tx')
    assert.match(body, /Prisma\.TransactionIsolationLevel\.Serializable/)
    assert.match(body, /isRetryableTeamSourceConflict\(error\)/)
    assert.match(body, /TEAM_SOURCE_CHANGED_MESSAGE/)
  }

  const createBody = section(matchActions, actions[0][0], actions[0][1])
  assertBefore(createBody, 'lockUsersForUpdate(tx', 'const actor = await tx.user.findUnique')
  assertBefore(createBody, 'await tx.matchTeam.create', 'await tx.auditLog.create')
  assertBefore(createBody, "error.code === 'P2002'", 'const existingMembership = await prisma.matchTeamMember.findUnique')

  const submitBody = section(matchActions, actions[5][0], actions[5][1])
  assertBefore(submitBody, 'lockUsersForUpdate(tx', 'tx.user.findUnique')
  assertBefore(submitBody, 'await tx.matchTeam.update', 'await tx.auditLog.create')

  const existingV2Lock = section(
    teamEntryRegistration,
    'export async function lockV2TeamEntryRegistrationContext',
    'export async function lockV2TeamEntryRegistrationCreationContext',
  )
  assertBefore(existingV2Lock, 'lockTeamSourceMatch(tx', 'lockTeamSourceRows(tx')
  assertBefore(existingV2Lock, 'lockTeamSourceRows(tx', 'lockV2EntryRows(tx')
  assertBefore(existingV2Lock, 'lockV2EntryRows(tx', 'lockUsersForUpdate(tx')

  const creationV2Lock = section(
    teamEntryRegistration,
    'export async function lockV2TeamEntryRegistrationCreationContext',
    'function assertLockContext',
  )
  assertBefore(creationV2Lock, 'lockTeamSourceMatch(tx', 'lockTeamSourceRows(tx')
  assertBefore(creationV2Lock, 'lockTeamSourceRows(tx', 'lockV2EntryRows(tx')
  assertBefore(creationV2Lock, 'lockV2EntryRows(tx', 'materializedRelatedEntry')
  assertBefore(creationV2Lock, 'lockV2EntryRows(tx', 'lockUsersForUpdate(tx')
  assert.match(creationV2Lock, /ENTRY_SOURCE_NOT_ACTIVE/)
})

test('quick rejection and timeout resolve a safe binding then lock Match before MatchResult', () => {
  const invalidationBody = section(
    quickMatchActions,
    'async function invalidateQuickResult',
    'async function invalidateLockedQuickResult',
  )
  assertBefore(invalidationBody, 'const binding = await prisma.matchResult.findUnique', 'prisma.$transaction')
  assertBefore(invalidationBody, 'lockMatchForEngine(tx', 'lockMatchResultForUpdate(tx')
  assertBefore(
    invalidationBody,
    'lockMatchResultForUpdate(tx, params.resultId)',
    'tx.matchResult.findUnique',
  )
  assert.match(invalidationBody, /expectedEngine:\s*['"]LEGACY['"]/)
  assert.match(invalidationBody, /expectedQuickMatch:\s*true/)
  assert.match(invalidationBody, /latest\.matchId !== binding\.matchId/)
  assert.match(invalidationBody, /state === 'confirmed'/)
  assert.match(invalidationBody, /state === 'invalidated'/)

  const rejectionBody = section(
    quickMatchActions,
    'export async function rejectQuickMatchResultAction',
    'export async function cleanupExpiredQuickResultsForUser',
  )
  assertBefore(
    rejectionBody,
    "result.match.engineVersion !== 'LEGACY'",
    "initialState === 'confirmed'",
  )

  const cleanupBody = section(
    quickMatchActions,
    'export async function cleanupExpiredQuickResultsForUser',
    '\n}',
  )
  assert.match(cleanupBody, /engineVersion:\s*['"]LEGACY['"]/)
  assert.match(cleanupBody, /invalidateQuickResult\(/)
})

test('admin bulk registration locks and revalidates engine ownership before writing', () => {
  const body = section(
    adminActions,
    "if (intent === 'bulkRegisterMatch')",
    "if (intent === 'toggleSiteClosed')",
  )

  assert.match(body, /expectedEngine:\s*matchIdentity\.engineVersion/)
  assert.match(body, /expectedQuickMatch:\s*false/)
  assertBefore(body, 'const matchIdentity = await tx.match.findUnique', 'lockMatchForEngine(tx')
  assertBefore(body, 'lockMatchForEngine(tx', 'const lockedMatch = await tx.match.findUnique')
  assertBefore(body, 'lockUsersForUpdate(tx', 'const lockedAdmin = await tx.user.findUnique')
  assertBefore(body, "lockedAdmin.role !== 'admin'", 'createV2EntryInTransaction(tx')
  assertBefore(body, 'lockMatchForEngine(tx', 'createV2EntryInTransaction(tx')
})
