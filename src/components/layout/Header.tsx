"use client";

import Image from "next/image";
import Link from "next/link";
import {
  BarChart3,
  CalendarRange,
  LayoutDashboard,
  Menu,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { normalizeAvatarUrl } from "@/lib/utils";
import AdminModeToggle from "@/components/layout/AdminModeToggle";

type Props = {
  isLoggedIn: boolean;
  currentUser?: {
    nickname: string;
    avatarUrl: string | null;
    eloRating: number;
    role: string;
  } | null;
  adminViewEnabled?: boolean;
  adminMode?: "admin" | "user";
};

export default function Header({
  isLoggedIn,
  currentUser,
  adminViewEnabled = true,
  adminMode = "admin",
}: Props) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const pathname = usePathname();
  const avatarFallback = (
    currentUser?.nickname?.trim()?.[0] ?? "?"
  ).toUpperCase();
  const avatarUrl = !avatarFailed
    ? normalizeAvatarUrl(currentUser?.avatarUrl)
    : null;
  const navItems = [
    { href: "/matchs", label: "比赛大厅", icon: CalendarRange },
    { href: "/rankings", label: "排行榜", icon: BarChart3 },
    {
      href: isLoggedIn ? "/profile" : "/auth",
      label: "我的比赛",
      icon: UserRound,
    },
  ];
  const showAdminEntry = currentUser?.role === "admin" && adminViewEnabled;

  function navClass(href: string) {
    const isActive =
      href === "/" ? pathname === "/" : pathname.startsWith(href);

    return `inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition ${
      isActive
        ? "bg-white/[0.06] text-slate-50"
        : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
    }`;
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[#30363d] bg-[#010409]/94 backdrop-blur-xl">
      <nav className="mx-auto max-w-[1440px] px-3 sm:px-5 md:px-7 xl:px-9">
        <div className="flex h-14 items-center justify-between gap-3">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2.5 font-semibold text-white"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-white/[0.08] bg-white/[0.035]">
              <Image
                src="/SVG/乒协徽章.svg"
                alt="USTC TTA"
                width={28}
                height={28}
                className="h-6 w-6 object-contain"
              />
            </span>
            <span className="truncate text-sm sm:text-base">乒协赛事平台</span>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className={navClass(item.href)}>
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
            {showAdminEntry ? (
              <Link href="/admin" className={navClass("/admin")}>
                <ShieldCheck className="h-4 w-4" />
                管理入口
              </Link>
            ) : null}
          </div>

          <div className="ml-auto hidden items-center gap-2 md:flex">
            {currentUser?.role === "admin" ? (
              <AdminModeToggle initialMode={adminMode} compact />
            ) : null}

            {currentUser ? (
              <Link
                href="/profile"
                className="grid h-9 w-9 place-items-center overflow-hidden rounded-full border border-white/[0.1] bg-[#0d1117] text-sm font-semibold text-orange-100 transition hover:border-orange-300/40"
                aria-label="进入个人主页"
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt={currentUser.nickname}
                    className="h-full w-full object-cover"
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  <span aria-hidden="true">{avatarFallback}</span>
                )}
              </Link>
            ) : (
              <Link
                href="/auth"
                className="btn-primary inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold"
              >
                登录
              </Link>
            )}
          </div>

          <button
            type="button"
            className="btn-secondary rounded-md p-2 text-slate-200 md:hidden"
            aria-label="打开菜单"
            onClick={() => setIsMenuOpen((prev) => !prev)}
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {isMenuOpen && (
          <div className="space-y-2 border-t border-white/[0.06] pb-4 pt-3 md:hidden">
            {currentUser ? (
              <Link
                href="/profile"
                className="flex min-w-0 items-center gap-3 rounded-md bg-[#0d1117] px-3 py-2 ring-1 ring-white/[0.08]"
                onClick={() => setIsMenuOpen(false)}
              >
                <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-orange-400/[0.08] text-sm font-semibold text-orange-100 ring-1 ring-white/[0.08]">
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarUrl}
                      alt={currentUser.nickname}
                      className="h-full w-full object-cover"
                      onError={() => setAvatarFailed(true)}
                    />
                  ) : (
                    <span aria-hidden="true">{avatarFallback}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {currentUser.nickname}
                  </p>
                  <p className="text-xs text-slate-500">个人主页</p>
                </div>
              </Link>
            ) : null}
            {!isLoggedIn && (
              <div className="rounded-md border border-dashed border-white/[0.1] bg-white/[0.025] px-3 py-2 text-xs text-slate-300">
                当前状态：待登录
                <Link href="/auth" className="ml-2 text-orange-300">
                  去登录
                </Link>
              </div>
            )}
            {[{ href: "/", label: "首页", icon: LayoutDashboard }, ...navItems].map((item) => {
              const Icon = item.icon;
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block rounded-2xl px-3 py-2.5 text-sm transition ${
                    isActive
                      ? "bg-orange-400/[0.08] text-orange-100"
                      : "bg-white/[0.035] text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                  }`}
                  onClick={() => setIsMenuOpen(false)}
                >
                  <Icon className="mr-2 inline h-4 w-4 align-[-3px]" />
                  {item.label}
                </Link>
              );
            })}
            {showAdminEntry ? (
              <Link
                href="/admin"
                className="block rounded-2xl bg-white/[0.035] px-3 py-2.5 text-sm text-slate-300 transition hover:bg-white/[0.06] hover:text-slate-100"
                onClick={() => setIsMenuOpen(false)}
              >
                <ShieldCheck className="mr-2 inline h-4 w-4 align-[-3px]" />
                管理入口
              </Link>
            ) : null}
            {currentUser?.role === "admin" ? (
              <AdminModeToggle initialMode={adminMode} compact />
            ) : null}
          </div>
        )}
      </nav>
    </header>
  );
}
