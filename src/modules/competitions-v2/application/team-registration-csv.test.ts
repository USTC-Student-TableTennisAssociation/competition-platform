import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  TEAM_REGISTRATION_CSV_HEADERS,
  mapV2TeamRegistrationCsvRows,
  type V2TeamRegistrationCsvSource,
} from "../adapters/team-registration-csv";

function state(): V2TeamRegistrationCsvSource {
  return {
    match: { title: "秋季团体赛" },
    teams: [
      {
        name: "一队",
        captainNickname: "甲",
        contact: "123",
        remark: "备注",
        reviewNote: "已核验",
        status: "approved",
        members: [
          {
            nickname: "甲",
            isCurrentlyEligible: true,
          },
          {
            nickname: "乙",
            isCurrentlyEligible: true,
          },
          {
            nickname: "丙",
            isCurrentlyEligible: true,
          },
        ],
        entry: { status: "ACTIVE" },
      },
      {
        name: "二队",
        captainNickname: "丁",
        contact: null,
        remark: null,
        reviewNote: null,
        status: "draft",
        members: [
          {
            nickname: "丁",
            isCurrentlyEligible: true,
          },
        ],
        entry: null,
      },
      {
        name: "三队",
        captainNickname: "戊",
        contact: null,
        remark: null,
        reviewNote: null,
        status: "approved",
        members: [
          {
            nickname: "戊",
            isCurrentlyEligible: false,
          },
        ],
        entry: { status: "ACTIVE" },
      },
      {
        name: "四队",
        captainNickname: "己",
        contact: null,
        remark: null,
        reviewNote: null,
        status: "cancelled",
        members: [
          {
            nickname: "己",
            isCurrentlyEligible: true,
          },
        ],
        entry: null,
      },
    ],
  };
}

test("V2 TEAM CSV maps active and forming eligible sources without Legacy rows", () => {
  assert.deepEqual(TEAM_REGISTRATION_CSV_HEADERS, [
    "比赛名",
    "队名",
    "状态",
    "队长",
    "联系方式",
    "队员列表",
    "人数",
    "备注",
    "审核备注",
  ]);
  assert.deepEqual(mapV2TeamRegistrationCsvRows(state()), [
    ["秋季团体赛", "一队", "已成队", "甲", "123", "甲；乙；丙", 3, "备注", "已核验"],
    ["秋季团体赛", "二队", "组建中", "丁", "", "丁", 1, "", ""],
  ]);
});

test("the CSV route dispatches by engine and never falls V2 back to Legacy", () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/app/api/matchs/[id]/team-registrations.csv/route.ts",
    ),
    "utf8",
  );
  const v2Branch = source.indexOf('discriminator.engineVersion === "V2"');
  const legacyRead = source.indexOf('status: 410');
  assert.ok(v2Branch >= 0 && legacyRead > v2Branch);
  assert.match(source, /getV2TeamRegistrationReadState\(prisma, id\)/);
  assert.match(source, /V2TeamRegistrationIntegrityError/);
  assert.doesNotMatch(source, /V2 团体报名名单导出尚未开放/);
});
