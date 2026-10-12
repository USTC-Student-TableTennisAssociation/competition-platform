import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const testSecret = 'route-access-production-smoke-only'
let server
let origin
let fixtureDb
let memberId
let adminId

const integrationUrl = process.env.ROUTE_ACCESS_TEST_DATABASE_URL ?? process.env.V2_CORE_INTEGRATION_DATABASE_URL
const useFixtures = (() => {
  if (!integrationUrl) return false
  const url = new URL(integrationUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'access fixtures require loopback')
  assert.ok(['/ustctta_v2_test', '/ustctta_ci'].includes(url.pathname), 'access fixtures require the isolated test database')
  return true
})()

function signedToken(expiresAt = Date.now() + 60_000, id = 'route-access-nonexistent-account') {
  const stamp = createHmac('sha256', testSecret).update(`${id}.test-hash`).digest('hex')
  const payload = `${id}.0.${expiresAt}.smoke-nonce.${stamp}`
  return `${payload}.${createHmac('sha256', testSecret).update(payload).digest('hex')}`
}

test.before(async () => {
  if (useFixtures) {
    const { PrismaClient } = await import('@prisma/client')
    fixtureDb = new PrismaClient({ datasourceUrl: integrationUrl })
    memberId = `access-member-${randomUUID()}`
    adminId = `access-admin-${randomUUID()}`
    for (const [id, role] of [[memberId, 'user'], [adminId, 'admin']]) {
      await fixtureDb.user.create({ data: {
        id, role, email: `${id}@example.test`, nickname: 'Access test fixture',
        hashedPassword: 'test-hash', emailVerifiedAt: new Date(),
      } })
    }
  }
  const listener = net.createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  origin = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    env: { ...process.env, AUTH_SECRET: testSecret, ...(useFixtures ? { DATABASE_URL: integrationUrl, DATABASE_URL_UNPOOLED: integrationUrl } : {}) },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, 'production server exited during startup')
    try {
      const response = await fetch(`${origin}/auth`, { redirect: 'manual' })
      await response.body?.cancel()
      if (response.status === 200) return
    } catch { /* Retry only during server startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.fail('production server did not become ready')
})

test.after(async () => {
  try {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve))
      server.kill('SIGTERM')
      await exited
    }
  } finally {
    if (fixtureDb) {
      try { await fixtureDb.user.deleteMany({ where: { id: { in: [memberId, adminId].filter(Boolean) } } }) }
      finally { await fixtureDb.$disconnect() }
    }
  }
})

async function request(path, cookie) {
  const response = await fetch(`${origin}${path}`, {
    redirect: 'manual', headers: cookie ? { cookie: `ustc_tta_session=${cookie}` } : {},
  })
  await response.body?.cancel()
  return response
}

test('the production build includes the route proxy', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.next/server/functions-config-manifest.json', import.meta.url), 'utf8'))
  const proxy = manifest.functions['/_middleware']
  assert.equal(proxy?.runtime, 'nodejs', 'missing compiled Node.js route proxy')
  assert.ok(proxy.matchers.some((matcher) => matcher.originalSource === '/(.*)'))
})

test('anonymous visitors cannot read business pages in the production server', async () => {
  for (const path of ['/', '/rankings', '/matchs', '/profile/member.name', '/supermarket', '/admin/supermarket', '/authentication']) {
    const response = await request(path)
    assert.equal(response.status, 307, path)
    assert.equal(new URL(response.headers.get('location'), origin).pathname, '/auth', path)
  }
})

test('forged and expired cookies do not bypass the production proxy', async () => {
  for (const cookie of ['forged', signedToken(Date.now() - 1000)]) {
    const response = await request('/rankings', cookie)
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get('location'), origin).pathname, '/auth')
  }
})

test('protected API routes, including dotted CSV URLs, return an authentication error', async () => {
  assert.equal((await request('/api/matchs/unknown/team-registrations.csv')).status, 401)
})

test('login and bundled assets are available without a session', async () => {
  for (const path of ['/auth', '/SVG/tta-badge.svg', '/supermarket/towel-design.png']) {
    assert.equal((await request(path)).status, 200, path)
  }
})

test('deployment health checks reach their handler without authentication', async () => {
  const response = await fetch(`${origin}/api/health`, { redirect: 'manual' })
  assert.ok([200, 503].includes(response.status))
  assert.equal(response.headers.get('location'), null)
  const health = await response.json()
  assert.ok(['ok', 'unhealthy'].includes(health.status))
})

test('the local catalog preview is unavailable in production', async () => {
  assert.equal((await request('/supermarket/preview')).status, 404)
})

const hasLocalDatabase = (() => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname) } catch { return false }
})()
test('a signed session for a missing account cannot read member data', { skip: !hasLocalDatabase }, async () => {
  for (const path of ['/', '/rankings', '/matchs', '/profile/missing-user', '/supermarket']) {
    const response = await request(path, signedToken())
    assert.equal(response.status, 307, path)
    assert.equal(new URL(response.headers.get('location'), origin).pathname, '/auth', path)
  }
})

test('verified members retain access while admin pages retain their role restriction', { skip: !useFixtures }, async () => {
  const cookie = signedToken(undefined, memberId)
  for (const path of ['/', '/rankings', '/matchs', `/profile/${adminId}`, '/supermarket']) {
    assert.equal((await request(path, cookie)).status, 200, path)
  }
  const memberAdmin = await request('/admin/supermarket', cookie)
  assert.equal(memberAdmin.status, 307)
  assert.equal(new URL(memberAdmin.headers.get('location'), origin).pathname, '/')
  assert.equal((await request('/admin/supermarket', signedToken(undefined, adminId))).status, 200)
})

test('bans, unverified email, session revocation and password resets reject previously signed cookies', { skip: !useFixtures }, async () => {
  const cookie = signedToken(undefined, memberId)
  for (const update of [
    { isBanned: true },
    { isBanned: false, emailVerifiedAt: null },
    { emailVerifiedAt: new Date(), sessionVersion: 1 },
    { sessionVersion: 0, hashedPassword: 'reset-test-hash' },
  ]) {
    await fixtureDb.user.update({ where: { id: memberId }, data: update })
    const response = await request('/rankings', cookie)
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get('location'), origin).pathname, '/auth')
  }
})
