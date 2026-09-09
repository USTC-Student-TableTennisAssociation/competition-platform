import assert from "node:assert/strict";
import test from "node:test";

import {
  CompetitionDomainError,
  assertEngineCanWrite,
  assertEngineVersionTransition,
  assertEntryCanActivate,
  assertEntryKindTransition,
  assertEntryMemberSnapshotMutationAllowed,
  assertFixtureReadyParticipants,
  assertFixtureStageMetadata,
  assertFixtureStageTransition,
  assertResultRevisionStatusTransition,
  assertSuccessorRosterCanBeCreated,
  canTransitionEntryStatus,
  canTransitionEntryMemberStatus,
  canTransitionFixtureStatus,
  createEntrySourceKey,
  decideSettlementEvent,
  parseEntrySourceKey,
} from "./index";
import type { CompetitionDomainErrorCode } from "./errors";

function expectDomainError(
  action: () => void,
  expectedCode: CompetitionDomainErrorCode,
) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof CompetitionDomainError && error.code === expectedCode,
  );
}

test("engine migration is one-way and requires explicit evidence", () => {
  expectDomainError(
    () => assertEngineVersionTransition("LEGACY", "V2"),
    "ENGINE_MIGRATION_NOT_VERIFIED",
  );
  expectDomainError(
    () =>
      assertEngineVersionTransition("LEGACY", "V2", {
        migrationVerified: true,
        legacyWritesDisabled: false,
      }),
    "LEGACY_WRITES_NOT_DISABLED",
  );

  assert.doesNotThrow(() =>
    assertEngineVersionTransition("LEGACY", "V2", {
      migrationVerified: true,
      legacyWritesDisabled: true,
    }),
  );
  expectDomainError(
    () => assertEngineVersionTransition("V2", "LEGACY"),
    "INVALID_ENGINE_VERSION_TRANSITION",
  );
  expectDomainError(
    () => assertEngineCanWrite("LEGACY", "V2"),
    "ENGINE_WRITE_MISMATCH",
  );
});

test("entry identity is immutable and status transitions do not reopen entries", () => {
  expectDomainError(
    () => assertEntryKindTransition("DOUBLES", "TEAM"),
    "INVALID_ENTRY_KIND_TRANSITION",
  );
  assert.equal(canTransitionEntryStatus("DRAFT", "ACTIVE"), true);
  assert.equal(canTransitionEntryStatus("ACTIVE", "WITHDRAWN"), true);
  assert.equal(canTransitionEntryStatus("WITHDRAWN", "ACTIVE"), false);
  assert.equal(canTransitionEntryStatus("ARCHIVED", "DRAFT"), false);
  assert.equal(canTransitionEntryMemberStatus("ACTIVE", "REMOVED"), true);
  assert.equal(canTransitionEntryMemberStatus("ACTIVE", "SUPERSEDED"), true);
  assert.equal(canTransitionEntryMemberStatus("REMOVED", "ACTIVE"), false);
  assert.equal(canTransitionEntryMemberStatus("SUPERSEDED", "ACTIVE"), false);
});

test("entry source keys preserve a typed immutable source identity", () => {
  assert.equal(createEntrySourceKey("INDIVIDUAL", "user-1"), "individual:user-1");
  assert.equal(createEntrySourceKey("DOUBLES", "pair-1"), "doubles:pair-1");
  assert.equal(createEntrySourceKey("TEAM", "team-1"), "team:team-1");
  assert.deepEqual(parseEntrySourceKey("doubles:pair-1"), {
    kind: "DOUBLES",
    sourceId: "pair-1",
  });

  expectDomainError(
    () => createEntrySourceKey("TEAM", " "),
    "INVALID_ENTRY_SOURCE_KEY",
  );
  expectDomainError(
    () => parseEntrySourceKey("user:user-1"),
    "INVALID_ENTRY_SOURCE_KEY",
  );
  expectDomainError(
    () => parseEntrySourceKey("individual: "),
    "INVALID_ENTRY_SOURCE_KEY",
  );
});

test("entry activation validates participant identity and roster size", () => {
  assert.doesNotThrow(() =>
    assertEntryCanActivate({ kind: "INDIVIDUAL", memberIds: ["user-1"] }),
  );
  assert.doesNotThrow(() =>
    assertEntryCanActivate({
      kind: "DOUBLES",
      memberIds: ["user-1", "user-2"],
    }),
  );
  assert.doesNotThrow(() =>
    assertEntryCanActivate({
      kind: "TEAM",
      memberIds: ["user-1", "user-2", "user-3"],
      minimumTeamMembers: 3,
      maximumTeamMembers: 5,
    }),
  );

  expectDomainError(
    () =>
      assertEntryCanActivate({
        kind: "DOUBLES",
        memberIds: ["user-1", "user-1"],
      }),
    "INVALID_ENTRY_MEMBERS",
  );
  expectDomainError(
    () =>
      assertEntryCanActivate({
        kind: "TEAM",
        memberIds: ["user-1", "user-2"],
        minimumTeamMembers: 3,
      }),
    "INVALID_ENTRY_MEMBERS",
  );
});

