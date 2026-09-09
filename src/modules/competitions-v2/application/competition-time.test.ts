import assert from "node:assert/strict";
import test from "node:test";

import {
  V2_COMPETITION_TIME_ZONE,
  V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
  formatV2CompetitionDateTime,
  getV2CompetitionLocalDateTimeParts,
} from "../competition-time";

test("V2 competition time is rendered deterministically in Asia/Shanghai", () => {
  assert.equal(V2_COMPETITION_TIME_ZONE, "Asia/Shanghai");
  assert.equal(V2_COMPETITION_TIMEZONE_OFFSET_MINUTES, -480);
  assert.deepEqual(
    getV2CompetitionLocalDateTimeParts("2026-10-01T11:30:00.000Z"),
    { date: "2026-10-01", time: "19:30" },
  );
  assert.equal(
    formatV2CompetitionDateTime(new Date("2026-12-31T16:30:00.000Z")),
    "2027/01/01 00:30",
  );
});

test("invalid instants fail closed instead of producing misleading labels", () => {
  assert.throws(
    () => getV2CompetitionLocalDateTimeParts("not-a-date"),
    /date-time is invalid/,
  );
});
