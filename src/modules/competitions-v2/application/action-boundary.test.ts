import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";

import {
  V2ActionBoundaryError,
  assertNoProtectedClientFields,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseNonNegativeSafeInteger,
  parseSingleResultCorrection,
  parseSingleResultSubmission,
  parseStableIdentifier,
  parseV2RevisionTarget,
  readStableIdentifier,
} from "../adapters/action-boundary";
import {
  parseV2SingleGroupingPreviewForm,
  parseV2SingleGroupingPublication,
} from "../adapters/single-grouping-boundary";
import { parseV2SingleGroupTableLabelsForm } from "../adapters/single-group-table-labels-boundary";
import {
  parseV2GroupOnlyForfeit,
  parseV2GroupOnlyForfeitCorrection,
  parseV2GroupOnlyResultSubmission,
} from "../adapters/group-only-result-boundary";
import { parseV2TeamResultSubmission } from "../adapters/team-result-boundary";
import { CompetitionDomainError } from "../domain";
import { V2_MAX_TEAM_SCORE_PER_FIXTURE } from "../domain/group-standings";
import { V2CompetitionApplicationError } from "./entries";
import { RegistrationSettlementError } from "./registration-settlements";
import { V2ResultApplicationError } from "./results-errors";

function expectBoundaryError(
  operation: () => unknown,
  code: V2ActionBoundaryError["code"],
  field?: string,
) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof V2ActionBoundaryError &&
      error.code === code &&
      (field === undefined || error.field === field),
  );
}

function validSubmissionForm() {
  const formData = new FormData();
  formData.set("fixtureId", "fixture-1");
  formData.set("expectedFixtureVersion", "2");
  formData.set("winnerEntryId", "entry-a");
  formData.set("loserEntryId", "entry-b");
  formData.set("bestOf", "5");
  formData.set("winnerScore", "3");
  formData.set("loserScore", "1");
  return formData;
}

test("native React action metadata is ignored without accepting protected result fields", () => {
  for (const team of [false, true]) {
    const form = validSubmissionForm();
    form.delete("loserEntryId");
    if (team) form.delete("bestOf");
    form.set("$ACTION_REF_12", "");
    form.set("$ACTION_12:0", '{"id":"server-action"}');
    form.set("$ACTION_KEY", "action-state");
    const parse = team ? parseV2TeamResultSubmission : parseV2GroupOnlyResultSubmission;
    assert.equal(parse(form).winnerEntryId, "entry-a");
    form.set("actorId", "forged-admin");
    expectBoundaryError(() => parse(form), "PROTECTED_FIELD", "actorId");
  }
});

function validGroupingPublicationPayload() {
  return {
    generatedAt: "2026-09-04T08:00:00.000Z",
    competitorType: "user",
    format: "group_only",
    config: {
      groupCount: 2,
      seedMethod: "snake",
    },
    groups: [
      {
        name: "任意客户端组名 A",
        averagePoints: 9_999,
        players: [
          { id: "entry-a", nickname: "伪造昵称 A", points: 999, eloRating: 9_999 },
          { id: "entry-b", nickname: "伪造昵称 B", points: 999, eloRating: 9_999 },
        ],
      },
      {
        name: "任意客户端组名 B",
        averagePoints: 1,
        players: [
          { id: "entry-c", nickname: "伪造昵称 C", points: 0, eloRating: 1 },
          { id: "entry-d", nickname: "伪造昵称 D", points: 0, eloRating: 1 },
        ],
      },
    ],
    v2Preview: {
      schemaVersion: 1,
      matchId: "match-1",
      expectedEntries: [
        { entryId: "entry-a", version: 2 },
        { entryId: "entry-b", version: 4 },
        { entryId: "entry-c", version: 6 },
        { entryId: "entry-d", version: 8 },
      ],
    },
  };
}

