import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260905130000_strengthen_v2_source_match_fks/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

test("source hardening migration is transactional and data preserving", () => {
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM|TRUNCATE/i);
});

test("doubles and team parents expose composite same-match identities", () => {
  assert.match(
    migration,
    /match_team_id_match_id_key[\s\S]*UNIQUE \("id", "match_id"\)/,
  );
  assert.match(
    migration,
    /match_doubles_team_id_match_id_key[\s\S]*UNIQUE \("id", "match_id"\)/,
  );
  assert.match(
    schema,
    /@@unique\(\[id, matchId\], map: "match_team_id_match_id_key"\)/,
  );
  assert.match(
    schema,
    /@@unique\(\[id, matchId\], map: "match_doubles_team_id_match_id_key"\)/,
  );
});

test("source members cascade only through a same-match composite parent", () => {
  for (const table of ["match_team_member", "match_doubles_team_member"]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "${table}"[\\s\\S]*FOREIGN KEY \\("team_id", "match_id"\\)[\\s\\S]*ON DELETE CASCADE`,
      ),
    );
  }
  assert.match(
    schema,
    /MatchTeam @relation\(fields: \[teamId, matchId\], references: \[id, matchId\], onDelete: Cascade/,
  );
  assert.match(
    schema,
    /MatchDoublesTeam @relation\(fields: \[teamId, matchId\], references: \[id, matchId\], onDelete: Cascade/,
  );
});

test("V2 Entry source links are same-match and cannot orphan history", () => {
  for (const source of ["source_doubles_team_id", "source_match_team_id"]) {
    assert.match(
      migration,
      new RegExp(
        `FOREIGN KEY \\(\\"${source}\\", \\"match_id\\"\\)[\\s\\S]*ON DELETE RESTRICT`,
      ),
    );
  }
  assert.match(
    schema,
    /sourceDoublesTeamId, matchId\], references: \[id, matchId\], onDelete: Restrict/,
  );
  assert.match(
    schema,
    /sourceMatchTeamId, matchId\], references: \[id, matchId\], onDelete: Restrict/,
  );
});
