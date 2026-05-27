import Link from "next/link";
import { CalendarDays, Clock3, MapPin, Users } from "lucide-react";

interface MatchCardProps {
  id: string;
  title: string;
  type: "single" | "double" | "team";
  matchTime: string;
  registrationDeadline: string;
  location: string;
  participants: number;
  status: "报名中" | "进行中" | "已结束";
}

function formatMatchDateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      dateText: value,
      weekText: "周-",
      timeText: "--:--",
      fullText: value,
    };
  }

  const weekMap = ["日", "一", "二", "三", "四", "五", "六"];
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const week = weekMap[date.getDay()];
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return {
    dateText: `${year}年${month}月${day}日`,
    weekText: `周${week}`,
    timeText: `${hour}:${minute}`,
    fullText: `${year}年${month}月${day}日（周${week}） ${hour}:${minute}`,
  };
}

export default function MatchCard({
  id,
  title,
  type,
  matchTime,
  registrationDeadline,
  location,
  participants,
  status,
}: MatchCardProps) {
  const matchTimeParts = formatMatchDateParts(matchTime);
  const deadlineParts = formatMatchDateParts(registrationDeadline);

  const statusStyles = {
    报名中: {
      badge: "bg-emerald-400/12 text-emerald-100 ring-1 ring-emerald-300/18",
      accent: "from-emerald-300/65 to-teal-300/20",
      action: "立即报名",
      muted: "",
    },
    进行中: {
      badge: "bg-sky-400/12 text-sky-100 ring-1 ring-sky-300/18",
      accent: "from-sky-300/65 to-cyan-300/20",
      action: "查看赛程",
      muted: "",
    },
    已结束: {
      badge: "bg-slate-500/12 text-slate-300 ring-1 ring-slate-300/12",
      accent: "from-slate-500/40 to-slate-600/10",
      action: "查看记录",
      muted: "opacity-72 hover:opacity-100",
    },
  };

  const typeLabelMap = {
    single: "单打",
    double: "双打",
    team: "团体",
  } as const;

  return (
    <Link
      href={`/matchs/${id}`}
      className={`group surface-panel relative overflow-hidden rounded-3xl p-4 text-white transition duration-200 hover:-translate-y-0.5 hover:border-teal-200/28 sm:p-5 ${statusStyles[status].muted}`}
    >
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-1 bg-linear-to-r ${statusStyles[status].accent}`}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(45,212,191,0.1),transparent_42%)] opacity-80" />

      <div className="relative flex h-full flex-col">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`status-pill ${statusStyles[status].badge}`}
            >
              {status}
            </span>
            <span className="status-pill bg-white/[0.045] text-slate-300 ring-1 ring-white/10">
              {typeLabelMap[type]}
            </span>
          </div>
          <span className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-400 transition group-hover:text-teal-100">
            {statusStyles[status].action}
          </span>
        </div>

        <h3 className="line-clamp-2 min-h-[3rem] text-lg font-black leading-snug text-white/95 sm:text-xl">
          {title}
        </h3>

        <div className="mt-4 rounded-2xl bg-slate-950/35 p-3 ring-1 ring-white/8">
          <div className="flex items-center gap-3" title={matchTimeParts.fullText}>
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-400/10 text-teal-100 ring-1 ring-teal-200/10">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-100">
                {matchTimeParts.dateText}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {matchTimeParts.weekText} · {matchTimeParts.timeText}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 text-xs sm:text-sm">
          <div className="rounded-2xl bg-white/[0.035] p-3 ring-1 ring-white/8">
            <div className="mb-2 flex items-center gap-1.5 text-slate-500">
              <Clock3 className="h-3.5 w-3.5" />
              <span>截止</span>
            </div>
            <p className="truncate font-medium text-slate-200" title={deadlineParts.fullText}>
              {deadlineParts.weekText} {deadlineParts.timeText}
            </p>
          </div>

          <div className="rounded-2xl bg-white/[0.035] p-3 ring-1 ring-white/8">
            <div className="mb-2 flex items-center gap-1.5 text-slate-500">
              <Users className="h-3.5 w-3.5" />
              <span>{type === "double" ? "组数" : "人数"}</span>
            </div>
            <p className="font-black tabular-nums text-slate-100">
              {type === "double"
                ? `${Math.floor(participants / 2)} 组`
                : `${participants} 人`}
            </p>
          </div>

          <div className="col-span-2 flex items-center gap-2 rounded-2xl bg-white/[0.025] p-3 text-slate-300 ring-1 ring-white/8">
            <MapPin className="h-4 w-4 shrink-0 text-slate-500" />
            <p className="truncate" title={location}>
              {location}
            </p>
          </div>
        </div>
      </div>
    </Link>
  );
}
