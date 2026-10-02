import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const serverDir = new URL('../.next/server/', import.meta.url)
const manifest = JSON.parse(
  readFileSync(new URL('server-reference-manifest.json', serverDir), 'utf8'),
)

// Next can compile a non-function export in a 'use server' file successfully,
// then reject it when the action module is first loaded by a request.
for (const [filename, exportedName] of [
  ['app/supermarket/actions.ts', 'supermarketMemberAction'],
  ['app/admin/supermarket/actions.ts', 'supermarketAdminAction'],
]) {
  test(`${filename} loads its built server action at runtime`, () => {
    const entries = Object.entries(manifest.node).filter(
      ([, entry]) => entry.filename === filename,
    )
    assert.ok(entries.some(([, entry]) => entry.exportedName === exportedName))

    for (const [actionId, entry] of entries) {
      for (const [pagePath, worker] of Object.entries(entry.workers)) {
        const page = require(fileURLToPath(new URL(`${pagePath}.js`, serverDir)))
        const exports = page.__next_app__.require(worker.moduleId)
        assert.equal(typeof exports[actionId], 'function')
      }
    }
  })
}
