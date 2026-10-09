import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { verifyPm2Release } from '../deploy/verify-pm2-release.mjs';

const release = mkdtempSync(join(tmpdir(), 'kedapp-release-verification-'));
const revision = 'a'.repeat(40);
writeFileSync(join(release, 'REVISION'), revision + '\n');
after(() => rmSync(release, { recursive: true, force: true }));
const app = {
  name: 'kedapp', pid: 123,
  pm2_env: { status: 'online', pm_cwd: release, pm_exec_path: join(release, 'server.js') },
};

test('accepts the expected running release and ignores unrelated PM2 applications', () => {
  assert.equal(verifyPm2Release([app, { name: 'other' }], release, revision, { processCwd: release }).revision, revision);
});
test('rejects the deployment incident: healthy PM2 process still bound to the old release', () => {
  const old = { ...app, pm2_env: { ...app.pm2_env, pm_cwd: '/releases/old', pm_exec_path: '/releases/old/server.js' } };
  assert.throws(() => verifyPm2Release([old], release, revision), /different release/);
});
test('rejects a stale script even when the configured working directory is correct', () => {
  assert.throws(() => verifyPm2Release([{ ...app, pm2_env: { ...app.pm2_env, pm_exec_path: '/releases/old/server.js' } }], release, revision), /different release/);
});
test('rejects a stale real process working directory even when PM2 metadata is correct', () => {
  assert.throws(() => verifyPm2Release([app], release, revision, { processCwd: '/releases/old' }), /different working directory/);
});
test('rejects a stopped process and missing or duplicate instances', () => {
  assert.throws(() => verifyPm2Release([{ ...app, pm2_env: { ...app.pm2_env, status: 'stopped' } }], release, revision), /not running/);
  assert.throws(() => verifyPm2Release([], release, revision), /exactly one/);
  assert.throws(() => verifyPm2Release([app, app], release, revision), /exactly one/);
});
test('rejects a mismatched release revision', () => {
  assert.throws(() => verifyPm2Release([app], release, 'b'.repeat(40)), /different revision/);
});
