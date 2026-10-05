import { CalendarDays, MapPin, Users } from "lucide-react";
import type { ReactNode } from "react";
import { formatV2CompetitionDateTime } from "@/modules/competitions-v2/competition-time";

type Props = Readonly<{
  match: Readonly<{
    title: string;
    description: string | null;
    status: "registration" | "ongoing" | "finished";
    format: string;
    dateTime: string;
    location: string | null;
    registrationDeadline: string;
  }>;
  typeLabel: string;
  participantLabel: string;
  teamSizeLabel?: string;
  children?: ReactNode;
}>;

const statuses = {
  registration: { label: "报名中", color: "bg-amber-400" },
  ongoing: { label: "进行中", color: "bg-emerald-400" },
  finished: { label: "已结束", color: "bg-slate-400" },
};

export default function MatchDetailHeader({
  match,
  typeLabel,
  participantLabel,
  teamSizeLabel,
  children,
}: Props) {
  const status = statuses[match.status];
  return (
    <header className="py-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-medium text-slate-400">
        <span className="inline-flex items-center gap-2 text-slate-200">
          <span className={`h-2 w-2 rounded-full ${status.color}`} />
          {status.label}
        </span>
        <span className="h-3 w-px bg-white/15" aria-hidden="true" />
        <span>
          {typeLabel} ·{" "}
          {match.format === "group_then_knockout"
            ? "小组赛 + 淘汰赛"
            : "小组循环赛"}
        </span>
        {teamSizeLabel ? <span>{teamSizeLabel}</span> : null}
      </div>
      <h1 className="mt-3 break-words text-xl font-semibold leading-snug tracking-tight text-white sm:text-3xl">
        {match.title}
      </h1>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs leading-5 text-slate-400 sm:text-sm">
        <span className="inline-flex items-center gap-2">
          <CalendarDays className="h-4 w-4 shrink-0 text-slate-500" />
          {formatV2CompetitionDateTime(match.dateTime)}
          <span className="text-[10px] text-slate-500">北京时间</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0 text-slate-500" />
          {match.location || "地点待定"}
        </span>
        <span className="inline-flex items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-slate-500" />
          {participantLabel}
        </span>
      </div>
      {match.status === "registration" ? (
        <p className="mt-2 text-xs text-slate-400">
          报名截止 {formatV2CompetitionDateTime(match.registrationDeadline)} ·
          时间均为北京时间
        </p>
      ) : null}
      {match.description ? (
        <details className="mt-3 text-xs text-slate-400">
          <summary className="w-fit cursor-pointer py-1 hover:text-slate-200">
            赛事说明
          </summary>
          <p className="mt-2 max-w-3xl whitespace-pre-line break-words text-sm leading-6">
            {match.description}
          </p>
        </details>
      ) : null}
      {children ? (
        <div className="mt-5 border-t border-white/8 pt-4">{children}</div>
      ) : null}
    </header>
  );
}
