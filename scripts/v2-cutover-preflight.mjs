import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "prisma/migrations");

export const REQUIRED_CUTOVER_MODE = "PAUSED";

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function evaluateV2CutoverSnapshot(snapshot) {
  const issues = [];
  const warnings = [];
  const localMigrations = sortedUnique(snapshot.localMigrations);
  const appliedMigrations = sortedUnique(snapshot.appliedMigrations);
  const localSet = new Set(localMigrations);
  const appliedSet = new Set(appliedMigrations);
  const missingMigrations = localMigrations.filter((name) => !appliedSet.has(name));
  const unexpectedMigrations = appliedMigrations.filter((name) => !localSet.has(name));

  if (snapshot.creationMode !== REQUIRED_CUTOVER_MODE) {
    issues.push(
      `V2_COMPETITIONS_CREATION_MODE must be ${REQUIRED_CUTOVER_MODE} while the preflight runs.`,
    );
  }
  if (snapshot.incompleteMigrationNames.length > 0) {
    issues.push(
      `unfinished database migrations: ${sortedUnique(snapshot.incompleteMigrationNames).join(", ")}`,
    );
  }
  if (missingMigrations.length > 0) {
    issues.push(`local migrations not deployed: ${missingMigrations.join(", ")}`);
  }
  if (unexpectedMigrations.length > 0) {
    issues.push(
      `database migrations absent from this release: ${unexpectedMigrations.join(", ")}`,
    );
  }
  if (snapshot.unfinishedLegacyFormalMatchCount > 0) {
    issues.push(
      `${snapshot.unfinishedLegacyFormalMatchCount} Legacy formal match(es) are still in registration or ongoing state.`,
    );
  }
  if (snapshot.pendingLegacyResultCount > 0) {
    warnings.push(
      `${snapshot.pendingLegacyResultCount} unresolved Legacy formal report(s) retained as ledger evidence; archive readers exclude them.`,
    );
  }
  if (snapshot.pendingV2RevisionCount > 0) {
    warnings.push(
      `${snapshot.pendingV2RevisionCount} pending V2 result revision(s) remain.`,
    );
  }
  if (snapshot.rolledBackMigrationNames.length > 0) {
    warnings.push(
      `migration history contains rolled-back attempts: ${sortedUnique(snapshot.rolledBackMigrationNames).join(", ")}`,
    );
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    warnings: Object.freeze(warnings),
    localMigrationCount: localMigrations.length,
    appliedMigrationCount: appliedMigrations.length,
  });
}

async function listLocalMigrations() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function collectSnapshot(db) {
  const [
    localMigrations,
    migrationRows,
    unfinishedLegacyFormalMatchCount,
    unfinishedLegacyFormalMatches,
    pendingLegacyResultCount,
    pendingV2RevisionCount,
    databaseIdentity,
  ] = await Promise.all([
    listLocalMigrations(),
    db.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
    ),
    db.match.count({
      where: {
        isQuickMatch: false,
        engineVersion: "LEGACY",
        status: { in: ["registration", "ongoing"] },
      },
    }),
    db.match.findMany({
      where: {
        isQuickMatch: false,
        engineVersion: "LEGACY",
        status: { in: ["registration", "ongoing"] },
      },
      orderBy: [{ dateTime: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        title: true,
        engineVersion: true,
        status: true,
        type: true,
        format: true,
        dateTime: true,
      },
    }),
    db.matchResult.count({
      where: {
        confirmed: false,
        match: { isQuickMatch: false, engineVersion: "LEGACY" },
      },
    }),
    db.resultRevision.count({ where: { status: "PENDING" } }),
    db.$queryRawUnsafe(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version",
    ),
  ]);

  const appliedMigrations = migrationRows
    .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
    .map((row) => row.migration_name);
  const incompleteMigrationNames = migrationRows
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name);
  const rolledBackMigrationNames = migrationRows
    .filter((row) => row.rolled_back_at !== null)
    .map((row) => row.migration_name);

  return {
    creationMode: process.env.V2_COMPETITIONS_CREATION_MODE,
    localMigrations,
    appliedMigrations,
    incompleteMigrationNames,
    rolledBackMigrationNames,
    unfinishedLegacyFormalMatchCount,
    unfinishedLegacyFormalMatches,
    pendingLegacyResultCount,
    pendingV2RevisionCount,
    databaseIdentity: databaseIdentity[0] ?? null,
  };
}

function printSnapshot(snapshot, result) {
  const identity = snapshot.databaseIdentity;
  if (identity) {
    console.log(
      `Database: ${identity.database_name} (PostgreSQL ${identity.server_version})`,
    );
  }
  console.log(`Creation mode: ${snapshot.creationMode ?? "<unset>"}`);
  console.log(
    `Migrations: ${result.appliedMigrationCount}/${result.localMigrationCount} applied`,
  );
  console.log(
    `Open formal matches: ${snapshot.unfinishedLegacyFormalMatchCount}; pending Legacy results: ${snapshot.pendingLegacyResultCount}; pending V2 revisions: ${snapshot.pendingV2RevisionCount}`,
  );

  for (const match of snapshot.unfinishedLegacyFormalMatches) {
    console.error(
      `  - ${match.id} | ${match.engineVersion} | ${match.status} | ${match.type}/${match.format} | ${match.dateTime.toISOString()} | ${match.title}`,
    );
  }
  if (snapshot.unfinishedLegacyFormalMatchCount > snapshot.unfinishedLegacyFormalMatches.length) {
    console.error(
      `  - ... ${snapshot.unfinishedLegacyFormalMatchCount - snapshot.unfinishedLegacyFormalMatches.length} more`,
    );
  }
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  for (const issue of result.issues) console.error(`BLOCKED: ${issue}`);
}

export async function runV2CutoverPreflight() {
  const databaseUrl =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required.");
  }

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const snapshot = await collectSnapshot(db);
    const result = evaluateV2CutoverSnapshot(snapshot);
    printSnapshot(snapshot, result);
    if (!result.ok) {
      process.exitCode = 1;
      return result;
    }
    console.log(
      "READY: keep creation PAUSED, deploy this exact release, then change only V2_COMPETITIONS_CREATION_MODE to V2.",
    );
    return result;
  } finally {
    await db.$disconnect();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runV2CutoverPreflight().catch((error) => {
    console.error(
      "BLOCKED: V2 cutover preflight could not complete.",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  });
}
