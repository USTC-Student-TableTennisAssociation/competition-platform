import type { V2GroupOnlyGroupingFixture } from "./group-only-grouping";
import type {
  V2GroupOnlyResultFixtureView,
  V2GroupOnlyResultViewProfile,
} from "./group-only-result-view";

/** Presentation only: the result view and application service still authorize writes. */
export function memberFixtureGuidance(
  fixture: V2GroupOnlyGroupingFixture,
  view: V2GroupOnlyResultFixtureView,
  currentUserId: string | null,
  isManager: boolean,
  profile: V2GroupOnlyResultViewProfile,
) {
  const sides = [fixture.sideA, fixture.sideB];
  const ownSide = sides.find((side) =>
    side.members.some((m) => m.userId === currentUserId),
  );
  const member = ownSide?.members.find((m) => m.userId === currentUserId);
  const captain = ownSide?.members.find((m) => m.role === "captain");
  const team = profile.participantConfirmPolicy === "CAPTAIN_ONLY";
  const roleHint =
    team && ownSide && !isManager && member?.role !== "captain"
      ? `你是本队队员，可以查看成绩。本场由队长${captain ? ` ${captain.frozenDisplayName}` : ""}录入和确认比分。`
      : null;
  let pendingHint: string | null = null;
  if (view.pendingResult) {
    if (view.canConfirmPending)
      pendingHint = "请你核对双方和比分，确认后计入正式成绩。";
    else if (view.authoritativeResult)
      pendingHint = "等待管理员核对更正；原赛果仍然生效。";
    else {
      const eligible = sides.every(
        (side) =>
          side.entryStatus === "ACTIVE" &&
          side.members.every((m) => !m.isCurrentlyBanned),
      );
      const candidates = eligible
        ? sides
            .flatMap((side) => side.members)
            .filter(
              (m) =>
                m.userId !== view.pendingResult!.reporterId &&
                (!team || m.role === "captain"),
            )
        : [];
      pendingHint = candidates.length
        ? `等待${team ? "队长 " : " "}${candidates.map((m) => m.frozenDisplayName).join("、")} 确认，管理员也可处理。`
        : "等待管理员核对并处理本场比分。";
    }
  }
  return {
    pendingHint,
    roleHint,
    sideACaption: sides[0] === ownSide ? (team ? "本队" : "我方") : undefined,
    sideBCaption: sides[1] === ownSide ? (team ? "本队" : "我方") : undefined,
  };
}
