import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createV2SingleServerActionBindings } from "../adapters/single-server-actions";

const SERVER_ACTION_EXPORTS = [
  "registerV2SingleAction",
  "cancelV2SingleRegistrationAction",
  "previewV2SingleGroupingAction",
  "publishV2SingleGroupingAction",
  "updateV2SingleGroupTableLabelsAction",
  "voidV2SingleUnplayedFixtureAction",
  "submitV2SingleResultAction",
  "submitV2SingleResultCorrectionAction",
  "confirmV2SingleResultAction",
  "rejectV2SingleResultAction",
  "voidV2SingleResultAction",
  "confirmV2SingleForfeitAction",
  "correctV2SingleForfeitAction",
] as const;
const SETTINGS_ACTION_EXPORT = "updateV2SingleMatchSettingsAction" as const;
const FINALIZE_ACTION_EXPORT = "finalizeV2GroupStageAction" as const;
const DISQUALIFY_ACTION_EXPORT = "disqualifyV2EntryAction" as const;
const KNOCKOUT_LABEL_ACTION_EXPORT =
  "updateV2KnockoutTableLabelsAction" as const;
const DOUBLE_ACTION_EXPORTS = [
  "registerV2DoubleAction",
  "cancelV2DoubleRegistrationAction",
  "previewV2DoubleGroupingAction",
  "publishV2DoubleGroupingAction",
  "updateV2DoubleGroupTableLabelsAction",
  "voidV2DoubleUnplayedFixtureAction",
  "submitV2DoubleResultAction",
  "submitV2DoubleResultCorrectionAction",
  "confirmV2DoubleResultAction",
  "rejectV2DoubleResultAction",
  "voidV2DoubleResultAction",
  "confirmV2DoubleForfeitAction",
  "correctV2DoubleForfeitAction",
] as const;
const TEAM_ACTION_EXPORTS = [
  "previewV2TeamGroupingAction",
  "publishV2TeamGroupingAction",
  "updateV2TeamGroupTableLabelsAction",
  "voidV2TeamUnplayedFixtureAction",
  "submitV2TeamResultAction",
  "submitV2TeamResultCorrectionAction",
  "confirmV2TeamResultAction",
  "rejectV2TeamResultAction",
  "voidV2TeamResultAction",
  "confirmV2TeamForfeitAction",
  "correctV2TeamForfeitAction",
] as const;
const SINGLE_KNOCKOUT_ACTION_EXPORTS = [
  "submitV2SingleKnockoutResultAction",
  "submitV2SingleKnockoutResultCorrectionAction",
  "confirmV2SingleKnockoutResultAction",
  "rejectV2SingleKnockoutResultAction",
  "confirmV2SingleKnockoutForfeitAction",
  "correctV2SingleKnockoutForfeitAction",
] as const;
const DOUBLE_KNOCKOUT_ACTION_EXPORTS = [
  "submitV2DoubleKnockoutResultAction",
  "submitV2DoubleKnockoutResultCorrectionAction",
  "confirmV2DoubleKnockoutResultAction",
  "rejectV2DoubleKnockoutResultAction",
  "confirmV2DoubleKnockoutForfeitAction",
  "correctV2DoubleKnockoutForfeitAction",
] as const;
const TEAM_KNOCKOUT_ACTION_EXPORTS = [
  "submitV2TeamKnockoutResultAction",
  "submitV2TeamKnockoutResultCorrectionAction",
  "confirmV2TeamKnockoutResultAction",
  "rejectV2TeamKnockoutResultAction",
  "confirmV2TeamKnockoutForfeitAction",
  "correctV2TeamKnockoutForfeitAction",
] as const;