test("the V2 boundary rejects duplicate, non-text, and malformed identifiers", () => {
  const duplicates = new FormData();
  duplicates.append("fixtureId", "fixture-1");
  duplicates.append("fixtureId", "fixture-2");
  expectBoundaryError(
    () => readStableIdentifier(duplicates, "fixtureId"),
    "INVALID_FORM_FIELD",
    "fixtureId",
  );

  const fileValue = {
    getAll: (field: string) =>
      field === "fixtureId" ? ([new Blob(["fixture-1"])] as FormDataEntryValue[]) : [],
  } as unknown as FormData;
  expectBoundaryError(
    () => readStableIdentifier(fileValue, "fixtureId"),
    "INVALID_FORM_FIELD",
    "fixtureId",
  );

  for (const value of ["", " fixture-1", "fixture-1 ", "fixture\u0000x"]) {
    expectBoundaryError(
      () => parseStableIdentifier(value, "fixtureId"),
      "INVALID_IDENTIFIER",
      "fixtureId",
    );
  }
  assert.equal(parseStableIdentifier("fixture-1", "fixtureId"), "fixture-1");
});

test("the complete V2 form boundary rejects duplicate keys and any File value", () => {
  const duplicate = new FormData();
  duplicate.append("unknown", "first");
  duplicate.append("unknown", "second");
  expectBoundaryError(
    () => assertUniqueTextFormData(duplicate),
    "INVALID_FORM_FIELD",
    "unknown",
  );

  const fileValue = new FormData();
  fileValue.append("unknown", new Blob(["payload"]), "payload.txt");
  expectBoundaryError(
    () => assertUniqueTextFormData(fileValue),
    "INVALID_FORM_FIELD",
    "unknown",
  );

  const textOnly = new FormData();
  textOnly.set("unknown", "one");
  textOnly.set("csrfToken", "token");
  assert.doesNotThrow(() => assertUniqueTextFormData(textOnly));
});

test("the V2 boundary requires exactly one non-empty CSRF token", () => {
  const missing = new FormData();
  expectBoundaryError(
    () => assertSingleCsrfField(missing),
    "INVALID_CSRF_FIELD",
    "csrfToken",
  );

  const duplicated = new FormData();
  duplicated.append("csrfToken", "first");
  duplicated.append("csrfToken", "second");
  expectBoundaryError(
    () => assertSingleCsrfField(duplicated),
    "INVALID_CSRF_FIELD",
    "csrfToken",
  );

  const valid = new FormData();
  valid.set("csrfToken", "token");
  assert.doesNotThrow(() => assertSingleCsrfField(valid));
});

test("trusted actor, role, state, override, and settlement inputs cannot come from the client", () => {
  for (const field of [
    "actorId",
    "role",
    "kind",
    "sourceId",
    "status",
    "engineVersion",
    "adminOverride",
    "overrideReason",
    "settlementPort",
    "pointsPolicy",
    "clock",
    "metadata",
    "expectedEntries",
    "draft",
    "groupingService",
    "groupTableLabelsService",
    "fixtureStatusTransition",
    "resultService",
    "requiredFixtureStage",
    "supersedesRevisionId",
  ]) {
    const formData = new FormData();
    formData.set(field, "attacker-controlled");
    expectBoundaryError(
      () => assertNoProtectedClientFields(formData),
      "PROTECTED_FIELD",
      field,
    );
  }

  const ordinary = new FormData();
  ordinary.set("fixtureId", "fixture-1");
  assert.doesNotThrow(() => assertNoProtectedClientFields(ordinary));
});

