import type {
  SingleCompetitionReadModel,
  V2SingleFixtureReadModel,
  V2UserDisplay,
} from "./single-match";
import {
  buildV2GroupOnlyResultFixtureView,
  formatV2GroupOnlyResultScore,
  V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  type V2GroupOnlyResultRevisionView,
} from "./group-only-result-view";

export type V2SingleMatchModel = Extract<
  SingleCompetitionReadModel,
  { kind: "SINGLE_V2_MATCH" }
>;

export type V2SingleViewer = Readonly<{
  userId: string;
  role: "user" | "admin";
}> | null;

export type V2SingleRegistrationView = Readonly<{
  activeEntryCount: number;
  action: "LOGIN" | "REGISTER" | "CANCEL" | "CLOSED" | "UNAVAILABLE";
  message: string;
}>;

export type V2SingleParticipantView = Readonly<{
  entryId: string;
  entryVersion: number;
  entryStatus: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  userId: string | null;
  frozenDisplayName: string;
  currentProfile: V2UserDisplay | null;
}>;

export type V2SingleRevisionView = V2GroupOnlyResultRevisionView;

export type V2SingleFixtureView = Readonly<{
  fixtureId: string;
  fixtureVersion: number;
  status: V2SingleFixtureReadModel["status"];
  sideA: V2SingleParticipantView;
  sideB: V2SingleParticipantView;
  authoritativeResult: V2SingleRevisionView | null;
  pendingResult: V2SingleRevisionView | null;
  canSubmitResult: boolean;
  canVoidUnplayed: boolean;
  canConfirmPending: boolean;
  canRejectPending: boolean;
  canSubmitCorrection: boolean;
  canVoidConfirmed: boolean;
  canConfirmForfeit: boolean;
  canCorrectForfeit: boolean;
  forfeitWinnerEntries: readonly Readonly<{
    entryId: string;
    frozenDisplayName: string;
  }>[];
}>;

export type V2SingleGroupView = Readonly<{
  groupKey: string;
  label: string;
  tableLabels: readonly string[];
  participants: readonly V2SingleParticipantView[];
  fixtures: readonly V2SingleFixtureView[];
}>;

export type V2SingleMatchViewModel = Readonly<{
  supported: boolean;
  isManager: boolean;
  canEditSettings: boolean;
  registration: V2SingleRegistrationView;
  activeEntries: readonly V2SingleParticipantView[];
  groups: readonly V2SingleGroupView[];
}>;

function mapParticipant(input: Readonly<{
  entryId: string;
  entryVersion: number;
  entryStatus: V2SingleParticipantView["entryStatus"];
  userId: string | null;
  displayNameSnapshot: string;
  currentProfile: V2UserDisplay | null;
}>): V2SingleParticipantView {
  return {
    entryId: input.entryId,
    entryVersion: input.entryVersion,
    entryStatus: input.entryStatus,
    userId: input.userId,
    frozenDisplayName: input.displayNameSnapshot,
    currentProfile: input.currentProfile,
  };
}

function mapFixtureSide(
  side: NonNullable<V2SingleFixtureReadModel["sideA"]>,
): V2SingleParticipantView {
  return {
    entryId: side.entryId,
    entryVersion: side.entryVersion,
    entryStatus: side.entryStatus,
    userId: side.player.userId,
    frozenDisplayName: side.player.displayNameSnapshot,
    currentProfile: side.player.profile,
  };
}

/**
 * Active V2 revisions are expected to contain the canonical score written by
 * the result boundary. Invalid historical JSON is labelled, never guessed.
 */
export function formatV2SingleScore(score: unknown) {
  return formatV2GroupOnlyResultScore("PLAYED", score);
}

function registrationView(
  model: V2SingleMatchModel,
  viewer: V2SingleViewer,
  now: Date,
  supported: boolean,
): V2SingleRegistrationView {
  const activeEntries = model.entries.filter((entry) => entry.status === "ACTIVE");
  const base = {
    activeEntryCount: activeEntries.length,
  };
  if (!supported) {
    return {
      ...base,
      action: "UNAVAILABLE",
      message: "当前赛制尚未开放 V2 页面操作。",
    };
  }
  if (!viewer) {
    return { ...base, action: "LOGIN", message: "请先登录后报名。" };
  }
  const existing = model.entries.find(
    (entry) => entry.sourceUserId === viewer.userId,
  );
  const open =
    model.match.status === "registration" &&
    now >= new Date(model.match.createdAt) &&
    now < new Date(model.match.registrationDeadline);
  if (!open) {
    return { ...base, action: "CLOSED", message: "当前不在报名开放时间内。" };
  }
  if (existing?.status === "ACTIVE") {
    return { ...base, action: "CANCEL", message: "你已报名。" };
  }
  if (existing && existing.status !== "DRAFT") {
    return {
      ...base,
      action: "UNAVAILABLE",
      message: "当前报名状态不可重新报名。",
    };
  }
  return { ...base, action: "REGISTER", message: "当前可以报名。" };
}