test("SINGLE V2 server-action bindings forward only matchId and FormData", async () => {
  const calls: Array<{
    operation: string;
    matchId: unknown;
    formData: FormData;
  }> = [];
  const handler = (operation: string) =>
    async (matchId: unknown, formData: FormData) => {
      calls.push({ operation, matchId, formData });
      return { success: operation };
    };
  const bindings = createV2SingleServerActionBindings({
    register: handler("register"),
    cancelRegistration: handler("cancelRegistration"),
    previewGrouping: handler("previewGrouping"),
    publishGrouping: handler("publishGrouping"),
    updateGroupTableLabels: handler("updateGroupTableLabels"),
    voidUnplayedFixture: handler("voidUnplayedFixture"),
    submitResult: handler("submitResult"),
    submitCorrection: handler("submitCorrection"),
    confirmResult: handler("confirmResult"),
    rejectResult: handler("rejectResult"),
    voidResult: handler("voidResult"),
    confirmForfeit: handler("confirmForfeit"),
    correctForfeit: handler("correctForfeit"),
  });
  const formData = new FormData();
  formData.set("csrfToken", "csrf-token");
  const previousState = Object.freeze({
    error: "untrusted previous state",
    previewJson: '{"actorId":"client-value"}',
  });
  const scenarios = [
    ["register", bindings.register],
    ["cancelRegistration", bindings.cancelRegistration],
    ["previewGrouping", bindings.previewGrouping],
    ["publishGrouping", bindings.publishGrouping],
    ["updateGroupTableLabels", bindings.updateGroupTableLabels],
    ["voidUnplayedFixture", bindings.voidUnplayedFixture],
    ["submitResult", bindings.submitResult],
    ["submitCorrection", bindings.submitCorrection],
    ["confirmResult", bindings.confirmResult],
    ["rejectResult", bindings.rejectResult],
    ["voidResult", bindings.voidResult],
    ["confirmForfeit", bindings.confirmForfeit],
    ["correctForfeit", bindings.correctForfeit],
  ] as const;

  assert.equal(Object.isFrozen(bindings), true);
  for (const [operation, action] of scenarios) {
    const state = await action("match-v2", previousState, formData);
    assert.deepEqual(state, { success: operation });
  }
  assert.deepEqual(
    calls.map(({ operation, matchId }) => ({ operation, matchId })),
    scenarios.map(([operation]) => ({ operation, matchId: "match-v2" })),
  );
  assert.equal(calls.every((call) => call.formData === formData), true);
  assert.equal(
    calls.some((call) => Object.values(call).includes(previousState)),
    false,
  );
});

test("SINGLE V2 server-action bindings never fall back to another handler", async () => {
  const sentinel = new Error("V2 handler failed");
  let fallbackCalls = 0;
  const fallback = async () => {
    fallbackCalls += 1;
    return { success: "unexpected fallback" };
  };
  const bindings = createV2SingleServerActionBindings({
    register: async () => {
      throw sentinel;
    },
    cancelRegistration: fallback,
    previewGrouping: fallback,
    publishGrouping: fallback,
    updateGroupTableLabels: fallback,
    voidUnplayedFixture: fallback,
    submitResult: fallback,
    submitCorrection: fallback,
    confirmResult: fallback,
    rejectResult: fallback,
    voidResult: fallback,
    confirmForfeit: fallback,
    correctForfeit: fallback,
  });

  await assert.rejects(
    bindings.register("match-v2", {}, new FormData()),
    (error: unknown) => error === sentinel,
  );
  assert.equal(fallbackCalls, 0);
});

