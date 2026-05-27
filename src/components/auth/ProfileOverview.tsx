"use client";

import { useState } from "react";
import Link from "next/link";
import { PencilLine } from "lucide-react";
import EloTrendChart from "@/components/home/EloTrendChart";
import { normalizeAvatarUrl } from "@/lib/utils";

type EloPoint = {
  eloAfter: number;
  createdAt: string;
};

type BadgeItem = {
  id: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  awardedAt: string;
};

type Props = {
  user: {
    id: string;
    nickname: string;
    bio: string | null;
    avatarUrl: string | null;
    points: number;
    eloRating: number;
    wins: number;
    losses: number;
  };
  clubId: string;
  rank: number | null;
  termCount: number;
  eloPoints: EloPoint[];
  badges: BadgeItem[];
  showEdit?: boolean;
};

function ProfileAvatar({
  nickname,
  avatarUrl,
  onAvatarError,
}: {
  nickname: string;
  avatarUrl: string | null;
  onAvatarError: () => void;
}) {
  return (
    <div className="grid h-48 w-48 place-items-center overflow-hidden rounded-full border border-[#30363d] bg-orange-400/[0.08] text-6xl font-semibold text-orange-100 sm:h-64 sm:w-64 lg:h-72 lg:w-72">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={`${nickname}头像`}
          className="h-full w-full object-cover"
          onError={onAvatarError}
        />
      ) : (
        nickname[0]
      )}
    </div>
  );
}

export default function ProfileOverview({
  user,
  clubId,
  rank,
  termCount,
  eloPoints,
  badges,
  showEdit = true,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = !avatarFailed ? normalizeAvatarUrl(user.avatarUrl) : null;
  const totalMatches = user.wins + user.losses;
  const winRate =
    totalMatches > 0 ? Math.round((user.wins / totalMatches) * 100) : 0;
  const chartPoints = eloPoints.map((point) => ({
    elo: point.eloAfter,
    createdAt: point.createdAt,
  }));
  const stats = [
    { label: "ELO", value: user.eloRating, tone: "text-orange-100" },
    { label: "积分", value: user.points, tone: "text-slate-100" },
    { label: "排名", value: rank ? `#${rank}` : "-", tone: "text-slate-100" },
    { label: "战绩", value: `${user.wins}/${user.losses}`, tone: "text-slate-100" },
    { label: "胜率", value: `${winRate}%`, tone: "text-emerald-200" },
    { label: "本学期参赛", value: termCount, tone: "text-slate-100" },
  ];

  return (
    <section className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="min-w-0">
        <ProfileAvatar
          nickname={user.nickname}
          avatarUrl={avatarUrl}
          onAvatarError={() => setAvatarFailed(true)}
        />

        <h2 className="mt-6 truncate text-4xl font-semibold leading-none text-white">
          {user.nickname}
        </h2>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-md border border-sky-300/20 bg-sky-400/8 px-2.5 py-1 text-xs font-medium text-sky-200">
            Club ID: {clubId}
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(clubId);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                setCopied(false);
              }
            }}
            className="rounded-md border border-[#30363d] px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/[0.04] hover:text-slate-100"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>

        <p className="mt-4 text-sm leading-6 text-slate-400">
          {user.bio || "这个人很神秘，还没有留下个人描述。"}
        </p>

        {showEdit ? (
          <Link
            href="/profile/edit"
            className="btn-secondary mt-5 inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold"
          >
            <PencilLine className="h-4 w-4" />
            编辑资料
          </Link>
        ) : null}

        <div className="mt-8">
          <h3 className="text-base font-semibold text-white">徽章</h3>
          {badges.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              暂无徽章，继续参加比赛和活动来解锁。
            </p>
          ) : (
            <div className="mt-3 grid gap-2">
              {badges.slice(0, 6).map((badge) => (
                <div
                  key={badge.id}
                  className="rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2"
                >
                  <p className="text-sm font-medium text-orange-100">
                    {badge.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {badge.description || "荣誉徽章"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        <section>
          <h3 className="mb-3 text-base font-semibold text-white">竞技数据</h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {stats.map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-[#30363d] bg-[#0d1117] p-4"
              >
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className={`mt-2 text-2xl font-semibold tabular-nums ${item.tone}`}>
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-white">最近 ELO 走势</h3>
            <span className="text-xs text-slate-500">
              当前 ELO {user.eloRating}
            </span>
          </div>
          <div className="h-64 rounded-md border border-[#30363d] bg-[#0d1117] p-3">
            <EloTrendChart points={chartPoints} />
          </div>
        </section>

      </div>
    </section>
  );
}