test("entry membership freezes as soon as a fixture exists", () => {
  assert.doesNotThrow(() =>
    assertEntryMemberSnapshotMutationAllowed({
      status: "ACTIVE",
      hasFixture: false,
    }),
  );
  expectDomainError(
    () =>
      assertEntryMemberSnapshotMutationAllowed({
        status: "ACTIVE",
        hasFixture: true,
      }),
    "ENTRY_MEMBERSHIP_FROZEN",
  );
  expectDomainError(
    () =>
      assertEntryMemberSnapshotMutationAllowed({
        status: "WITHDRAWN",
        hasFixture: false,
      }),
    "ENTRY_MEMBERSHIP_NOT_EDITABLE",
  );

  assert.doesNotThrow(() =>
    assertSuccessorRosterCanBeCreated({
      kind: "TEAM",
      status: "ACTIVE",
      hasFixture: true,
    }),
  );
  assert.doesNotThrow(() => assertSuccessorRosterCanBeCreated({ kind: "DOUBLES", status: "ACTIVE", hasFixture: true }));
  expectDomainError(() => assertSuccessorRosterCanBeCreated({ kind: "INDIVIDUAL", status: "ACTIVE", hasFixture: true }), "ENTRY_ROSTER_VERSION_NOT_ALLOWED");
});

test("fixture lifecycle is independent from result revision lifecycle", () => {
  assert.equal(
    canTransitionFixtureStatus("SCHEDULED", "READY"),
    true,
  );
  assert.equal(canTransitionFixtureStatus("READY", "COMPLETED"), true);
  assert.equal(canTransitionFixtureStatus("READY", "SCHEDULED"), false);
  assert.equal(canTransitionFixtureStatus("COMPLETED", "READY"), false);
  assert.equal(canTransitionFixtureStatus("VOIDED", "SCHEDULED"), false);

  assert.doesNotThrow(() => assertFixtureStageTransition("GROUP", "GROUP"));
  expectDomainError(
    () => assertFixtureStageTransition("GROUP", "KNOCKOUT"),
    "INVALID_FIXTURE_STAGE_TRANSITION",
  );

  assert.doesNotThrow(() =>
    assertFixtureStageMetadata({
      stage: "KNOCKOUT",
      roundNumber: 1,
      position: 2,
    }),
  );
  expectDomainError(
    () =>
      assertFixtureStageMetadata({
        stage: "KNOCKOUT",
        roundNumber: 0,
        position: 2,
      }),
    "INVALID_FIXTURE_METADATA",
  );
  expectDomainError(
    () =>
      assertFixtureReadyParticipants({
        stage: "GROUP",
        homeEntryId: "entry-1",
        awayEntryId: "entry-1",
      }),
    "INVALID_FIXTURE_PARTICIPANTS",
  );
});

test("result revisions move forward and terminal revisions cannot reopen", () => {
  assert.doesNotThrow(() =>
    assertResultRevisionStatusTransition("PENDING", "CONFIRMED"),
  );
  assert.doesNotThrow(() =>
    assertResultRevisionStatusTransition("PENDING", "REJECTED"),
  );
  assert.doesNotThrow(() =>
    assertResultRevisionStatusTransition("CONFIRMED", "SUPERSEDED"),
  );
  assert.doesNotThrow(() =>
    assertResultRevisionStatusTransition("CONFIRMED", "VOIDED"),
  );
  expectDomainError(
    () => assertResultRevisionStatusTransition("REJECTED", "CONFIRMED"),
    "INVALID_RESULT_REVISION_STATUS_TRANSITION",
  );
  expectDomainError(
    () => assertResultRevisionStatusTransition("SUPERSEDED", "PENDING"),
    "INVALID_RESULT_REVISION_STATUS_TRANSITION",
  );
});

test("settlement application and reversal are idempotent and ordered", () => {
  const apply = decideSettlementEvent({
    resultRevisionId: "revision-1",
    eventKind: "RESULT_APPLY",
    revisionStatus: "CONFIRMED",
    recordedEventKinds: [],
  });
  assert.equal(apply.action, "RECORD");

  const repeatedApply = decideSettlementEvent({
    resultRevisionId: "revision-1",
    eventKind: "RESULT_APPLY",
    revisionStatus: "CONFIRMED",
    recordedEventKinds: ["RESULT_APPLY"],
  });
  assert.equal(repeatedApply.action, "NOOP");
  assert.equal(repeatedApply.idempotencyKey, apply.idempotencyKey);

  const reversal = decideSettlementEvent({
    resultRevisionId: "revision-1",
    eventKind: "RESULT_REVERSAL",
    revisionStatus: "SUPERSEDED",
    recordedEventKinds: ["RESULT_APPLY"],
  });
  assert.equal(reversal.action, "RECORD");

  const repeatedReversal = decideSettlementEvent({
    resultRevisionId: "revision-1",
    eventKind: "RESULT_REVERSAL",
    revisionStatus: "SUPERSEDED",
    recordedEventKinds: ["RESULT_APPLY", "RESULT_REVERSAL"],
  });
  assert.equal(repeatedReversal.action, "NOOP");
  assert.equal(repeatedReversal.idempotencyKey, reversal.idempotencyKey);

  expectDomainError(
    () =>
      decideSettlementEvent({
        resultRevisionId: "revision-2",
        eventKind: "RESULT_REVERSAL",
        revisionStatus: "VOIDED",
        recordedEventKinds: [],
      }),
    "INVALID_SETTLEMENT_STATE",
  );
  expectDomainError(
    () =>
      decideSettlementEvent({
        resultRevisionId: "revision-2",
        eventKind: "RESULT_REVERSAL",
        revisionStatus: "VOIDED",
        recordedEventKinds: ["RESULT_REVERSAL"],
      }),
    "INVALID_SETTLEMENT_STATE",
  );
});
