#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
RUNTIME_DIR="${PROJECT_ROOT}/.local-postgres"
DATA_DIR="${RUNTIME_DIR}/data"
SOCKET_DIR="${RUNTIME_DIR}/socket"
LOG_FILE="${RUNTIME_DIR}/postgres.log"
MARKER_FILE="${RUNTIME_DIR}/USTCTTA_LOCAL_POSTGRES"

PG_PORT="${USTCTTA_LOCAL_PG_PORT:-55432}"
PG_USER="ustctta_local"
PG_DATABASE="ustctta_v2"
PG_TEST_DATABASE="ustctta_v2_test"
LOCAL_DATABASE_URL="postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DATABASE}?schema=public"
LOCAL_TEST_DATABASE_URL="postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_TEST_DATABASE}?schema=public"

fail() {
  printf 'local-postgres: %s\n' "$*" >&2
  exit 1
}

in_restricted_codex_sandbox() {
  [[ -n "${CODEX_SANDBOX:-}" ]]
}

require_local_process_access() {
  if in_restricted_codex_sandbox; then
    fail "The restricted Codex sandbox cannot access host PostgreSQL processes or loopback. Re-run with local-process permission or from a normal terminal."
  fi
}

validate_port() {
  if [[ ! "${PG_PORT}" =~ ^[0-9]+$ ]] || (( PG_PORT < 1024 || PG_PORT > 65535 )); then
    fail "USTCTTA_LOCAL_PG_PORT must be an integer between 1024 and 65535."
  fi
}

