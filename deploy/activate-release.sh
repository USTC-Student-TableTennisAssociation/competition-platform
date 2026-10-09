#!/usr/bin/env bash
set -euo pipefail

SHA="$1"
APP_ROOT="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

[[ "$SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$APP_ROOT" = /* ]]
APP_ROOT="$(cd "$APP_ROOT" && pwd -P)"
RELEASE="$APP_ROOT/releases/$SHA"

test -f "$RELEASE/server.js"
test -f "$RELEASE/ecosystem.config.cjs"
test "$(cat "$RELEASE/REVISION")" = "$SHA"

# Validate the new declaration before stopping the existing application.
node - "$RELEASE" <<'NODE'
const path = require('node:path');
const release = process.argv[2];
const config = require(path.join(release, 'ecosystem.config.cjs'));
const app = config.apps?.[0];
if (config.apps?.length !== 1 || app.name !== 'kedapp' ||
    path.resolve(app.cwd) !== release || app.script !== 'server.js') {
  throw new Error('Invalid kedapp release declaration.');
}
NODE

# The symlink may already point to a release that PM2 never started.
# Keep the actual running release as the rollback target.
RUNNING_RELEASE="$(pm2 jlist | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
  const apps = JSON.parse(input).filter(app => app.name === "kedapp");
  if (apps.length > 1) throw new Error("Duplicate kedapp processes.");
  if (apps.length === 1) {
    if (!apps[0].pm2_env.pm_cwd) throw new Error("Missing kedapp working directory.");
    process.stdout.write(apps[0].pm2_env.pm_cwd);
  }
});')"

if [ -n "$RUNNING_RELEASE" ]; then
  OLD_RELEASE="$(cd "$RUNNING_RELEASE" && pwd -P)"
elif [ -L "$APP_ROOT/current" ]; then
  OLD_RELEASE="$(readlink -f "$APP_ROOT/current")"
else
  OLD_RELEASE=""
fi

if [ -n "$OLD_RELEASE" ] && [ "$OLD_RELEASE" != "$RELEASE" ]; then
  [[ "$OLD_RELEASE" == "$APP_ROOT/releases/"* ]]
  test -f "$OLD_RELEASE/server.js"
  test -s "$OLD_RELEASE/REVISION"
  ln -sfn "$OLD_RELEASE" "$APP_ROOT/previous.new"
  mv -Tf "$APP_ROOT/previous.new" "$APP_ROOT/previous"
fi

ln -sfn "$RELEASE" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"

# Reload retains the original absolute script/cwd for this named process.
# Recreate only kedapp so PM2 resolves the new release paths.
if [ -n "$RUNNING_RELEASE" ]; then
  pm2 delete kedapp
fi
pm2 start "$RELEASE/ecosystem.config.cjs" --only kedapp
pm2 jlist | node "$SCRIPT_DIR/verify-pm2-release.mjs" "$RELEASE" "$SHA"
pm2 save
