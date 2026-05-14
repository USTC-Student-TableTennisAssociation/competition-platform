"use client";

import Link from "next/link";
import { Menu, Trophy } from "lucide-react";
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
    <header className="sticky top-0 z-50 border-b border-slate-700/70 bg-slate-900/90 backdrop-blur-xl lg:hidden">
      <nav className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 font-bold text-white"
          >
            <Trophy className="text-cyan-300" />
            <span>USTC TTA</span>
          </Link>

          <button
            type="button"
            className="rounded-lg border border-slate-600 p-2 text-slate-200"
            aria-label="打开菜单"
            onClick={() => setIsMenuOpen((prev) => !prev)}
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>

        {currentUser && (
          <div className="mb-3 flex items-center gap-2">
            <Link
              href="/profile"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-cyan-400/25 bg-slate-800/70 px-3 py-2"
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-100 ring-1 ring-cyan-400/25">
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
                <p className="text-xs text-cyan-200">
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
              <div className="rounded-lg border border-dashed border-slate-600 bg-slate-800/50 px-3 py-2 text-xs text-slate-300">
                当前状态：待登录
                <Link href="/auth" className="ml-2 text-cyan-300">
                  去登录
                </Link>
              </div>
            )}
            {mobileNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-200"
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
