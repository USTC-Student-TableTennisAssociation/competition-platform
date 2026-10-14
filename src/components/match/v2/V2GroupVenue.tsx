import { MapPin } from "lucide-react";
import { readGroupVenueAssignment } from "@/modules/competitions-v2/domain/group-venue";

export default function V2GroupVenue({
  labels,
  showUnassigned = false,
  className = "",
}: Readonly<{
  labels: readonly string[];
  showUnassigned?: boolean;
  className?: string;
}>) {
  const assignment = readGroupVenueAssignment(labels);
  const { venue, venues, conflicting, tableLabels } = assignment;
  const showBadge = Boolean(venue) || conflicting || showUnassigned;
  if (!showBadge && tableLabels.length === 0) return null;

  const badgeLabel = conflicting
    ? "校区待确认"
    : venue === "东区乒乓球馆"
      ? "东区"
      : venue === "西区乒乓球馆"
        ? "西区"
        : "校区待安排";
  const badgeStyle = conflicting
    ? "border-amber-400/20 bg-amber-500/10 text-amber-200"
    : venue === "东区乒乓球馆"
      ? "border-sky-400/20 bg-sky-500/10 text-sky-200"
      : venue === "西区乒乓球馆"
        ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-200"
        : "border-white/10 bg-white/[0.03] text-slate-400";

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${className}`}>
      {showBadge ? (
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 leading-none ${badgeStyle}`}
          title={conflicting ? `历史场地：${venues.join("、")}` : venue ?? undefined}
        >
          <MapPin size={12} aria-hidden="true" />
          {venue ? <span className="sr-only">校区：</span> : null}
          {badgeLabel}
          {venue ? <span className="sr-only">乒乓球馆</span> : null}
          {conflicting ? (
            <span className="sr-only">，历史场地包含{venues.join("、")}</span>
          ) : null}
        </span>
      ) : null}
      {tableLabels.length ? (
        <span className="min-w-0 break-words leading-5 text-slate-400">
          {tableLabels.join("、")}
        </span>
      ) : null}
    </span>
  );
}
