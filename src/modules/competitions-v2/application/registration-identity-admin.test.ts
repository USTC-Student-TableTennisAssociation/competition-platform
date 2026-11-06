import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

// Exercise the actual server action without Next's session cookies or a database.
const filename = 'src/app/admin/registration-identities/actions.ts'
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
type Result = { details?: { realName: string; idNumber: string }; error?: string }
type Reveal = (previous: Result, form: FormData) => Promise<Result>
type Filter = {
  matchId?: string; userId?: string; match?: { collectIdentityInfo?: boolean }
  user?: { matchEntryMembers?: { some?: { matchId?: string; status?: string; entry?: { status?: string } } } }
}
const authorizedAdminId = 'authenticated-admin'
const targets = [
  { matchId: 'match-A', userId: 'player-1', enabled: true, membership: 'ACTIVE', entry: 'ACTIVE', cipher: 'sealed-A1' },
  { matchId: 'match-B', userId: 'player-1', enabled: true, membership: 'ACTIVE', entry: 'ACTIVE', cipher: 'sealed-B1' },
  { matchId: 'match-A', userId: 'player-2', enabled: true, membership: 'ACTIVE', entry: 'ACTIVE', cipher: 'sealed-A2' },
  { matchId: 'match-A', userId: 'former-member', enabled: true, membership: 'SUPERSEDED', entry: 'ACTIVE', cipher: 'sealed-former' },
  { matchId: 'match-A', userId: 'draft-member', enabled: true, membership: 'ACTIVE', entry: 'DRAFT', cipher: 'sealed-draft' },
  { matchId: 'match-off', userId: 'player-1', enabled: false, membership: 'ACTIVE', entry: 'ACTIVE', cipher: 'sealed-disabled' },
]

function harness(options: { admin?: boolean; reauthed?: boolean; auditFails?: boolean; commitFails?: boolean } = {}) {
  const calls: string[] = []
  const audit: unknown[] = []
  const tx = {
    matchRegistrationIdentity: {
      findFirst: async ({ where, select }: { where: Filter; select: unknown }) => {
        calls.push('read')
        assert.deepEqual(select, { encryptedData: true })
        const eligibility = where.user?.matchEntryMembers?.some
        // The membership itself must be in the requested match, not any active match.
        assert.equal(eligibility?.matchId, where.matchId)
        const row = targets.find(r => r.matchId === where.matchId && r.userId === where.userId
          && r.enabled === where.match?.collectIdentityInfo && r.membership === eligibility?.status
          && r.entry === eligibility?.entry?.status)
        return row ? { encryptedData: row.cipher } : null
      },
    },
    auditLog: {
      create: async ({ data }: { data: unknown }) => {
        calls.push('audit'); audit.push(data)
        if (options.auditFails) throw new Error('audit write rejected')
        return { id: 'audit-event-1' }
      },
    },
  }
  const deps: Record<string, unknown> = {
    '@/lib/server/admin/guard': {
      getAdminIdentity: async () => {
        calls.push('session')
        return options.admin === false ? { ok: false } : { ok: true, userId: authorizedAdminId }
      },
      isAdminReauthed: async (id: string) => {
        calls.push('reauth'); assert.equal(id, authorizedAdminId); return options.reauthed !== false
      },
    },
    '@/lib/csrf': { validateCsrfToken: async (form: FormData) => {
      calls.push('csrf'); return form.get('csrfToken') === 'valid-token' ? null : 'CSRF rejected'
    } },
    '@/lib/prisma': { prisma: { $transaction: async (work: (client: typeof tx) => Promise<Result>) => {
      calls.push('transaction')
      const response = await work(tx)
      if (options.commitFails) throw new Error('commit rejected')
      return response
    } } },
    '@/lib/server/registration-identity': { decryptRegistrationIdentity: (scope: { matchId: string; userId: string }, cipher: string) => {
      calls.push('decrypt')
      const target = targets.find(r => r.matchId === scope.matchId && r.userId === scope.userId)
      assert.equal(cipher, target?.cipher)
      return { realName: '测试姓名', idNumber: 'synthetic-' + cipher }
    } },
  }
  const exports = {} as { revealIdentity: Reveal }
  const load = new Script('(function (exports, require) {' + compiled + '\n})', { filename }).runInThisContext()
  load(exports, (id: string) => { assert.ok(Object.hasOwn(deps, id)); return deps[id] })
  async function reveal(matchId = 'match-A', userId = 'player-2', csrfToken = 'valid-token') {
    const form = new FormData()
    for (const [key, value] of Object.entries({ matchId, userId, csrfToken, actorId: 'forged-client-admin' })) form.set(key, value)
    // A client can replay arbitrary previous action state. It must never be echoed on failure.
    return exports.revealIdentity({ details: { realName: 'untrusted', idNumber: 'previous-response' } }, form)
  }
  return { reveal, calls, audit }
}

test('reveal rejects ordinary users, missing second authentication and invalid CSRF before any data access', async () => {
  const ordinary = harness({ admin: false }), locked = harness({ reauthed: false }), csrf = harness()
  for (const response of [await ordinary.reveal(), await locked.reveal(), await csrf.reveal('match-A', 'player-2', 'bad')]) {
    assert.ok(response.error)
    assert.equal(response.details, undefined)
  }
  assert.deepEqual(ordinary.calls, ['session'])
  assert.deepEqual(locked.calls, ['session', 'reauth'])
  assert.deepEqual(csrf.calls, ['session', 'reauth', 'csrf'])
})

test('reveal requires active membership of the selected match with identity collection enabled', async () => {
  for (const [matchId, userId] of [['match-B', 'player-2'], ['match-A', 'former-member'], ['match-A', 'draft-member'], ['match-off', 'player-1']]) {
    const client = harness()
    const response = await client.reveal(matchId, userId)
    assert.ok(response.error)
    assert.equal(response.details, undefined)
    assert.ok(!client.calls.includes('decrypt'))
    assert.equal(client.audit.length, 0)
  }
})

test('authorized reveal returns one selected identity and audits its scope without plaintext or client-supplied actor', async () => {
  const client = harness()
  assert.deepEqual(await client.reveal(), { details: { realName: '测试姓名', idNumber: 'synthetic-sealed-A2' } })
  assert.deepEqual(client.audit, [{
    actorId: authorizedAdminId, action: 'match.registration-identity.read', entityType: 'Match',
    entityId: 'match-A', details: { participantId: 'player-2' },
  }])
})

test('a failed audit insert or transaction commit never returns a decrypted identity', async () => {
  for (const client of [harness({ auditFails: true }), harness({ commitFails: true })]) {
    const response = await client.reveal()
    assert.ok(response.error)
    assert.equal(response.details, undefined)
    assert.ok(client.calls.includes('audit'))
    assert.doesNotMatch(JSON.stringify(response), /synthetic-|测试姓名|previous-response/)
  }
})
