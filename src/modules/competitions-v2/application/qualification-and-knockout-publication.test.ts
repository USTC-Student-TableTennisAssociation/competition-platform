import assert from "node:assert/strict";
import test from "node:test";

import type { V2CompetitionTransaction } from "./entries";
import {
  createV2QualificationAndKnockoutPublicationApplicationService,
  type V2QualificationAndKnockoutPublicationApplicationServiceDependencies,
} from "./qualification-and-knockout-publication";

const MATCH_ID = "match-freeze-and-publish";
const SNAPSHOT_ID = "snapshot-from-freeze";
const FINGERPRINT = "c".repeat(64);
const TRANSACTION_TIME = new Date("2026-09-05T12:00:00.000Z");

type State = {
  snapshots: number;
  standings: number;
  freezeAudits: number;
  knockoutFixtures: number;
  dependencies: number;
  lineups: number;
  publishAudits: number;
};

function copyState(state: State): State {
  return { ...state };
}

function restoreState(state: State, snapshot: State) {
  Object.assign(state, snapshot);
}

function harness(options: Readonly<{ failPublication?: boolean }> = {}) {
  const state: State = {
    snapshots: 0,
    standings: 0,
    freezeAudits: 0,
    knockoutFixtures: 0,
    dependencies: 0,
    lineups: 0,
    publishAudits: 0,
  };
  const events: string[] = [];
  const transactionOptions: unknown[] = [];
  const tx = {
    $queryRaw: async () => {
      events.push("match-lock");
      return [{ id: MATCH_ID }];
    },
  } as unknown as V2CompetitionTransaction;
  const db = {
    $transaction: async (
      operation: (transaction: V2CompetitionTransaction) => Promise<unknown>,
      transactionOption: unknown,
    ) => {
      transactionOptions.push(transactionOption);
      const before = copyState(state);
      try {
        return await operation(tx);
      } catch (error) {
        restoreState(state, before);
        throw error;
      }
    },
  } as unknown as V2QualificationAndKnockoutPublicationApplicationServiceDependencies["db"];

  const service = createV2QualificationAndKnockoutPublicationApplicationService({
    db,
    clock: () => {
      assert.equal(events.at(-1), "match-lock");
      events.push("clock");
      return TRANSACTION_TIME;
    },
    internal: {
      freeze: async (kernelTx, command, clock) => {
        events.push("freeze");
        assert.equal(kernelTx, tx);
        assert.equal(command.matchId, MATCH_ID);
        assert.equal(clock(), TRANSACTION_TIME);
        const created = state.snapshots === 0;
        if (created) {
          state.snapshots = 1;
          state.standings = 4;
          state.freezeAudits = 1;
        }
        return {
          matchId: MATCH_ID,
          groupingId: "grouping-1",
          snapshotId: SNAPSHOT_ID,
          created,
          frozenAt: TRANSACTION_TIME,
          sourceRevisionFingerprint: FINGERPRINT,
          qualificationCount: 4,
          standings: [],
        };
      },
      publish: async (kernelTx, command, clock, hooks) => {
        events.push("publish");
        assert.equal(kernelTx, tx);
        assert.equal(command.matchId, MATCH_ID);
        assert.equal(command.expectedQualificationSnapshotId, SNAPSHOT_ID);
        assert.equal(command.expectedSourceRevisionFingerprint, FINGERPRINT);
        assert.equal(clock(), TRANSACTION_TIME);
        const created = state.knockoutFixtures === 0;
        if (created) {
          state.knockoutFixtures = 3;
          await hooks?.afterFixturesCreated?.();
          state.dependencies = 6;
          state.lineups = 4;
          state.publishAudits = 1;
        }
        return {
          matchId: MATCH_ID,
          qualificationSnapshotId: SNAPSHOT_ID,
          sourceRevisionFingerprint: FINGERPRINT,
          created,
          publishedAt: TRANSACTION_TIME,
          qualificationCount: 4,
          roundCount: 2,
          fixtureCount: 3,
        };
      },
      ...(options.failPublication
        ? {
            knockoutHooks: {
              afterFixturesCreated: () => {
                throw new Error("injected publication failure");
              },
            },
          }
        : {}),
    },
  });
  return {
    service,
    state,
    events,
    transactionOptions,
    command: {
      actor: { id: "owner-1", role: "user" as const },
      matchId: MATCH_ID,
    },
  };
}

test("freezes qualification and publishes its exact identity in one transaction", async () => {
  const state = harness();
  const first = await state.service.freezeAndPublish(state.command);
  assert.equal(first.qualification.created, true);
  assert.equal(first.knockout.created, true);
  assert.equal(first.knockout.qualificationSnapshotId, first.qualification.snapshotId);
  assert.equal(
    first.knockout.sourceRevisionFingerprint,
    first.qualification.sourceRevisionFingerprint,
  );
  assert.deepEqual(state.state, {
    snapshots: 1,
    standings: 4,
    freezeAudits: 1,
    knockoutFixtures: 3,
    dependencies: 6,
    lineups: 4,
    publishAudits: 1,
  });

  const replay = await state.service.freezeAndPublish(state.command);
  assert.equal(replay.qualification.created, false);
  assert.equal(replay.knockout.created, false);
  assert.deepEqual(state.state, {
    snapshots: 1,
    standings: 4,
    freezeAudits: 1,
    knockoutFixtures: 3,
    dependencies: 6,
    lineups: 4,
    publishAudits: 1,
  });
  assert.deepEqual(state.events, [
    "match-lock",
    "clock",
    "freeze",
    "publish",
    "match-lock",
    "clock",
    "freeze",
    "publish",
  ]);
  assert.deepEqual(state.transactionOptions, [
    { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
    { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
  ]);
});

test("rolls the freeze back when publication fails after its first write", async () => {
  const state = harness({ failPublication: true });
  await assert.rejects(
    state.service.freezeAndPublish(state.command),
    /injected publication failure/,
  );
  assert.deepEqual(state.state, {
    snapshots: 0,
    standings: 0,
    freezeAudits: 0,
    knockoutFixtures: 0,
    dependencies: 0,
    lineups: 0,
    publishAudits: 0,
  });
  assert.deepEqual(state.events, ["match-lock", "clock", "freeze", "publish"]);
});

test("rejects over-posting before opening the transaction", async () => {
  const state = harness();
  await assert.rejects(
    state.service.freezeAndPublish({
      ...state.command,
      expectedQualificationSnapshotId: SNAPSHOT_ID,
    } as never),
    /unsupported fields/,
  );
  await assert.rejects(
    state.service.freezeAndPublish({
      ...state.command,
      actor: { ...state.command.actor, isManager: true },
    } as never),
    /unsupported fields/,
  );
  assert.equal(state.transactionOptions.length, 0);
});