test("versions and scores use canonical safe integers", () => {
  assert.equal(parseNonNegativeSafeInteger("0", "version"), 0);
  assert.equal(parseNonNegativeSafeInteger("42", "version"), 42);
  assert.equal(
    parseNonNegativeSafeInteger("2147483647", "version"),
    2_147_483_647,
  );

  for (const value of [
    "",
    " 1",
    "1 ",
    "+1",
    "01",
    "1.0",
    "1e2",
    "-1",
    "2147483648",
    "9007199254740992",
  ]) {
    expectBoundaryError(
      () => parseNonNegativeSafeInteger(value, "version"),
      "INVALID_INTEGER",
      "version",
    );
  }

  const parsed = parseSingleResultSubmission(validSubmissionForm());
  assert.deepEqual(parsed, {
    fixtureId: "fixture-1",
    expectedFixtureVersion: 2,
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    score: {
      bestOf: 5,
      winnerScore: 3,
      loserScore: 1,
      text: "3:1（5局3胜）",
    },
  });

  const invalidBestOf = validSubmissionForm();
  invalidBestOf.set("bestOf", "9");
  expectBoundaryError(
    () => parseSingleResultSubmission(invalidBestOf),
    "INVALID_SCORE",
    "bestOf",
  );

  const invalidWinningScore = validSubmissionForm();
  invalidWinningScore.set("winnerScore", "2");
  expectBoundaryError(
    () => parseSingleResultSubmission(invalidWinningScore),
    "INVALID_SCORE",
    "winnerScore",
  );

  const tiedEntries = validSubmissionForm();
  tiedEntries.set("loserEntryId", "entry-a");
  expectBoundaryError(
    () => parseSingleResultSubmission(tiedEntries),
    "INVALID_SCORE",
    "winnerEntryId",
  );

  const correction = new FormData();
  correction.set("fixtureId", "fixture-1");
  correction.set("expectedFixtureVersion", "7");
  correction.set("resultRevisionId", "revision-confirmed");
  correction.set("bestOf", "7");
  correction.set("winnerScore", "4");
  correction.set("loserScore", "2");
  assert.deepEqual(parseSingleResultCorrection(correction), {
    fixtureId: "fixture-1",
    expectedFixtureVersion: 7,
    resultRevisionId: "revision-confirmed",
    correctionMode: "SWAP_WINNER",
    score: {
      bestOf: 7,
      winnerScore: 4,
      loserScore: 2,
      text: "4:2（7局4胜）",
    },
  });

  for (const participantField of ["winnerEntryId", "loserEntryId"] as const) {
    const spoofed = new FormData();
    for (const [field, value] of correction.entries()) {
      spoofed.set(field, value);
    }
    spoofed.set(participantField, "attacker-entry");
    expectBoundaryError(
      () => parseSingleResultCorrection(spoofed),
      "PROTECTED_FIELD",
      participantField,
    );
  }

  correction.set("correctionMode", "KEEP_WINNER");
  assert.equal(
    parseSingleResultCorrection(correction).correctionMode,
    "KEEP_WINNER",
  );
  correction.set("correctionMode", "client-selected-winner");
  expectBoundaryError(
    () => parseSingleResultCorrection(correction),
    "INVALID_FORM_FIELD",
    "correctionMode",
  );
});

test("grouping preview parameters are canonical and reject unknown fields", () => {
  const valid = new FormData();
  valid.set("csrfToken", "token");
  valid.set("groupCount", "2");
  valid.set("qualifiersPerGroup", "1");
  valid.set("seedMethod", "snake");
  assert.deepEqual(parseV2SingleGroupingPreviewForm(valid), {
    groupCount: 2,
    qualifiersPerGroup: 1,
    seedMethod: "snake",
  });

  for (const [field, value, code] of [
    ["groupCount", "02", "INVALID_INTEGER"],
    ["groupCount", "0", "INVALID_FORM_FIELD"],
    ["seedMethod", "random", "INVALID_FORM_FIELD"],
  ] as const) {
    const invalid = new FormData();
    invalid.set("csrfToken", "token");
    invalid.set("groupCount", "2");
    invalid.set("seedMethod", "snake");
    invalid.set(field, value);
    expectBoundaryError(
      () => parseV2SingleGroupingPreviewForm(invalid),
      code,
      field,
    );
  }

  const unknown = new FormData();
  unknown.set("csrfToken", "token");
  unknown.set("groupCount", "2");
  unknown.set("seedMethod", "snake");
  unknown.set("actorId", "attacker");
  expectBoundaryError(
    () => parseV2SingleGroupingPreviewForm(unknown),
    "INVALID_FORM_FIELD",
    "actorId",
  );
});

