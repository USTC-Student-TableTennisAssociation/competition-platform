export const TEAM_REGISTRATION_CSV_HEADERS = [
  "比赛名",
  "队名",
  "状态",
  "队长",
  "联系方式",
  "队员列表",
  "人数",
  "备注",
  "审核备注",
] as const;

export type V2TeamRegistrationCsvSource = Readonly<{
  match: Readonly<{ title: string }>;
  teams: readonly Readonly<{
    name: string;
    captainNickname: string;
    contact: string | null;
    remark: string | null;
    reviewNote: string | null;
    status: "draft" | "approved" | "cancelled";
    members: readonly Readonly<{
      nickname: string;
      isCurrentlyEligible: boolean;
    }>[];
    entry: Readonly<{
      status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED";
    }> | null;
  }>[];
}>;

export function mapV2TeamRegistrationCsvRows(
  state: V2TeamRegistrationCsvSource,
): Array<Array<string | number>> {
  return state.teams
    .filter(
      (team) =>
        team.status !== "cancelled" &&
        team.entry?.status !== "WITHDRAWN" &&
        team.entry?.status !== "DISQUALIFIED" &&
        team.members.every((member) => member.isCurrentlyEligible),
    )
    .map((team) => [
      state.match.title,
      team.name,
      team.entry?.status === "ACTIVE" ? "已成队" : "组建中",
      team.captainNickname,
      team.contact ?? "",
      team.members.map((member) => member.nickname).join("；"),
      team.members.length,
      team.remark ?? "",
      team.reviewNote ?? "",
    ]);
}
