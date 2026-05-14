import AdminResultEntryForm from "@/components/match/AdminResultEntryForm";
import {
  confirmMatchResultVoidAction,
  rejectMatchResultVoidAction,
} from "@/app/matchs/actions";
import type { AdminGroupBattleTable } from "@/lib/match-detail";

type PendingResultItem = {
  id: string;
  reporterName: string;
  winnerLabel: string;
  loserLabel: string;
  scoreText: string;
  phaseLabel: string;
  groupName: string;
  knockoutRound: string;
};

type AdminEligibleOptions = {
  groupMatchOptions: Array<{
    groupName: string;
    playerAId: string;
    playerANickname: string;
    playerBId: string;
    playerBNickname: string;
  }>;
  knockoutMatchOptions: Array<{
    matchId: string;
    roundName: string;
    playerAId: string;
    playerANickname: string;
    playerBId: string;
    playerBNickname: string;
  }>;
};

export default function AdminResultsSection({
  matchId,
  matchType,
  hasGroupingPayload,
  registrations,
  adminEligibleOptions,
  adminGroupBattleTables,
  initialAdminPhase,
  initialAdminGroupName,
  initialAdminRoundName,
  initialAdminWinnerId,
  initialAdminLoserId,
  adminPendingResults,
  filledKnockoutRounds,
}: {
  matchId: string;
  matchType: string;
  hasGroupingPayload: boolean;
  registrations: Array<{ user: { id: string; nickname: string } }>;
  adminEligibleOptions: AdminEligibleOptions | null;
  adminGroupBattleTables: AdminGroupBattleTable[];
  initialAdminPhase?: "group" | "knockout";
  initialAdminGroupName?: string;
  initialAdminRoundName?: string;
  initialAdminWinnerId?: string;
  initialAdminLoserId?: string;
  adminPendingResults: PendingResultItem[];
  filledKnockoutRounds: Array<{
    name: string;
    matches: Array<{
      id: string;
      homeLabel: string;
      awayLabel: string;
      homeFilled?: boolean;
      awayFilled?: boolean;
      homePlayerId?: string | null;
      awayPlayerId?: string | null;
      homeSourceLabel?: string;
      awaySourceLabel?: string;
      homeOutcome?: string;
      awayOutcome?: string;
      homeScoreText?: string;
      awayScoreText?: string;
    }>;
  }> | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6 md:p-8">
      {matchType === "single" ? (
        hasGroupingPayload ? (
          <div className="mb-4 sm:mb-6">
            <AdminResultEntryForm
              matchId={matchId}
              players={registrations.map((item) => ({
                id: item.user.id,
                nickname: item.user.nickname,
              }))}
              groupMatchOptions={adminEligibleOptions?.groupMatchOptions ?? []}
              knockoutMatchOptions={
                adminEligibleOptions?.knockoutMatchOptions ?? []
              }
              groupBattleTables={adminGroupBattleTables}
              initialPhase={
                initialAdminPhase === "group" ||
                initialAdminPhase === "knockout"
                  ? initialAdminPhase
                  : "group"
              }
              initialGroupName={initialAdminGroupName}
              initialRoundName={initialAdminRoundName}
              initialWinnerId={initialAdminWinnerId}
              initialLoserId={initialAdminLoserId}
              knockoutRounds={filledKnockoutRounds ?? undefined}
            />
          </div>
        ) : (
          <p className="mb-6 text-sm text-slate-400">
            请先生成并发布分组后，再录入小组/淘汰赛待确认赛果。
          </p>
        )
      ) : (
        <p className="mb-6 text-sm text-slate-400">
          管理员流程化录入目前仅支持单打。
        </p>
      )}

      <h2 className="mb-2 text-xl font-bold text-white">管理员待确认赛果</h2>
      <p className="mb-3 text-xs text-slate-400 sm:mb-4 sm:text-sm">
        可在此查看并确认本比赛全部待确认赛果。
      </p>
      <div className="space-y-3">
        {adminPendingResults.length === 0 ? (
          <p className="text-sm text-slate-400">当前没有待确认赛果。</p>
        ) : (
          adminPendingResults.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-slate-700 bg-slate-800/50 p-3"
            >
              <p className="text-sm text-slate-200">
                {item.winnerLabel} 胜 {item.loserLabel}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                登记人：{item.reporterName}
                {item.phaseLabel === "group" && item.groupName
                  ? ` · 小组 ${item.groupName}`
                  : ""}
                {item.phaseLabel === "knockout" && item.knockoutRound
                  ? ` · 淘汰赛 ${item.knockoutRound}`
                  : ""}
                {item.scoreText ? ` · 比分 ${item.scoreText}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <form
                  action={confirmMatchResultVoidAction.bind(
                    null,
                    matchId,
                    item.id,
                  )}
                >
                  <input type="hidden" name="csrfToken" defaultValue="" />
                  <button
                    type="submit"
                    className="rounded-md border border-emerald-500/40 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10"
                  >
                    管理员确认该结果
                  </button>
                </form>
                <form
                  action={rejectMatchResultVoidAction.bind(
                    null,
                    matchId,
                    item.id,
                  )}
                >
                  <input type="hidden" name="csrfToken" defaultValue="" />
                  <button
                    type="submit"
                    className="rounded-md border border-rose-500/40 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                  >
                    否决
                  </button>
                </form>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
