"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Calendar, PencilLine, ShieldCheck, Trophy } from "lucide-react";
import { normalizeAvatarUrl } from "@/lib/utils";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type EloPoint = {
  eloAfter: number;
  createdAt: string;
};

type ChartPoint = {
  index: number;
  elo: number;
  dateLabel: string;
  nthLabel: string;
};

type RecentResult = {
  id: string;
  matchId: string;
  matchTitle: string;
  matchDate: string;
  isWin: boolean;
  scoreText: string;
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
  eloPoints: EloPoint[];
  recentResults: RecentResult[];
  badges: BadgeItem[];
  showEdit?: boolean;
};

export default function ProfileOverview({
  user,
  clubId,
  eloPoints,
  recentResults,
  badges,
  showEdit = true,
}: Props) {
  const [xAxisMode, setXAxisMode] = useState<"date" | "nth">("date");
  const [copied, setCopied] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = !avatarFailed ? normalizeAvatarUrl(user.avatarUrl) : null;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  const chartData = useMemo<ChartPoint[]>(
    () =>
      eloPoints.map((item, index) => ({
        index,
        elo: item.eloAfter,
        dateLabel: new Date(item.createdAt).toLocaleDateString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
        }),
        nthLabel: `第${index + 1}场`,
      })),
    [eloPoints],
  );

  const getXAxisLabel = (value: number) => {
    const point = chartData[value];
    if (!point) return "";
    return xAxisMode === "date" ? point.dateLabel : point.nthLabel;
  };

  const latestElo =
    chartData.length > 0 ? chartData[chartData.length - 1].elo : user.eloRating;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-700/70 bg-slate-900/75 p-4 sm:space-y-6 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-full bg-slate-700 text-xl font-bold text-cyan-100 sm:h-20 sm:w-20 sm:text-3xl">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={`${user.nickname}头像`}
                className="h-full w-full object-cover"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              user.nickname[0]
            )}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-white sm:text-2xl">
              {user.nickname}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="inline-flex items-center rounded-md border border-cyan-400/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-cyan-100 sm:px-2.5 sm:py-1 sm:text-xs">
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
                className="rounded-md border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800 sm:px-2.5 sm:py-1 sm:text-xs"
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <p className="mt-1 hidden max-w-xl text-sm text-slate-300 sm:block">
              {user.bio || "这个人很神秘，还没有留下个人描述。"}
            </p>
          </div>
        </div>

        {showEdit ? (
          <Link
            href="/profile/edit"
            className="relative z-10 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-3 py-1.5 text-xs font-semibold text-white sm:gap-2 sm:px-4 sm:py-2 sm:text-sm"
          >
            <PencilLine className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            编辑资料
          </Link>
        ) : null}
      </div>

      <>
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 px-2 py-2 text-center sm:px-4 sm:py-3">
            <p className="text-[10px] text-slate-400 sm:text-xs">ELO</p>
            <p className="mt-1 text-base font-bold text-cyan-100 sm:text-xl">
              {user.eloRating}
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 px-2 py-2 text-center sm:px-4 sm:py-3">
            <p className="text-[10px] text-slate-400 sm:text-xs">积分</p>
            <p className="mt-1 text-base font-bold text-cyan-100 sm:text-xl">
              {user.points}
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 px-2 py-2 text-center sm:px-4 sm:py-3">
            <p className="text-[10px] text-slate-400 sm:text-xs">胜场</p>
            <p className="mt-1 text-base font-bold text-emerald-300 sm:text-xl">
              {user.wins}
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 px-2 py-2 text-center sm:px-4 sm:py-3">
            <p className="text-[10px] text-slate-400 sm:text-xs">败场</p>
            <p className="mt-1 text-base font-bold text-rose-300 sm:text-xl">
              {user.losses}
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" />
                ELO 曲线
              </span>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-slate-700 bg-slate-800/70 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setXAxisMode("date")}
                    className={`rounded-md px-2 py-1 transition ${
                      xAxisMode === "date"
                        ? "bg-cyan-500/20 text-cyan-200"
                        : "text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    日期
                  </button>
                  <button
                    type="button"
                    onClick={() => setXAxisMode("nth")}
                    className={`rounded-md px-2 py-1 transition ${
                      xAxisMode === "nth"
                        ? "bg-cyan-500/20 text-cyan-200"
                        : "text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    第N场
                  </button>
                </div>
                <span>当前 ELO：{latestElo}</span>
              </div>
            </div>
            <div className="h-52 w-full">
              {chartData.length === 0 ? (
                <div className="grid h-full place-items-center text-sm text-slate-400">
                  暂无曲线数据
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid
                      stroke="rgba(148,163,184,0.2)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="index"
                      type="number"
                      tick={{ fill: "rgb(148 163 184)", fontSize: 11 }}
                      axisLine={{ stroke: "rgba(148,163,184,0.35)" }}
                      tickLine={{ stroke: "rgba(148,163,184,0.35)" }}
                      domain={[0, Math.max(chartData.length - 1, 0)]}
                      allowDecimals={false}
                      tickFormatter={getXAxisLabel}
                      minTickGap={18}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      width={42}
                      tick={{ fill: "rgb(148 163 184)", fontSize: 11 }}
                      axisLine={{ stroke: "rgba(148,163,184,0.35)" }}
                      tickLine={{ stroke: "rgba(148,163,184,0.35)" }}
                      tickFormatter={(value: number) => `${value}`}
                      domain={[
                        (dataMin: number) =>
                          Math.floor((dataMin - 10) / 10) * 10,
                        (dataMax: number) =>
                          Math.ceil((dataMax + 10) / 10) * 10,
                      ]}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "rgb(15 23 42)",
                        border: "1px solid rgb(51 65 85)",
                        borderRadius: "0.75rem",
                        color: "rgb(226 232 240)",
                        fontSize: isMobile ? "11px" : "12px",
                        padding: isMobile ? "6px 8px" : "10px 12px",
                        maxWidth: isMobile ? "160px" : "220px",
                      }}
                      labelStyle={{
                        color: "rgb(148 163 184)",
                        fontSize: isMobile ? "10px" : "12px",
                        marginBottom: isMobile ? "2px" : "4px",
                      }}
                      itemStyle={{
                        color: "rgb(226 232 240)",
                        fontSize: isMobile ? "11px" : "12px",
                        padding: 0,
                        margin: 0,
                      }}
                      wrapperStyle={{ zIndex: 20 }}
                      labelFormatter={(value, payload) => {
                        const point = payload?.[0]?.payload as
                          | ChartPoint
                          | undefined;
                        if (!point) return "";
                        return xAxisMode === "date"
                          ? `日期：${point.dateLabel}`
                          : point.nthLabel;
                      }}
                      formatter={(value: number) => [`${value}`, "ELO"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="elo"
                      name="ELO"
                      stroke="rgb(34,211,238)"
                      strokeWidth={3}
                      dot={{ r: 3, fill: "rgb(34,211,238)" }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-white">
              <Trophy className="h-4 w-4 text-amber-300" />
              最近比赛成绩
            </h3>
            <div className="space-y-2">
              {recentResults.length === 0 ? (
                <p className="text-sm text-slate-400">暂无已确认比赛成绩。</p>
              ) : (
                recentResults.map((result) => (
                  <Link
                    key={result.id}
                    href={`/matchs/${result.matchId}`}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:border-cyan-400/45"
                  >
                    <div>
                      <p className="font-medium">{result.matchTitle}</p>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-400">
                        <Calendar className="h-3.5 w-3.5" />
                        {new Date(result.matchDate).toLocaleDateString("zh-CN")}
                      </p>
                      {result.scoreText ? (
                        <p className="mt-0.5 text-xs text-slate-400">
                          比分：{result.scoreText}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={
                        result.isWin ? "text-emerald-300" : "text-rose-300"
                      }
                    >
                      {result.isWin ? "胜" : "负"}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
          <h3 className="mb-3 text-sm font-semibold text-white">徽章</h3>
          {badges.length === 0 ? (
            <p className="text-sm text-slate-400">
              暂无徽章，继续参加比赛和活动来解锁。
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {badges.map((badge) => (
                <div
                  key={badge.id}
                  className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2"
                >
                  <p className="text-sm font-medium text-amber-200">
                    {badge.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {badge.description || "荣誉徽章"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    </section>
  );
}
