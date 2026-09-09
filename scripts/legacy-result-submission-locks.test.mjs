import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'
const read = path => readFileSync(path, 'utf8')

test('retired formal writers and forms cannot be called or recreated by a legacy creation flag', () => {
  const actions = read('src/app/matchs/actions.ts')
  assert.doesNotMatch(actions, /export async function (?:registerMatchAction|unregisterMatchAction|submitGroupMatchResultAction|submitKnockoutMatchResultAction|confirmMatchResultAction|updateMatchAction|submitTeamMatchResultAction)/)
  assert.doesNotMatch(actions, /(?:prisma|tx)\.(?:matchResult|registration)\.(?:create|update|delete)/)
  assert.doesNotMatch(actions, /prisma\.match\.create/)
  for (const name of ['RegisterMatchButton','UnregisterMatchButton','ReportResultForm','AdminResultEntryForm','EditMatchForm','GroupingAdminPanel']) assert.equal(existsSync(`src/components/match/${name}.tsx`), false)
  const flag = read('src/lib/server/match/v2-creation-flag.ts')
  assert.match(flag, /value === "PAUSED" \? "PAUSED" : "V2"/)
})
test('archive readers display confirmed results and have no writable legacy fallback', () => {
  const detail = read('src/components/match/ArchivedMatchDetail.tsx')
  assert.match(detail, /engineVersion: "LEGACY"/)
  assert.match(detail, /confirmed: true/)
  assert.doesNotMatch(detail, /<form|ActionForm|\.update\(|\.delete\(/)
  for (const route of ['certificate','team-registrations.csv']) assert.match(read(`src/app/api/matchs/[id]/${route}/route.ts`), /status: 410/)
  const removal = read('src/lib/server/match/remove-participant.ts')
  assert.match(removal, /expectedQuickMatch: true/)
  assert.doesNotMatch(removal, /matchDoublesTeam|matchTeam|matchGrouping|refundRegistration/)
})
test('archive SQL targets only formal legacy rows and never changes aggregates or ledgers', () => {
  const sql = read('prisma/migrations/20260907130000_archive_legacy_formal/migration.sql')
  assert.match(sql, /"engine_version" = 'LEGACY'/)
  assert.match(sql, /"isQuickMatch" = false/)
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM) "(?:User|EloHistory|PointsTransaction)"/)
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "EloHistory"/)
})
