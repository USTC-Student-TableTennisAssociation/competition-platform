import Link from "next/link";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import MatchDetailHeader from "@/components/match/detail/MatchDetailHeader";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import type { CertificateEligibility } from "@/lib/certificate";
import V2CompetitionPhases from "./V2CompetitionPhases";
import { V2SingleRegistrationForm } from "./V2SingleActionForms";
import type {
  V2SingleMatchModel,
  V2SingleViewer,
} from "@/modules/competitions-v2/read-model/single-match-view";
import { buildV2SingleMatchViewModel } from "@/modules/competitions-v2/read-model/single-match-view";

export default function V2SingleMatchDetail({
  model,
  currentUser,
  certificate,
  now = new Date(),
}: {
  model: V2SingleMatchModel;
  currentUser: V2SingleViewer;
  certificate: Readonly<{
    currentUserEmail: string;
    identityBound: boolean;
    eligibility: CertificateEligibility;
    existingCertificateNo: string | null;
  }> | null;
  now?: Date;
}) {
  const view = buildV2SingleMatchViewModel(model, currentUser, now);
  const match = model.match;
  const isRegistered = Boolean(
    currentUser &&
      view.activeEntries.some((entry) => entry.userId === currentUser.userId),
  );

  const registration = (
    <section className="rounded-xl border border-white/10 bg-[#101620] p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">
        {isRegistered ? "你已报名" : "单打报名"}
      </h2>
      <div className="mt-4">
        {isRegistered ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-300">
              报名成功。等待主办方发布分组，签位公布后可在这里查看自己的对手并录入比分。
            </p>
            <Link
              href={`/matchs/${match.id}#schedule`}
              className="btn-primary flex min-h-12 items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold"
            >
              查看签位发布状态
            </Link>
            {view.registration.action === "CANCEL" ? (
              <details className="text-xs text-slate-400">
                <summary className="w-fit cursor-pointer py-2">
                  退出报名
                </summary>
                <div className="mt-2">
                  <V2SingleRegistrationForm matchId={match.id} mode="cancel" />
                </div>
              </details>
            ) : null}
          </div>
        ) : view.registration.action === "REGISTER" ? (
          <V2SingleRegistrationForm matchId={match.id} mode="register" />
        ) : view.registration.action === "CANCEL" ? (
          <V2SingleRegistrationForm matchId={match.id} mode="cancel" />
        ) : (
          <p className="text-sm text-slate-300">{view.registration.message}</p>
        )}
      </div>
      {!currentUser ? (
        <Link
          href="/auth"
          className="mt-4 inline-block text-sm text-orange-200 hover:text-orange-100"
        >
          登录后报名 →
        </Link>
      ) : null}
      <p className="mt-4 text-xs text-slate-400">
        报名和已确认成绩会自动更新积分。
      </p>
    </section>
  );
  const roster = (
    <section>
      <h2 className="text-lg font-semibold text-white">参赛选手</h2>
      <p className="mt-1 text-sm text-slate-400">点击选手查看个人资料。</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {view.activeEntries.length === 0 ? (
          <p className="text-sm text-slate-400">暂无有效报名。</p>
        ) : (
          view.activeEntries.map((entry, index) => (
            <div
              key={entry.entryId}
              className="flex min-w-0 items-start gap-3 rounded-xl border border-white/10 bg-[#101620] p-4"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-xs tabular-nums text-slate-400">
                {index + 1}
              </span>
              <div className="min-w-0">
                {entry.userId ? (
                  <Link
                    href={`/profile/${entry.userId}`}
                    className="break-words text-sm font-medium text-slate-100 hover:text-orange-200"
                  >
                    {entry.frozenDisplayName}
                  </Link>
                ) : (
                  <p className="break-words text-sm font-medium text-slate-100">
                    {entry.frozenDisplayName}
                  </p>
                )}
                {entry.currentProfile ? (
                  <>
                    <p className="mt-1 text-xs text-slate-400">
                      积分 {entry.currentProfile.currentPoints} · ELO{" "}
                      {entry.currentProfile.currentEloRating}
                    </p>
                    {entry.currentProfile.nickname !==
                    entry.frozenDisplayName ? (
                      <p className="mt-1 break-words text-xs text-slate-500">
                        现用名：{entry.currentProfile.nickname}
                      </p>
                    ) : null}
                    {entry.currentProfile.isCurrentlyBanned ? (
                      <p className="mt-1 text-xs text-rose-300">
                        当前账号已封禁
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-1 text-xs text-slate-400">
                    当前账号状态未知
                  </p>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
  const editLink = view.canEditSettings ? (
    <Link
      href={`/matchs/${match.id}/edit`}
      className="btn-secondary rounded-lg px-4 py-2.5 text-sm font-medium"
    >
      修改比赛信息
    </Link>
  ) : null;
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-6">
      <BackLinkButton fallbackHref="/matchs" />
      <MatchDetailHeader
        match={match}
        typeLabel="单打"
        participantLabel={`${view.registration.activeEntryCount} 人报名`}
      />
      {view.supported ? (
        <V2CompetitionPhases
          grouping={model.grouping}
          competitionType="single"
          currentUserId={currentUser?.userId ?? null}
          isManager={view.isManager}
          registrationContent={
            !model.grouping.published ? registration : undefined
          }
          rosterContent={roster}
          managementContent={editLink}
          certificateContent={
            certificate ? (
              <ExportCertificateSection
                matchId={match.id}
                matchTitle={match.title}
                currentUserEmail={certificate.currentUserEmail}
                identityBound={certificate.identityBound}
                eligibility={certificate.eligibility}
                existingCertificateNo={certificate.existingCertificateNo}
              />
            ) : undefined
          }
        />
      ) : (
        <p className="rounded-xl bg-amber-400/5 p-5 text-sm text-amber-200">
          暂时无法加载比赛操作，请联系管理员。
        </p>
      )}
    </div>
  );
}