test("grouping publication keeps only Entry identities, versions, and structure", () => {
  const formData = new FormData();
  formData.set("csrfToken", "token");
  formData.set(
    "previewJson",
    JSON.stringify(validGroupingPublicationPayload()),
  );

  assert.deepEqual(parseV2SingleGroupingPublication(formData, "match-1"), {
    expectedEntries: [
      { entryId: "entry-a", version: 2 },
      { entryId: "entry-b", version: 4 },
      { entryId: "entry-c", version: 6 },
      { entryId: "entry-d", version: 8 },
    ],
    draft: {
      format: "group_only",
      groups: [
        { entryIds: ["entry-a", "entry-b"] },
        { entryIds: ["entry-c", "entry-d"] },
      ],
      seedMethod: "snake",
    },
  });
});

test("grouping publication fails closed on dropped or extra keys, stale match identity, and oversized JSON", () => {
  for (const unsupportedPayload of [
    {
      ...validGroupingPublicationPayload(),
      actorId: "attacker",
    },
    {
      ...validGroupingPublicationPayload(),
      tableAssignments: { group: { "第 1 组": ["1"] } },
    },
    {
      ...validGroupingPublicationPayload(),
      knockout: { stage: "决赛", bracketSize: 2, rounds: [] },
    },
  ]) {
    const unsupported = new FormData();
    unsupported.set("csrfToken", "token");
    unsupported.set("previewJson", JSON.stringify(unsupportedPayload));
    expectBoundaryError(
      () => parseV2SingleGroupingPublication(unsupported, "match-1"),
      "INVALID_FORM_FIELD",
      "previewJson",
    );
  }

  const wrongMatchForm = new FormData();
  wrongMatchForm.set("csrfToken", "token");
  wrongMatchForm.set(
    "previewJson",
    JSON.stringify({
      ...validGroupingPublicationPayload(),
      v2Preview: {
        ...validGroupingPublicationPayload().v2Preview,
        matchId: "match-2",
      },
    }),
  );
  expectBoundaryError(
    () => parseV2SingleGroupingPublication(wrongMatchForm, "match-1"),
    "INVALID_FORM_FIELD",
    "previewJson",
  );

  const oversized = new FormData();
  oversized.set("csrfToken", "token");
  oversized.set("previewJson", "x".repeat(512 * 1_024 + 1));
  expectBoundaryError(
    () => parseV2SingleGroupingPublication(oversized, "match-1"),
    "INVALID_FORM_FIELD",
    "previewJson",
  );
});

test("group-then-knockout publication preserves only qualifier policy and Entry placement", () => {
  const payload = validGroupingPublicationPayload();
  const formData = new FormData();
  formData.set("csrfToken", "token");
  formData.set(
    "previewJson",
    JSON.stringify({
      ...payload,
      format: "group_then_knockout",
      config: { ...payload.config, qualifiersPerGroup: 1 },
    }),
  );
  assert.deepEqual(parseV2SingleGroupingPublication(formData, "match-1"), {
    expectedEntries: payload.v2Preview.expectedEntries,
    draft: {
      format: "group_then_knockout",
      groups: [
        { entryIds: ["entry-a", "entry-b"] },
        { entryIds: ["entry-c", "entry-d"] },
      ],
      seedMethod: "snake",
      qualifiersPerGroup: 1,
    },
  });
});