test("the production boundary exposes async V2-only actions with trusted composition", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/matchs/v2-actions.ts"),
    "utf8",
  );
  const exportedFunctions = [...source.matchAll(/export async function (\w+)\s*\(/g)]
    .map((match) => match[1]);

  assert.match(source, /^['"]use server['"]/);
  assert.deepEqual(exportedFunctions, [
    FINALIZE_ACTION_EXPORT,
    DISQUALIFY_ACTION_EXPORT,
    KNOCKOUT_LABEL_ACTION_EXPORT,
    SETTINGS_ACTION_EXPORT,
    "registerV2SingleAction",
    "cancelV2SingleRegistrationAction",
    ...DOUBLE_ACTION_EXPORTS,
    ...TEAM_ACTION_EXPORTS,
    ...SERVER_ACTION_EXPORTS.slice(2),
    ...SINGLE_KNOCKOUT_ACTION_EXPORTS,
    ...DOUBLE_KNOCKOUT_ACTION_EXPORTS,
    ...TEAM_KNOCKOUT_ACTION_EXPORTS,
    "withdrawV2EntryAction",
    "replaceCompetitionRosterAction",
    "startCompetitionFixtureAction",
  ]);
  assert.doesNotMatch(source, /export\s+(?:const|let|var|class)\s+/);
  assert.doesNotMatch(source, /from\s+['"](?:\.\/actions|@\/app\/matchs\/actions)['"]/);
  assert.doesNotMatch(source, /\bLEGACY\b|createMatchAction|registerMatchAction/);
  assert.doesNotMatch(source, /console\.error\(message,\s*error\)/);

  const finalizeSignature = source.match(
    new RegExp(
      `export async function ${FINALIZE_ACTION_EXPORT}\\s*\\(([\\s\\S]*?)\\): Promise<V2GroupStageFinalizationActionState>`,
    ),
  );
  assert.ok(finalizeSignature, "missing typed atomic group-stage finalize action");
  assert.match(finalizeSignature[1], /matchId:\s*string/);
  assert.match(
    finalizeSignature[1],
    /_previousState:\s*V2GroupStageFinalizationActionState/,
  );
  assert.match(finalizeSignature[1], /formData:\s*FormData/);
  assert.doesNotMatch(
    finalizeSignature[1],
    /actor|role|service|handler|dependenc/i,
  );
  assert.match(source, /createV2GroupStageFinalizationActionHandler/);
  assert.doesNotMatch(
    source,
    /createV2QualificationSnapshotApplicationService|createV2KnockoutPublicationApplicationService/,
  );

  const disqualifySignature = source.match(
    new RegExp(
      `export async function ${DISQUALIFY_ACTION_EXPORT}\\s*\\(([\\s\\S]*?)\\): Promise<V2EntryDisqualificationActionState>`,
    ),
  );
  assert.ok(disqualifySignature, "missing typed Entry disqualification action");
  assert.match(disqualifySignature[1], /matchId:\s*string/);
  assert.match(
    disqualifySignature[1],
    /_previousState:\s*V2EntryDisqualificationActionState/,
  );
  assert.match(disqualifySignature[1], /formData:\s*FormData/);
  assert.doesNotMatch(
    disqualifySignature[1],
    /actor|role|service|handler|dependenc/i,
  );

  const knockoutLabelSignature = source.match(
    new RegExp(
      `export async function ${KNOCKOUT_LABEL_ACTION_EXPORT}\\s*\\(([\\s\\S]*?)\\): Promise<V2KnockoutTableLabelsActionState>`,
    ),
  );
  assert.ok(knockoutLabelSignature, "missing typed knockout label action");
  assert.match(knockoutLabelSignature[1], /matchId:\s*string/);
  assert.match(
    knockoutLabelSignature[1],
    /_previousState:\s*V2KnockoutTableLabelsActionState/,
  );
  assert.match(knockoutLabelSignature[1], /formData:\s*FormData/);
  assert.doesNotMatch(
    knockoutLabelSignature[1],
    /actor|role|service|handler|dependenc/i,
  );

  for (const exportName of SERVER_ACTION_EXPORTS) {
    const signature = source.match(
      new RegExp(
        `export async function ${exportName}\\s*\\(([\\s\\S]*?)\\): Promise<V2SingleActionState>`,
      ),
    );
    assert.ok(signature, `missing typed server-action signature for ${exportName}`);
    assert.match(signature[1], /matchId:\s*string/);
    assert.match(signature[1], /previousState:\s*V2SingleActionState/);
    assert.match(signature[1], /formData:\s*FormData/);
    assert.doesNotMatch(
      signature[1],
      /actor|role|service|handler|dependenc/i,
      `${exportName} must not accept trusted dependencies from its caller`,
    );
  }

  for (const exportName of DOUBLE_ACTION_EXPORTS) {
    const signature = source.match(
      new RegExp(
        `export async function ${exportName}\\s*\\(([\\s\\S]*?)\\): Promise<V2DoubleActionState>`,
      ),
    );
    assert.ok(signature, `missing typed server-action signature for ${exportName}`);
    assert.match(signature[1], /matchId:\s*string/);
    assert.match(signature[1], /_previousState:\s*V2DoubleActionState/);
    assert.match(signature[1], /formData:\s*FormData/);
    assert.doesNotMatch(signature[1], /actor|role|service|handler|dependenc/i);
  }

  for (const exportName of [
    ...SINGLE_KNOCKOUT_ACTION_EXPORTS,
    ...DOUBLE_KNOCKOUT_ACTION_EXPORTS,
    ...TEAM_KNOCKOUT_ACTION_EXPORTS,
  ]) {
    const signature = source.match(
      new RegExp(
        `export async function ${exportName}\\s*\\(([\\s\\S]*?)\\): Promise<V2KnockoutResultActionState>`,
      ),
    );
    assert.ok(signature, `missing typed server-action signature for ${exportName}`);
    assert.match(signature[1], /matchId:\s*string/);
    assert.match(signature[1], /_previousState:\s*V2KnockoutResultActionState/);
    assert.match(signature[1], /formData:\s*FormData/);
    assert.doesNotMatch(signature[1], /actor|role|service|handler|dependenc/i);
  }

  const settingsSignature = source.match(
    new RegExp(
      `export async function ${SETTINGS_ACTION_EXPORT}\\s*\\(([\\s\\S]*?)\\): Promise<V2SingleMatchSettingsState>`,
    ),
  );
  assert.ok(settingsSignature, "missing typed V2 settings action signature");
  assert.match(settingsSignature[1], /matchId:\s*string/);
  assert.match(
    settingsSignature[1],
    /_previousState:\s*V2SingleMatchSettingsState/,
  );
  assert.match(settingsSignature[1], /formData:\s*FormData/);
  assert.doesNotMatch(
    settingsSignature[1],
    /actor|role|service|handler|dependenc/i,
  );

  assert.match(source, /db:\s*prisma/);
  assert.match(source, /validateCsrfToken/);
  assert.match(source, /getCurrentUser/);
  assert.match(source, /revalidatePaths\(paths\)/);
  assert.match(source, /logError:\s*safeLogV2SingleActionError/);
  assert.match(source, /createV2MatchSettingsHandler/);
});

test("the correction form sends only a stable revision target and structured score", () => {
  const singleFormsSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2SingleActionForms.tsx",
    ),
    "utf8",
  );
  assert.match(
    singleFormsSource,
    /stage === "KNOCKOUT"[\s\S]*?submitV2SingleKnockoutResultCorrectionAction[\s\S]*?: submitV2SingleResultCorrectionAction/,
  );
  const formsSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2GroupOnlyResultActionForms.tsx",
    ),
    "utf8",
  );
  const start = formsSource.indexOf("export function V2GroupOnlyResultCorrectionForm");
  const end = formsSource.indexOf("export type V2GroupOnlyRevisionActionKind", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const correctionSource = formsSource.slice(start, end);

  assert.match(correctionSource, /serverAction\.bind\(null, matchId\)/);
  for (const field of [
    "fixtureId",
    "expectedFixtureVersion",
    "resultRevisionId",
    "correctionMode",
    "bestOf",
    "winnerScore",
    "loserScore",
  ]) {
    assert.match(correctionSource, new RegExp(`name=["']${field}["']`));
  }
  assert.doesNotMatch(correctionSource, /name=["'](?:winnerEntryId|loserEntryId)["']/);
  assert.doesNotMatch(correctionSource, /name=["']supersedesRevisionId["']/);
});

test("the forfeit correction form sends no client-selected participant", () => {
  const formsSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2GroupOnlyResultActionForms.tsx",
    ),
    "utf8",
  );
  const start = formsSource.indexOf(
    "export function V2GroupOnlyForfeitCorrectionForm",
  );
  assert.notEqual(start, -1);
  const correctionSource = formsSource.slice(start);
  for (const field of [
    "fixtureId",
    "expectedFixtureVersion",
    "resultRevisionId",
    "reason",
  ]) {
    assert.match(correctionSource, new RegExp(`name=["']${field}["']`));
  }
  assert.doesNotMatch(
    correctionSource,
    /name=["'](?:winnerEntryId|loserEntryId|supersedesRevisionId)["']/,
  );
});

test("the unplayed-fixture form sends only its optimistic target", () => {
  const singleFormsSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2SingleActionForms.tsx",
    ),
    "utf8",
  );
  assert.match(
    singleFormsSource,
    /serverAction=\{voidV2SingleUnplayedFixtureAction\}/,
  );
  const formsSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2GroupOnlyResultActionForms.tsx",
    ),
    "utf8",
  );
  const start = formsSource.indexOf("export function V2GroupOnlyUnplayedFixtureVoidForm");
  const end = formsSource.indexOf(
    "export function V2GroupOnlyResultCorrectionForm",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const formSource = formsSource.slice(start, end);

  assert.match(formSource, /serverAction\.bind\(null, matchId\)/);
  for (const field of ["csrfToken", "fixtureId", "expectedFixtureVersion"]) {
    assert.match(formSource, new RegExp(`name=["']${field}["']`));
  }
  assert.doesNotMatch(
    formSource,
    /name=["'](?:actor|actorId|role|stage|to|requiredFixtureStage|resultRevisionId|winnerEntryId|loserEntryId)["']/,
  );
});
