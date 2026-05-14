"use client";

import Link from "next/link";
import { Menu, Trophy, X } from "lucide-react";
import { useState } from "react";
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
  const avatarFallback = (
    currentUser?.nickname?.trim()?.[0] ?? "?"
  ).toUpperCase();
  const avatarUrl = !avatarFailed
    ? normalizeAvatarUrl(currentUser?.avatarUrl)
    : null;
  const mobileNav = [
    { href: "/", label: "首页" },
    { href: "/matchs", label: "比赛大厅" },
    { href: "/rankings", label: "排行榜" },
    ...(isLoggedIn ? [{ href: "/quick-match", label: "快速比赛" }] : []),
    ...(isLoggedIn ? [{ href: "/team-invites", label: "组队信息" }] : []),
    ...(currentUser?.role === "admin" && adminViewEnabled
      ? [{ href: "/matchs/create", label: "发布比赛" }]
      : []),
    ...(currentUser?.role === "admin" && adminViewEnabled
      ? [{ href: "/admin", label: "管理员控制台" }]
      : []),
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-white/8 bg-slate-950/82 backdrop-blur-2xl md:hidden">
      <nav className="mx-auto max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 font-black tracking-[0.14em] text-white"
          >
            <Trophy className="h-5 w-5 text-teal-200" />
            <span>USTC TTA</span>
          </Link>

          <button
            type="button"
            className="btn-secondary rounded-xl p-2 text-slate-200"
            aria-label="打开菜单"
            onClick={() => setIsMenuOpen((prev) => !prev)}
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {currentUser && (
          <div className="mb-3 flex items-center gap-2">
            <Link
              href="/profile"
              className="surface-card flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2"
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-teal-400/12 text-sm font-semibold text-teal-100 ring-1 ring-white/10">
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
                <p className="text-xs text-teal-200">
                  ELO {currentUser.eloRating}
                </p>
              </div>
            </Link>

            {currentUser.role === "admin" ? (
              <AdminModeToggle
                initialMode={adminMode}
                compact
                className="shrink-0"
              />
            ) : null}
          </div>
        )}

        {isMenuOpen && (
          <div className="space-y-2 pb-4">
            {!isLoggedIn && (
              <div className="rounded-2xl border border-dashed border-white/12 bg-white/[0.03] px-3 py-2 text-xs text-slate-300">
                当前状态：待登录
                <Link href="/auth" className="ml-2 text-teal-200">
                  去登录
                </Link>
              </div>
            )}
            {mobileNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-2xl bg-white/[0.045] px-3 py-2.5 text-sm text-slate-200 transition hover:bg-white/8"
                onClick={() => setIsMenuOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </div>
        )}
      </nav>
    </header>
  );
}
