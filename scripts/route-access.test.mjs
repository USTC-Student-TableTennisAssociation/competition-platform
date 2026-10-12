import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function loadTypeScript(relativePath) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const compiledModule = new Module(filename)
  compiledModule.paths = require.resolve.paths('typescript')
  compiledModule._compile(compiled, filename)
  return compiledModule.exports
}

const { isPublicRoute, isRouteWithin } = loadTypeScript('../src/lib/route-access.ts')
const { createSessionToken, verifySessionToken } = loadTypeScript('../src/lib/session.ts')
const previousSecret = process.env.AUTH_SECRET
process.env.AUTH_SECRET = 'route-access-unit-test-only'
test.after(() => {
  if (previousSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = previousSecret
})

test('login, verification, recovery and site-status routes remain reachable', () => {
  for (const path of ['/auth', '/auth/verify', '/auth/reset-password', '/api/csrf-token', '/api/site-status', '/api/health', '/closed']) {
    assert.equal(isPublicRoute(path), true, path)
  }
})

test('business pages and lookalike public prefixes remain protected', () => {
  for (const path of ['/', '/rankings', '/matchs', '/supermarket', '/supermarket/preview', '/admin', '/administrator', '/authentication', '/closed-data', '/api/site-status-secret', '/api/health-private', '/profile/member.name', '/api/matchs/id/team-registrations.csv']) {
    assert.equal(isPublicRoute(path), false, path)
  }
  assert.equal(isRouteWithin('/admin/supermarket', '/admin'), true)
  assert.equal(isRouteWithin('/administrator', '/admin'), false)
})

test('only known asset namespaces bypass authentication', () => {
  for (const path of ['/_next/static/app.js', '/_next/image', '/robots.txt', '/SVG/tta-badge.svg', '/supermarket/towel-design.png', '/uploads/supermarket/prize-1.webp']) {
    assert.equal(isPublicRoute(path), true, path)
  }
  for (const path of ['/profile/member.svg', '/matchs/id.png', '/supermarket/preview/catalog.svg', '/uploads/arbitrary.json']) {
    assert.equal(isPublicRoute(path), false, path)
  }
})

test('a non-empty, forged or modified session cannot pass the entry filter', () => {
  const token = createSessionToken('unit-member', 'test-password-hash', 3)
  assert.equal(verifySessionToken(token)?.userId, 'unit-member')
  assert.equal(verifySessionToken(token)?.sessionVersion, 3)
  for (const raw of ['1', 'forged', token.replace('unit-member', 'another-member'), token.slice(0, -4), token.replace('.3.', '.4.')]) {
    assert.equal(verifySessionToken(raw), null)
  }
})

test('an expired signed session cannot pass the entry filter', () => {
  const parts = createSessionToken('unit-member', 'test-password-hash', 0).split('.')
  parts[2] = String(Date.now() - 1000)
  const payload = parts.slice(0, -1).join('.')
  parts[5] = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('hex')
  assert.equal(verifySessionToken(parts.join('.')), null)
})