function mapFixture(
  fixture: V2SingleFixtureReadModel,
  viewer: V2SingleViewer,
  isManager: boolean,
): V2SingleFixtureView | null {
  if (fixture.stage !== "GROUP" || !fixture.sideA || !fixture.sideB) return null;

  const sideA = mapFixtureSide(fixture.sideA);
  const sideB = mapFixtureSide(fixture.sideB);
  const result = buildV2GroupOnlyResultFixtureView(
    {
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
      status: fixture.status,
      sideA: {
        entryId: sideA.entryId,
        entryStatus: sideA.entryStatus,
        frozenDisplayName: sideA.frozenDisplayName,
        members: [{
          userId: fixture.sideA.player.userId,
          isCurrentlyBanned:
            fixture.sideA.player.profile.isCurrentlyBanned,
        }],
      },
      sideB: {
        entryId: sideB.entryId,
        entryStatus: sideB.entryStatus,
        frozenDisplayName: sideB.frozenDisplayName,
        members: [{
          userId: fixture.sideB.player.userId,
          isCurrentlyBanned:
            fixture.sideB.player.profile.isCurrentlyBanned,
        }],
      },
      activeResult: fixture.activeResult,
    },
    viewer,
    isManager,
    V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );

  return {
    fixtureId: fixture.fixtureId,
    fixtureVersion: fixture.fixtureVersion,
    status: fixture.status,
    sideA,
    sideB,
    ...result,
  };
}

function groupDisplayLabel(groupKey: string) {
  const matched = /^group:(\d{4})$/.exec(groupKey);
  const ordinal = matched ? Number(matched[1]) : 0;
  return ordinal >= 1 ? `第 ${ordinal} 组` : groupKey;
}

export function buildV2SingleMatchViewModel(
  model: V2SingleMatchModel,
  viewer: V2SingleViewer,
  now: Date,
): V2SingleMatchViewModel {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date.");
  }
  const isManager = Boolean(
    viewer &&
      (viewer.role === "admin" || viewer.userId === model.match.createdBy),
  );
  // The relational grouping projection validates either supported formal
  // format, including the complete knockout graph. FREE_PLAY remains outside
  // this formal detail surface and is rejected by that aggregate reader.
  const supported =
    model.stageFixtureIds.freePlay.length === 0 &&
    (model.match.format === "group_then_knockout" ||
      model.stageFixtureIds.knockout.length === 0);

  const activeEntries = model.entries
    .filter((entry) => entry.status === "ACTIVE")
    .map((entry) =>
      mapParticipant({
        entryId: entry.entryId,
        entryVersion: entry.entryVersion,
        entryStatus: entry.status,
        userId: entry.player?.userId ?? entry.sourceUserId,
        displayNameSnapshot: entry.displayNameSnapshot,
        currentProfile: entry.player?.profile ?? null,
      }),
    );
  const fixturesById = new Map(
    model.fixtures.map((fixture) => [fixture.fixtureId, fixture] as const),
  );
  const groups = supported
    ? model.groups.map((group) => ({
        groupKey: group.groupKey,
        label: groupDisplayLabel(group.groupKey),
        tableLabels: group.tableLabels,
        participants: group.participants.map(mapParticipant),
        fixtures: group.fixtureIds
          .map((fixtureId) => fixturesById.get(fixtureId))
          .filter(
            (fixture): fixture is V2SingleFixtureReadModel =>
              fixture !== undefined,
          )
          .map((fixture) => mapFixture(fixture, viewer, isManager))
          .filter((fixture): fixture is V2SingleFixtureView => fixture !== null),
      }))
    : [];

  return {
    supported,
    isManager,
    canEditSettings: Boolean(
      supported &&
        viewer?.userId === model.match.createdBy &&
        model.match.status === "registration" &&
        now >= new Date(model.match.createdAt) &&
        now < new Date(model.match.registrationDeadline) &&
        model.match.groupingGeneratedAt === null &&
        model.fixtures.length === 0,
    ),
    registration: registrationView(model, viewer, now, supported),
    activeEntries,
    groups,
  };
}
