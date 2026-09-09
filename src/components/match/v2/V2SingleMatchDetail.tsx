import { Calendar, MapPin, Pencil, Users } from "lucide-react";
import Link from "next/link";

import BackLinkButton from "@/components/navigation/BackLinkButton";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import type { CertificateEligibility } from "@/lib/certificate";
import V2CompetitionPhases from "@/components/match/v2/V2CompetitionPhases";
import { V2SingleRegistrationForm } from "@/components/match/v2/V2SingleActionForms";
import type { V2SingleMatchModel, V2SingleParticipantView, V2SingleViewer } from "@/modules/competitions-v2/read-model/single-match-view";
import { buildV2SingleMatchViewModel } from "@/modules/competitions-v2/read-model/single-match-view";
import { formatV2CompetitionDateTime } from "@/modules/competitions-v2/competition-time";

const STATUS_LABEL = {
  registration: "报名中",
  ongoing: "进行中",
  finished: "已结束",
} as const;

const ENTRY_STATUS_LABEL = {
  DRAFT: "未报名",
  ACTIVE: "参赛中",
  WITHDRAWN: "已退赛",
  DISQUALIFIED: "已取消资格",
  ARCHIVED: "已归档",
} as const;

function ParticipantIdentity({
  participant,
  compact = false,
}: {
  participant: V2SingleParticipantView;
  compact?: boolean;
}) {
  const identity = (
    <div>
      <p className="font-medium text-slate-100">
        {participant.frozenDisplayName}
      </p>
      <p className="text-xs text-slate-400">参赛选手</p>
    </div>
  );

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {participant.userId ? (
        <Link href={`/profile/${participant.userId}`} className="hover:text-cyan-300">
          {identity}
        </Link>
      ) : (
        identity
      )}
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-slate-300">
          {ENTRY_STATUS_LABEL[participant.entryStatus]}
        </span>
        {participant.currentProfile ? (
          <span
            className={`rounded-full border px-2 py-0.5 ${
              participant.currentProfile.isCurrentlyBanned
                ? "border-rose-500/40 text-rose-300"
                : "border-emerald-500/35 text-emerald-300"
            }`}
          >
            当前账号：
            {participant.currentProfile.isCurrentlyBanned ? "已封禁" : "正常"}
          </span>
        ) : (
          <span className="rounded-full border border-amber-500/35 px-2 py-0.5 text-amber-300">
            当前账号状态未知
          </span>
        )}
      </div>
      {participant.currentProfile && !compact ? (
        <p className="text-xs text-slate-400">
          当前资料名：{participant.currentProfile.nickname} · 积分 {participant.currentProfile.currentPoints} · ELO {participant.currentProfile.currentEloRating}
        </p>
      ) : null}
    </div>
  );
}

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

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />

      <section className="surface-panel relative overflow-hidden rounded-3xl p-4 sm:p-6 md:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_88%_6%,rgba(45,212,191,0.1),transparent_36%)]" />
        <div className="relative">
          <span className="status-pill ring-1 ring-cyan-400/30">
            {STATUS_LABEL[match.status]}
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-white sm:text-4xl">
            {match.title}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400 sm:text-base">
            {match.description || "暂无描述"}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              单打
              {match.format === "group_then_knockout" ? "小组 + 淘汰赛" : "纯小组赛"}
            </span>
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              报名截止：{formatV2CompetitionDateTime(match.registrationDeadline)}（北京时间）
            </span>
          </div>
          {view.canEditSettings ? (
            <Link
              href={`/matchs/${match.id}/edit`}
              className="btn-secondary mt-4 inline-flex items-center gap-1.5 rounded-2xl px-3 py-1.5 text-xs font-bold"
            >
              <Pencil className="h-3.5 w-3.5" />
              修改比赛基本信息
            </Link>
          ) : null}
        </div>

        <div className="relative mt-5 grid gap-3 text-slate-200 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <Calendar className="h-5 w-5 text-teal-200" />
            <div><p className="text-xs text-slate-400">时间</p><p>{formatV2CompetitionDateTime(match.dateTime)}（北京时间）</p></div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <MapPin className="h-5 w-5 text-teal-200" />
            <div><p className="text-xs text-slate-400">地点</p><p>{match.location ?? "待定"}</p></div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <Users className="h-5 w-5 text-teal-200" />
            <div><p className="text-xs text-slate-400">参赛人数</p><p>{view.registration.activeEntryCount} 人</p></div>
          </div>
        </div>

        <div className="relative mt-5 space-y-2">
          {view.registration.action === "REGISTER" ? (
            <V2SingleRegistrationForm matchId={match.id} mode="register" />
          ) : view.registration.action === "CANCEL" ? (
            <V2SingleRegistrationForm matchId={match.id} mode="cancel" />
          ) : (
            <p className="text-sm text-slate-300">{view.registration.message}</p>
          )}
          <p className="text-xs text-slate-400">
            报名和已确认成绩会自动更新积分。
          </p>
        </div>
      </section>

      {!view.supported ? (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200 sm:p-6">
          暂时无法加载本场比赛操作，请联系管理员。
        </section>
      ) : null}


      {view.isManager && view.supported && match.status !== "finished" ? (
        <section className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-amber-100 sm:text-lg">
                分组管理
              </h2>
              <p className="mt-1 text-xs text-amber-100/80 sm:text-sm">
                预览分组和赛程，确认后发布。
              </p>
            </div>
            <Link
              href={`/matchs/${match.id}/grouping`}
              className="rounded-lg border border-amber-300/40 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/10 sm:text-sm"
            >
              进入分组管理
            </Link>
          </div>
        </section>
      ) : null}

      {view.supported ? (
        <V2CompetitionPhases
          grouping={model.grouping}
          competitionType="single"
          currentUserId={currentUser?.userId ?? null}
          isManager={view.isManager}
        />
      ) : null}

      <details className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6">
        <summary className="cursor-pointer text-lg font-bold text-white">已报名选手（{view.activeEntries.length}）</summary>
        <p className="mt-1 text-xs text-slate-400">
          可点击选手查看个人资料。
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {view.activeEntries.length === 0 ? (
            <p className="text-sm text-slate-400">当前没有有效报名。</p>
          ) : (
            view.activeEntries.map((entry, index) => (
              <div key={entry.entryId} className="flex gap-3 rounded-lg border border-slate-700 p-3">
                <span className="w-6 font-mono text-slate-400">{index + 1}</span>
                <ParticipantIdentity participant={entry} />
              </div>
            ))
          )}
        </div>
      </details>

      {certificate ? (
        <ExportCertificateSection
          matchId={match.id}
          matchTitle={match.title}
          currentUserEmail={certificate.currentUserEmail}
          identityBound={certificate.identityBound}
          eligibility={certificate.eligibility}
          existingCertificateNo={certificate.existingCertificateNo}
        />
      ) : null}
    </div>
  );
}
