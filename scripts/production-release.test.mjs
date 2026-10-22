import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { verifyPm2Release } from '../deploy/verify-pm2-release.mjs';
import { startRelease } from '../deploy/start-release.mjs';

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

test('PM2 uses the selected release database settings instead of stale inherited settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kedapp-pm2-env-'));
  const previous = process.env.DATABASE_URL;
  try {
    copyFileSync(new URL('../deploy/ecosystem.config.cjs', import.meta.url), join(directory, 'ecosystem.config.cjs'));
    const configured = 'postgresql://app:synthetic@127.0.0.1:5433/kedapp_standby';
    writeFileSync(join(directory, '.env'), `DATABASE_URL="${configured}"\nDATABASE_URL_UNPOOLED="${configured}"\n`, { mode: 0o600 });
    process.env.DATABASE_URL = 'postgresql://old:synthetic@old.invalid/old';
    const require = createRequire(import.meta.url);
    const app = require(join(directory, 'ecosystem.config.cjs')).apps[0];
    assert.equal(app.env.DATABASE_URL, configured);
    assert.equal(app.env.DATABASE_URL_UNPOOLED, configured);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a release environment with a missing database setting fails without revealing credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kedapp-pm2-invalid-env-'));
  try {
    copyFileSync(new URL('../deploy/ecosystem.config.cjs', import.meta.url), join(directory, 'ecosystem.config.cjs'));
    writeFileSync(join(directory, '.env'), 'DATABASE_URL="postgresql://app:private-marker@127.0.0.1:5433/kedapp_standby"\n', { mode: 0o600 });
    const require = createRequire(import.meta.url);
    assert.throws(() => require(join(directory, 'ecosystem.config.cjs')), error => {
      assert.equal(error.message, 'Missing or invalid DATABASE_URL_UNPOOLED.');
      assert.ok(!error.message.includes('private-marker'));
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rolling back to an older ecosystem explicitly injects current shared database settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kedapp-old-release-'));
  try {
    const configured = 'postgresql://app:synthetic@127.0.0.1:5433/kedapp_standby';
    writeFileSync(join(directory, '.env'), `DATABASE_URL="${configured}"\nDATABASE_URL_UNPOOLED="${configured}"\n`, { mode: 0o600 });
    writeFileSync(join(directory, 'ecosystem.config.cjs'), 'module.exports={apps:[{name:"kedapp",script:"server.js",env:{NODE_ENV:"production"}}]};');
    let called = false;
    startRelease(directory, { inherited: { PATH:'/bin', PGHOST:'old.invalid', DATABASE_URL:'postgresql://old:private-marker@old.invalid/old' }, spawnProcess: (program,args,options) => {
      called = true;
      assert.equal(program,'pm2');
      assert.deepEqual(args,['start',join(directory,'ecosystem.config.cjs'),'--only','kedapp']);
      assert.equal(options.env.DATABASE_URL,configured);
      assert.equal(options.env.DATABASE_URL_UNPOOLED,configured);
      assert.equal(options.env.PGHOST,undefined);
      return {status:0};
    } });
    assert.equal(called,true);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
