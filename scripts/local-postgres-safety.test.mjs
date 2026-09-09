import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./local-postgres.sh", import.meta.url), "utf8");

function functionBody(name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}\\n`, "m"));
  assert.ok(match, `missing ${name} function`);
  return match[1];
}

test("the integration database has one fixed local identity", () => {
  assert.match(script, /^PG_TEST_DATABASE="ustctta_v2_test"$/m);
  assert.match(
    script,
    /^LOCAL_TEST_DATABASE_URL="postgresql:\/\/\$\{PG_USER\}@127\.0\.0\.1:\$\{PG_PORT\}\/\$\{PG_TEST_DATABASE\}\?schema=public"$/m,
  );

  const guard = functionBody("assert_test_database_target");
  assert.match(guard, /\[\[ "\$\{PG_TEST_DATABASE\}" == "ustctta_v2_test" \]\]/);
  assert.match(guard, /expected_runtime_dir="\$\{PROJECT_ROOT\}\/\.local-postgres"/);
  assert.match(guard, /grep -Fxq 'USTCTTA-site dedicated local PostgreSQL runtime'/);
  assert.match(guard, /assert_cluster_endpoint/);
});

test("test rebuild validates the target before dropping only the test database", () => {
  const rebuild = functionBody("rebuild_test_database");
  const guardIndex = rebuild.indexOf("assert_test_database_target");
  const dropIndex = rebuild.indexOf('"${DROPDB}"');
  const createIndex = rebuild.indexOf('ensure_named_database "${PG_TEST_DATABASE}"');
  const migrateIndex = rebuild.indexOf('run_prisma_with_url "${LOCAL_TEST_DATABASE_URL}"');

  assert.ok(guardIndex >= 0 && guardIndex < dropIndex, "target guard must run before dropdb");
  assert.ok(dropIndex < createIndex, "dropdb must run before recreating the test database");
  assert.ok(createIndex < migrateIndex, "the empty test database must exist before migrations");
  assert.match(rebuild, /--maintenance-db=postgres/);
  assert.match(rebuild, /--force/);
  assert.match(rebuild, /"\$\{PG_TEST_DATABASE\}"/);
  assert.doesNotMatch(rebuild, /"\$\{PG_DATABASE\}"/);
});

test("the V2 test runner uses only the rebuilt integration-test database", () => {
  const runner = functionBody("run_v2_tests");

  assert.ok(
    runner.indexOf("rebuild_test_database") < runner.indexOf("npm run test:v2"),
    "test database must be rebuilt before the test command",
  );
  assert.match(runner, /DATABASE_URL="\$\{LOCAL_TEST_DATABASE_URL\}"/);
  assert.match(runner, /DATABASE_URL_UNPOOLED="\$\{LOCAL_TEST_DATABASE_URL\}"/);
  assert.match(runner, /V2_CORE_INTEGRATION_DATABASE_URL="\$\{LOCAL_TEST_DATABASE_URL\}"/);
  assert.doesNotMatch(runner, /LOCAL_DATABASE_URL/);
});

test("starting the cluster for tests does not create or alter the development database", () => {
  const startCluster = functionBody("start_cluster");
  const startDatabase = functionBody("start_database");

  assert.doesNotMatch(startCluster, /ensure_named_database/);
  assert.match(startDatabase, /ensure_named_database "\$\{PG_DATABASE\}"/);
});