test("group table labels accept only a complete versioned fixture target and strict string array", () => {
  const valid = new FormData();
  valid.set("csrfToken", "token");
  valid.set("groupKey", "group:0001");
  valid.set(
    "expectedFixturesJson",
    JSON.stringify([
      { fixtureId: "fixture-1", version: 4 },
      { fixtureId: "fixture-2", version: 9 },
    ]),
  );
  valid.set("labelsJson", JSON.stringify(["1 号台", "西区馆 A"]));
  assert.deepEqual(parseV2SingleGroupTableLabelsForm(valid), {
    groupKey: "group:0001",
    expectedFixtures: [
      { fixtureId: "fixture-1", version: 4 },
      { fixtureId: "fixture-2", version: 9 },
    ],
    labels: ["1 号台", "西区馆 A"],
  });

  for (const labels of [
    [" 1 号台"],
    ["1 号台", "1 号台"],
    ["1\t号台"],
    ["x".repeat(65)],
  ]) {
    const invalid = new FormData();
    for (const [field, value] of valid.entries()) invalid.set(field, value);
    invalid.set("labelsJson", JSON.stringify(labels));
    expectBoundaryError(
      () => parseV2SingleGroupTableLabelsForm(invalid),
      "INVALID_FORM_FIELD",
      "labelsJson",
    );
  }

  const duplicateFixtures = new FormData();
  for (const [field, value] of valid.entries()) duplicateFixtures.set(field, value);
  duplicateFixtures.set(
    "expectedFixturesJson",
    JSON.stringify([
      { fixtureId: "fixture-1", version: 4 },
      { fixtureId: "fixture-1", version: 4 },
    ]),
  );
  expectBoundaryError(
    () => parseV2SingleGroupTableLabelsForm(duplicateFixtures),
    "INVALID_FORM_FIELD",
    "expectedFixturesJson",
  );

  const unknown = new FormData();
  for (const [field, value] of valid.entries()) unknown.set(field, value);
  unknown.set("groupName", "客户端伪造组名");
  expectBoundaryError(
    () => parseV2SingleGroupTableLabelsForm(unknown),
    "INVALID_FORM_FIELD",
    "groupName",
  );
});

test("revision reasons reject duplicates and files, trim text, and cap length", () => {
  const valid = new FormData();
  valid.set("fixtureId", "fixture-1");
  valid.set("expectedFixtureVersion", "3");
  valid.set("resultRevisionId", "revision-1");
  valid.set("reason", "  比分录入错误  ");
  assert.deepEqual(parseV2RevisionTarget(valid, { includeReason: true }), {
    fixtureId: "fixture-1",
    expectedFixtureVersion: 3,
    resultRevisionId: "revision-1",
    reason: "比分录入错误",
  });

  const duplicate = new FormData();
  duplicate.set("fixtureId", "fixture-1");
  duplicate.set("expectedFixtureVersion", "3");
  duplicate.set("resultRevisionId", "revision-1");
  duplicate.append("reason", "first");
  duplicate.append("reason", "second");
  expectBoundaryError(
    () => parseV2RevisionTarget(duplicate, { includeReason: true }),
    "INVALID_FORM_FIELD",
    "reason",
  );

  const tooLong = new FormData();
  tooLong.set("fixtureId", "fixture-1");
  tooLong.set("expectedFixtureVersion", "3");
  tooLong.set("resultRevisionId", "revision-1");
  tooLong.set("reason", "x".repeat(501));
  expectBoundaryError(
    () => parseV2RevisionTarget(tooLong, { includeReason: true }),
    "INVALID_REASON",
    "reason",
  );

  const fileReason = {
    getAll: (field: string) => {
      if (field === "fixtureId") return ["fixture-1"];
      if (field === "expectedFixtureVersion") return ["3"];
      if (field === "resultRevisionId") return ["revision-1"];
      if (field === "reason") return [new Blob(["reason"])];
      return [];
    },
  } as unknown as FormData;
  expectBoundaryError(
    () => parseV2RevisionTarget(fileReason, { includeReason: true }),
    "INVALID_FORM_FIELD",
    "reason",
  );
});

