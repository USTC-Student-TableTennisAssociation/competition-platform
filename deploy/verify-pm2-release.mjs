import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyPm2Release(apps, release, revision, { processCwd } = {}) {
  const matches = apps.filter(app => app.name === 'kedapp');
  if (matches.length !== 1) throw new Error('Expected exactly one kedapp process.');
  const app = matches[0];
  const env = app.pm2_env;
  if (env.status !== 'online' || !Number.isInteger(app.pid) || app.pid <= 0) {
    throw new Error('kedapp is not running.');
  }
  if (resolve(env.pm_cwd) !== resolve(release) ||
      resolve(env.pm_exec_path) !== resolve(release, 'server.js')) {
    throw new Error('kedapp is still bound to a different release.');
  }
  if (processCwd && resolve(processCwd) !== resolve(release)) {
    throw new Error('The running process has a different working directory.');
  }
  if (readFileSync(resolve(release, 'REVISION'), 'utf8').trim() !== revision) {
    throw new Error('The running release has a different revision.');
  }
  return { pid: app.pid, revision, release: resolve(release) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const apps = JSON.parse(input);
    const app = apps.find(item => item.name === 'kedapp');
    const processCwd = process.platform === 'linux' && app?.pid > 0
      ? realpathSync(`/proc/${app.pid}/cwd`)
      : undefined;
    console.log(JSON.stringify(verifyPm2Release(apps, process.argv[2], process.argv[3], { processCwd })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