resolve_pg_bin() {
  local candidate

  if [[ -n "${USTCTTA_LOCAL_PG_BIN:-}" ]]; then
    candidate="${USTCTTA_LOCAL_PG_BIN}"
    if [[ -x "${candidate}/postgres" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
    fail "USTCTTA_LOCAL_PG_BIN does not contain an executable postgres binary."
  fi

  for candidate in \
    /opt/homebrew/opt/postgresql@17/bin \
    /usr/local/opt/postgresql@17/bin
  do
    if [[ -x "${candidate}/postgres" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  if command -v postgres >/dev/null 2>&1; then
    candidate="$(cd "$(dirname "$(command -v postgres)")" && pwd -P)"
    if [[ -x "${candidate}/postgres" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  fi

  fail "PostgreSQL 17 was not found. On macOS, install it with: brew install postgresql@17"
}

validate_port
PG_BIN="$(resolve_pg_bin)"
POSTGRES="${PG_BIN}/postgres"
INITDB="${PG_BIN}/initdb"
PG_CTL="${PG_BIN}/pg_ctl"
PG_ISREADY="${PG_BIN}/pg_isready"
PSQL="${PG_BIN}/psql"
CREATEDB="${PG_BIN}/createdb"
DROPDB="${PG_BIN}/dropdb"

for binary in "${POSTGRES}" "${INITDB}" "${PG_CTL}" "${PG_ISREADY}" "${PSQL}" "${CREATEDB}" "${DROPDB}"; do
  [[ -x "${binary}" ]] || fail "Required PostgreSQL binary is missing: ${binary}"
done

PG_MAJOR="$("${POSTGRES}" --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
[[ "${PG_MAJOR}" == "17" ]] || fail "PostgreSQL 17 is required to match production; found $("${POSTGRES}" --version)."

ensure_runtime_dir() {
  if [[ -d "${RUNTIME_DIR}" && ! -f "${MARKER_FILE}" ]]; then
    if find "${RUNTIME_DIR}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      fail "${RUNTIME_DIR} is not marked as this project's local PostgreSQL directory; refusing to use it."
    fi
  fi

  mkdir -p "${RUNTIME_DIR}" "${SOCKET_DIR}"
  chmod 700 "${RUNTIME_DIR}" "${SOCKET_DIR}"

  if [[ ! -f "${MARKER_FILE}" ]]; then
    printf '%s\n' 'USTCTTA-site dedicated local PostgreSQL runtime' > "${MARKER_FILE}"
    chmod 600 "${MARKER_FILE}"
  fi

  grep -Fxq 'USTCTTA-site dedicated local PostgreSQL runtime' "${MARKER_FILE}" || \
    fail "The local PostgreSQL ownership marker is invalid; refusing to continue."
}

initialize_cluster() {
  ensure_runtime_dir

  if [[ -f "${DATA_DIR}/PG_VERSION" ]]; then
    [[ "$(tr -d '[:space:]' < "${DATA_DIR}/PG_VERSION")" == "17" ]] || \
      fail "The existing local cluster is not PostgreSQL 17."
    return
  fi

  if [[ -d "${DATA_DIR}" ]] && find "${DATA_DIR}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "${DATA_DIR} is non-empty but is not a valid PostgreSQL cluster."
  fi

  mkdir -p "${DATA_DIR}"
  chmod 700 "${DATA_DIR}"
  "${INITDB}" \
    --pgdata="${DATA_DIR}" \
    --username="${PG_USER}" \
    --encoding=UTF8 \
    --locale=C \
    --auth-local=trust \
    --auth-host=trust \
    --data-checksums \
    --no-instructions
}

cluster_is_running() {
  [[ -f "${DATA_DIR}/PG_VERSION" ]] && "${PG_CTL}" --pgdata="${DATA_DIR}" status >/dev/null 2>&1
}

assert_cluster_endpoint() {
  local expected_data_dir reported_data_dir

  expected_data_dir="$(cd "${DATA_DIR}" && pwd -P)"
  reported_data_dir="$(
    "${PSQL}" \
      --no-psqlrc \
      --host=127.0.0.1 \
      --port="${PG_PORT}" \
      --username="${PG_USER}" \
      --dbname=postgres \
      --tuples-only \
      --no-align \
      --command='SHOW data_directory'
  )"
  reported_data_dir="$(cd "${reported_data_dir}" && pwd -P)"

  [[ "${reported_data_dir}" == "${expected_data_dir}" ]] || \
    fail "Port ${PG_PORT} belongs to another PostgreSQL cluster; refusing to continue."
}

ensure_named_database() {
  local database_name="$1"
  local database_exists

  case "${database_name}" in
    "${PG_DATABASE}"|"${PG_TEST_DATABASE}") ;;
    *) fail "Refusing to manage unexpected database: ${database_name}" ;;
  esac

  database_exists="$(
    "${PSQL}" \
      --no-psqlrc \
      --host=127.0.0.1 \
      --port="${PG_PORT}" \
      --username="${PG_USER}" \
      --dbname=postgres \
      --tuples-only \
      --no-align \
      --command="SELECT 1 FROM pg_database WHERE datname = '${database_name}'"
  )"

  if [[ "${database_exists}" != "1" ]]; then
    "${CREATEDB}" \
      --host=127.0.0.1 \
      --port="${PG_PORT}" \
      --username="${PG_USER}" \
      --encoding=UTF8 \
      --template=template0 \
      "${database_name}"
  fi

  "${PSQL}" \
    --no-psqlrc \
    --host=127.0.0.1 \
    --port="${PG_PORT}" \
    --username="${PG_USER}" \
    --dbname=postgres \
    --set=ON_ERROR_STOP=1 \
    --command="ALTER DATABASE \"${database_name}\" SET timezone TO 'UTC'" \
    >/dev/null
}

start_cluster() {
  local readiness_status

  require_local_process_access
  initialize_cluster

  if cluster_is_running; then
    assert_cluster_endpoint
    printf 'Local PostgreSQL is already running at 127.0.0.1:%s.\n' "${PG_PORT}"
    return
  fi

  set +e
  "${PG_ISREADY}" --host=127.0.0.1 --port="${PG_PORT}" >/dev/null 2>&1
  readiness_status=$?
  set -e
  if (( readiness_status != 2 )); then
    fail "Port ${PG_PORT} is already used by another PostgreSQL server. Set USTCTTA_LOCAL_PG_PORT to a free port."
  fi

  "${PG_CTL}" \
    --pgdata="${DATA_DIR}" \
    --log="${LOG_FILE}" \
    --options="-h 127.0.0.1 -p ${PG_PORT} -k ${SOCKET_DIR} -c timezone=UTC" \
    --wait \
    start

  assert_cluster_endpoint
  printf 'Started local PostgreSQL 17 at 127.0.0.1:%s.\n' "${PG_PORT}"
}

start_database() {
  start_cluster
  ensure_named_database "${PG_DATABASE}"
}

stop_database() {
  require_local_process_access

  if [[ ! -f "${DATA_DIR}/PG_VERSION" ]]; then
    printf 'Local PostgreSQL has not been initialized.\n'
    return
  fi

  if ! cluster_is_running; then
    printf 'Local PostgreSQL is already stopped.\n'
    return
  fi

  "${PG_CTL}" --pgdata="${DATA_DIR}" --mode=fast --wait stop
  printf 'Stopped local PostgreSQL. Data remains in %s.\n' "${DATA_DIR}"
}

require_prisma() {
  [[ -x "${PROJECT_ROOT}/node_modules/.bin/prisma" ]] || \
    fail "Prisma is not installed. Run npm install first."
}

run_prisma_with_url() {
  local database_url="$1"
  shift
  require_prisma
  (
    cd "${PROJECT_ROOT}"
    env \
      DATABASE_URL="${database_url}" \
      DATABASE_URL_UNPOOLED="${database_url}" \
      "${PROJECT_ROOT}/node_modules/.bin/prisma" "$@"
  )
}

run_prisma() {
  run_prisma_with_url "${LOCAL_DATABASE_URL}" "$@"
}

migrate_database() {
  start_database
  run_prisma migrate deploy --schema="${PROJECT_ROOT}/prisma/schema.prisma"
}

verify_database() {
  start_database

  run_prisma migrate status --schema="${PROJECT_ROOT}/prisma/schema.prisma"
  run_prisma migrate diff \
    --from-url="${LOCAL_DATABASE_URL}" \
    --to-schema-datamodel="${PROJECT_ROOT}/prisma/schema.prisma" \
    --exit-code

  "${PSQL}" \
    --no-psqlrc \
    --host=127.0.0.1 \
    --port="${PG_PORT}" \
    --username="${PG_USER}" \
    --dbname="${PG_DATABASE}" \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT current_database() AS database, current_user AS role, current_setting('"'"'TimeZone'"'"') AS timezone, current_setting('"'"'server_version'"'"') AS postgres_version;'
}

confirm_rebuild() {
  if [[ "${1:-}" == "--yes" ]]; then
    return
  fi

  if [[ ! -t 0 ]]; then
    fail "Rebuild deletes only the ${PG_DATABASE} local database. Re-run with --yes to confirm."
  fi

  printf 'Type %s to rebuild the dedicated local database: ' "${PG_DATABASE}" >&2
  read -r confirmation
  [[ "${confirmation}" == "${PG_DATABASE}" ]] || fail "Rebuild cancelled."
}

rebuild_database() {
  confirm_rebuild "${1:-}"
  start_database
  assert_cluster_endpoint

  "${DROPDB}" \
    --host=127.0.0.1 \
    --port="${PG_PORT}" \
    --username="${PG_USER}" \
    --if-exists \
    --force \
    "${PG_DATABASE}"

  ensure_named_database "${PG_DATABASE}"
  run_prisma migrate deploy --schema="${PROJECT_ROOT}/prisma/schema.prisma"
  printf 'Rebuilt %s and applied all committed migrations.\n' "${PG_DATABASE}"
}

show_status() {
  printf 'PostgreSQL binaries: %s\n' "${PG_BIN}"
  printf 'Runtime directory:    %s\n' "${RUNTIME_DIR}"
  printf 'Development URL:      %s\n' "${LOCAL_DATABASE_URL}"
  printf 'Integration-test URL: %s\n' "${LOCAL_TEST_DATABASE_URL}"

  if [[ ! -f "${DATA_DIR}/PG_VERSION" ]]; then
    printf 'Status:               stopped (not initialized)\n'
  elif in_restricted_codex_sandbox && [[ -f "${DATA_DIR}/postmaster.pid" ]]; then
    printf 'Status:               unknown (restricted Codex sandbox cannot inspect the host process)\n'
    printf '                      Re-run with local-process permission or from a normal terminal.\n'
  elif cluster_is_running; then
    assert_cluster_endpoint
    printf 'Status:               running\n'
  else
    printf 'Status:               stopped\n'
  fi
}

show_env() {
  printf 'export DATABASE_URL=%q\n' "${LOCAL_DATABASE_URL}"
  printf 'export DATABASE_URL_UNPOOLED=%q\n' "${LOCAL_DATABASE_URL}"
  printf 'export V2_CORE_INTEGRATION_DATABASE_URL=%q\n' "${LOCAL_TEST_DATABASE_URL}"
}

run_with_local_database() {
  start_database
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  (( $# > 0 )) || fail "run requires a command after --."

  (
    cd "${PROJECT_ROOT}"
    env \
      DATABASE_URL="${LOCAL_DATABASE_URL}" \
      DATABASE_URL_UNPOOLED="${LOCAL_DATABASE_URL}" \
      "$@"
  )
}

assert_test_database_target() {
  local expected_runtime_dir

  [[ "${PG_TEST_DATABASE}" == "ustctta_v2_test" ]] || \
    fail "The integration-test database name is not the fixed safe target."
  expected_runtime_dir="${PROJECT_ROOT}/.local-postgres"
  [[ "${RUNTIME_DIR}" == "${expected_runtime_dir}" ]] || \
    fail "The integration-test runtime directory is not the fixed project path."
  grep -Fxq 'USTCTTA-site dedicated local PostgreSQL runtime' "${MARKER_FILE}" || \
    fail "The local PostgreSQL ownership marker is invalid; refusing to rebuild the test database."
  assert_cluster_endpoint
}

rebuild_test_database() {
  start_cluster
  assert_test_database_target

  "${DROPDB}" \
    --host=127.0.0.1 \
    --port="${PG_PORT}" \
    --username="${PG_USER}" \
    --maintenance-db=postgres \
    --if-exists \
    --force \
    "${PG_TEST_DATABASE}"

  ensure_named_database "${PG_TEST_DATABASE}"
  run_prisma_with_url "${LOCAL_TEST_DATABASE_URL}" \
    migrate deploy \
    --schema="${PROJECT_ROOT}/prisma/schema.prisma"
  printf 'Rebuilt %s and applied all committed migrations.\n' "${PG_TEST_DATABASE}"
}

run_v2_tests() {
  rebuild_test_database
  (
    cd "${PROJECT_ROOT}"
    env \
      DATABASE_URL="${LOCAL_TEST_DATABASE_URL}" \
      DATABASE_URL_UNPOOLED="${LOCAL_TEST_DATABASE_URL}" \
      V2_CORE_INTEGRATION_DATABASE_URL="${LOCAL_TEST_DATABASE_URL}" \
      npm run test:v2
  )
}

run_development_server() {
  migrate_database
  run_with_local_database -- npm run dev
}

open_psql() {
  start_database
  exec "${PSQL}" \
    --no-psqlrc \
    --host=127.0.0.1 \
    --port="${PG_PORT}" \
    --username="${PG_USER}" \
    --dbname="${PG_DATABASE}" \
    "$@"
}

usage() {
  cat <<'USAGE'
Usage: scripts/local-postgres.sh <command>

Commands:
  start             Initialize if needed, then start the dedicated local cluster.
  stop              Stop the cluster without deleting its data.
  status            Show the runtime path, URL, PostgreSQL binaries, and state.
  migrate           Start the cluster and apply all committed Prisma migrations.
  verify            Check migration status and diff the live schema against Prisma.
  rebuild [--yes]   Drop only ustctta_v2, recreate it, and apply all migrations.
  env               Print development and integration-test database exports.
  run -- COMMAND    Run a command with local DATABASE_URL variables.
  test-v2           Rebuild the separate test DB, then run all V2 PostgreSQL tests.
  dev               Apply migrations and run the Next.js development server.
  psql [ARGS...]    Open psql against the dedicated local database.

Optional environment:
  USTCTTA_LOCAL_PG_PORT  Loopback port (default: 55432).
  USTCTTA_LOCAL_PG_BIN   PostgreSQL 17 bin directory override.
USAGE
}

case "${1:-}" in
  start)
    start_database
    ;;
  stop)
    stop_database
    ;;
  status)
    show_status
    ;;
  migrate)
    migrate_database
    ;;
  verify)
    verify_database
    ;;
  rebuild)
    rebuild_database "${2:-}"
    ;;
  env)
    show_env
    ;;
  run)
    shift
    run_with_local_database "$@"
    ;;
  test-v2)
    run_v2_tests
    ;;
  dev)
    run_development_server
    ;;
  psql)
    shift
    open_psql "$@"
    ;;
  help|-h|--help|'')
    usage
    ;;
  *)
    usage >&2
    fail "Unknown command: $1"
    ;;
esac