test("group-only result forms reject unknown fields and forfeit never accepts a loser", () => {
  const submission = validSubmissionForm();
  submission.delete("loserEntryId");
  submission.set("clientNote", "not accepted");
  expectBoundaryError(
    () => parseV2GroupOnlyResultSubmission(submission),
    "INVALID_FORM_FIELD",
    "clientNote",
  );

  const forfeit = new FormData();
  forfeit.set("fixtureId", "fixture-1");
  forfeit.set("expectedFixtureVersion", "4");
  forfeit.set("winnerEntryId", "entry-a");
  forfeit.set("reason", "  对方弃权  ");
  assert.deepEqual(parseV2GroupOnlyForfeit(forfeit), {
    fixtureId: "fixture-1",
    expectedFixtureVersion: 4,
    winnerEntryId: "entry-a",
    reason: "对方弃权",
  });

  forfeit.set("loserEntryId", "client-selected-loser");
  expectBoundaryError(
    () => parseV2GroupOnlyForfeit(forfeit),
    "PROTECTED_FIELD",
    "loserEntryId",
  );
  forfeit.delete("loserEntryId");
  forfeit.set("reason", "   ");
  expectBoundaryError(
    () => parseV2GroupOnlyForfeit(forfeit),
    "INVALID_REASON",
    "reason",
  );

  const correction = new FormData();
  correction.set("fixtureId", "fixture-1");
  correction.set("expectedFixtureVersion", "5");
  correction.set("resultRevisionId", "forfeit-confirmed");
  correction.set("reason", "  判错胜方  ");
  assert.deepEqual(parseV2GroupOnlyForfeitCorrection(correction), {
    fixtureId: "fixture-1",
    expectedFixtureVersion: 5,
    resultRevisionId: "forfeit-confirmed",
    reason: "判错胜方",
  });
  for (const protectedField of ["winnerEntryId", "loserEntryId"] as const) {
    correction.set(protectedField, "client-side");
    expectBoundaryError(
      () => parseV2GroupOnlyForfeitCorrection(correction),
      "PROTECTED_FIELD",
      protectedField,
    );
    correction.delete(protectedField);
  }
});

test("TEAM score boundary rejects totals above the shared fixture limit", () => {
  const form = new FormData();
  form.set("fixtureId", "fixture-1");
  form.set("expectedFixtureVersion", "1");
  form.set("winnerEntryId", "entry-a");
  form.set("winnerScore", String(V2_MAX_TEAM_SCORE_PER_FIXTURE + 1));
  form.set("loserScore", "0");
  expectBoundaryError(
    () => parseV2TeamResultSubmission(form),
    "INVALID_SCORE",
    "winnerScore",
  );
});

test("internal V2 and Prisma errors map to stable Chinese messages without leaking details", () => {
  const cases: Array<{
    error: unknown;
    message: string;
    shouldLog: boolean;
  }> = [
    {
      error: new V2CompetitionApplicationError(
        "FORBIDDEN",
        "secret authorization details",
      ),
      message: "你没有权限执行此操作。",
      shouldLog: false,
    },
    {
      error: new V2ResultApplicationError(
        "STALE_FIXTURE_VERSION",
        "secret version details",
      ),
      message: "数据已被其他操作更新，请刷新页面后重试。",
      shouldLog: false,
    },
    {
      error: new CompetitionDomainError(
        "ENGINE_WRITE_MISMATCH",
        "secret engine details",
      ),
      message: "比赛处理模式已变化，请刷新页面后重试。",
      shouldLog: true,
    },
    {
      error: new RegistrationSettlementError(
        "SETTLEMENT_STATE_CONFLICT",
        "secret settlement details",
      ),
      message: "数据状态异常，操作未生效，请联系管理员。",
      shouldLog: true,
    },
    {
      error: new Prisma.PrismaClientKnownRequestError("secret database details", {
        code: "P2034",
        clientVersion: "test",
      }),
      message: "数据已被其他操作更新，请刷新页面后重试。",
      shouldLog: false,
    },
  ];

  for (const expected of cases) {
    const actual = mapV2ActionError(expected.error);
    assert.deepEqual(actual, {
      message: expected.message,
      shouldLog: expected.shouldLog,
    });
    assert.equal(actual.message.includes("secret"), false);
  }

  assert.deepEqual(mapV2ActionError(new Error("secret unexpected details")), {
    message: "操作失败，请稍后重试。",
    shouldLog: true,
  });
});
