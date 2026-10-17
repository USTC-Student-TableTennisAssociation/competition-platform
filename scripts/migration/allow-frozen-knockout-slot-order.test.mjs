import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const sql=readFileSync(new URL('../../prisma/migrations/20261017030000_allow_frozen_knockout_slot_order/migration.sql',import.meta.url),'utf8');
test('frozen-slot migration preserves old authority and every business row',()=>{
 assert.match(sql,/BEGIN;/);assert.match(sql,/COMMIT;/);
 assert.match(sql,/"bracket_policy_version" IN \(2, 3\)/);
 assert.match(sql,/"schema_version" = 1/);
 assert.match(sql,/"layout_fingerprint" ~ '\^\[a-f0-9\]\{64\}\$'/);
 assert.doesNotMatch(sql,/\b(?:DELETE|UPDATE|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\b/i);
});
