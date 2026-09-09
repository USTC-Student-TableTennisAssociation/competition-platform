import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const banUser = readFileSync('src/lib/server/user/ban-user.ts', 'utf8')
const adminActions = readFileSync('src/app/admin/actions.ts', 'utf8')

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing section start: ${start}`)

  const endIndex = end
    ? source.indexOf(end, startIndex + start.length)
    : source.length
  assert.notEqual(endIndex, -1, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}


test('account bans only invoke legacy participant cleanup for legacy matches', () => {
  const body = section(
    banUser,
    'const matches = await tx.match.findMany',
    'for (const match of matches)',
  )

  assert.match(body, /engineVersion:\s*['"]LEGACY['"]/)
})

test('single and bulk admin ban commands use Serializable transactions', () => {
  const singleBan = section(
    adminActions,
    "if (intent === 'toggleBan')",
    "if (intent === 'bulkToggleBan')",
  )
  const bulkBan = section(
    adminActions,
    "if (intent === 'bulkToggleBan')",
    "if (intent === 'deleteUser')",
  )

  assert.match(singleBan, /isolationLevel:\s*['"]Serializable['"]/)
  assert.match(bulkBan, /isolationLevel:\s*['"]Serializable['"]/)
  assert.match(bulkBan, /setUsersBanState\(tx/)
})
