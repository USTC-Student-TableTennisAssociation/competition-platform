import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export function releaseDatabaseEnvironment(release) {
  let configured;
  try { configured = parseEnv(fs.readFileSync(path.join(release, '.env'), 'utf8')); }
  catch { throw new Error('Cannot read release database configuration.'); }
  const result = {};
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    let url;
    try { url = new URL(configured[key]); } catch { throw new Error(`Missing or invalid ${key}.`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error(`Invalid ${key} database configuration.`);
    result[key] = configured[key];
  }
  return result;
}

export function startRelease(release, { inherited = process.env, spawnProcess = spawnSync } = {}) {
  const database = releaseDatabaseEnvironment(release);
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(PG|DATABASE_URL)/i.test(key)));
  const result = spawnProcess('pm2', ['start', path.join(release, 'ecosystem.config.cjs'), '--only', 'kedapp'], {
    env: { ...clean, ...database }, stdio: 'inherit', timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error('Starting the selected release failed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--check' && process.argv.length === 4) releaseDatabaseEnvironment(path.resolve(process.argv[3]));
    else if (process.argv.length === 3) startRelease(path.resolve(process.argv[2]));
    else throw new Error('Invalid release startup arguments.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
