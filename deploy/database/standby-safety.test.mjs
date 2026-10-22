import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionEnvironment, parseBackupArgs, SNAPSHOT_SQL } from './export-neon.mjs';
import { connectionEnv } from './restore-standby.mjs';
import { pageHasErrorTemplate } from './web-smoke.mjs';

const source = 'postgresql://owner:dummy-password@ep-still-field-a1u573oe.ap-southeast-1.aws.neon.tech/neondb';
const standby = 'postgresql://kedapp_migrator:dummy-password@127.0.0.1:5433/kedapp_standby';

test('backup accepts only a new explicit absolute destination', () => {
  assert.deepEqual(parseBackupArgs(['--output-dir', '/private/backups/new']), { outputDir: '/private/backups/new' });
  for (const args of [[], ['--output-dir', '/'], ['--output-dir', 'relative'], ['--output-dir', '/tmp/a\n'], ['--output-dir', '/tmp/a', '--other']]) {
    assert.throws(() => parseBackupArgs(args));
  }
});

test('production export is locked to the original direct database', () => {
  for (const bad of [source.replace('neondb', 'other'), source.replace('.ap-southeast', '-pooler.ap-southeast'),
    source.replace('.tech/', '.tech:5434/'), source.replace('postgresql:', 'https:'), standby]) {
    assert.throws(() => createConnectionEnvironment(bad, {}));
  }
});

test('export ignores inherited PostgreSQL overrides and always verifies TLS and reads only', () => {
  const result = createConnectionEnvironment(source, { PGHOSTADDR: 'evil', PGSERVICE: 'evil',
    PGOPTIONS: '-c default_transaction_read_only=off', DATABASE_URL: 'evil', PATH: '/bin' });
  assert.equal(result.PGSSLMODE, 'verify-full');
  assert.equal(result.PGSSLROOTCERT, 'system');
  assert.equal(result.PGHOSTADDR, undefined);
  assert.equal(result.PGSERVICE, undefined);
  assert.equal(result.DATABASE_URL, undefined);
  assert.match(result.PGOPTIONS, /default_transaction_read_only=on/);
  assert.equal(result.PATH, '/bin');
  assert.match(SNAPSHOT_SQL, /REPEATABLE READ READ ONLY/);
  assert.match(SNAPSHOT_SQL, /pg_export_snapshot\(\)/);
});

test('restoration cannot target Neon, another local port, another database or an administrator', () => {
  for (const bad of [source, standby.replace('5433', '5432'), standby.replace('127.0.0.1', 'localhost'),
    standby.replace('kedapp_standby', 'postgres'), standby.replace('kedapp_migrator', 'postgres'),
    standby.replace('postgresql:', 'https:')]) {
    assert.throws(() => connectionEnv(bad, {}));
  }
});

test('restore clears inherited service files and host overrides before opting out of standby read-only default', () => {
  const result = connectionEnv(standby, { PGHOSTADDR: 'evil', PGSERVICEFILE: '/evil',
    PGDATABASE: 'production', DATABASE_URL: source, PATH: '/bin' });
  assert.equal(result.PGHOSTADDR, undefined);
  assert.equal(result.PGSERVICEFILE, undefined);
  assert.equal(result.DATABASE_URL, undefined);
  assert.equal(result.PGDATABASE, 'kedapp_standby');
  assert.equal(result.PGPORT, '5433');
  assert.equal(result.PGUSER, 'kedapp_migrator');
  assert.equal(result.PGHOST, '127.0.0.1');
  assert.match(result.PGOPTIONS, /default_transaction_read_only=off/);
});

test('web verification ignores serialized Next not-found boundaries but rejects rendered error pages', () => {
  assert.equal(pageHasErrorTemplate('<main>比赛分组</main><script>self.__next_f.push(["This page could not be found", "NEXT_HTTP_ERROR_FALLBACK"])</script>'), false);
  assert.equal(pageHasErrorTemplate('<h2>This page could not be found</h2>'), true);
  assert.equal(pageHasErrorTemplate('<html id="__next_error__"><body></body></html>'), true);
  assert.equal(pageHasErrorTemplate('<main>比赛详情暂不可用</main>'), true);
});
