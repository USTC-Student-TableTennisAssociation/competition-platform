"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  CalendarRange,
  Clock3,
  Home,
  Mail,
  Medal,
  PlusSquare,
  Settings2,
} from "lucide-react";

export type SidebarIconKey =
  | "home"
  | "calendar"
  | "medal"
  | "clock"
  | "mail"
  | "plus"
  | "settings";

const iconMap = {
  home: Home,
  calendar: CalendarRange,
  medal: Medal,
  clock: Clock3,
  mail: Mail,
  plus: PlusSquare,
  settings: Settings2,
} satisfies Record<SidebarIconKey, ComponentType<{ className?: string }>>;

type SidebarNavLinkProps = {
  href: string;
  label: string;
  icon: SidebarIconKey;
  hasAlert?: boolean;
};

export default function SidebarNavLink({
  href,
  label,
  icon,
  hasAlert = false,
}: SidebarNavLinkProps) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
  const Icon = iconMap[icon];

  return (
    <Link
      href={href}
      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        isActive
          ? "bg-orange-400/[0.08] text-slate-50"
          : "text-slate-400 hover:bg-white/[0.035] hover:text-slate-100"
      }`}
    >
      <span
        className={`absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full transition ${
          isActive ? "bg-orange-400 opacity-100" : "bg-orange-400 opacity-0"
        }`}
      />
      <Icon
        className={`h-4 w-4 transition ${
          isActive ? "text-orange-300" : "text-slate-500 group-hover:text-orange-300"
        }`}
      />
      <span className="font-medium">{label}</span>
      {hasAlert ? (
        <span
          className="ml-auto inline-flex h-2.5 w-2.5 rounded-full bg-orange-400"
          aria-label="有新的组队邀请"
        />
      ) : null}
    </Link>
  );
}
