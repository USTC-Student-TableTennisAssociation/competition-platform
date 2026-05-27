import Link from "next/link";
import { cookies } from "next/headers";
import {
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getPendingInviteCountForUser } from "@/lib/doubles";
import AdminModeToggle from "@/components/layout/AdminModeToggle";
import { normalizeAvatarUrl } from "@/lib/utils";
import SidebarNavLink, {
  type SidebarIconKey,
} from "@/components/layout/SidebarNavLink";

const ADMIN_MODE_COOKIE = "ustc_tta_admin_mode";

function resolveAdminMode(raw: string | undefined) {
  return raw === "user" ? "user" : "admin";
}

type NavItem = {
  href: string;
  label: string;
  icon: SidebarIconKey;
};

const navItems: NavItem[] = [
  { href: "/", label: "首页", icon: "home" },
  { href: "/matchs", label: "比赛大厅", icon: "calendar" },
  { href: "/rankings", label: "排行榜", icon: "medal" },
];

export default async function Sidebar() {
  const currentUser = await getCurrentUser();
  const cookieStore = await cookies();
  const adminMode = resolveAdminMode(cookieStore.get(ADMIN_MODE_COOKIE)?.value);
  const adminViewEnabled =
    currentUser?.role === "admin" && adminMode === "admin";

  const pendingInviteCount = currentUser
    ? await getPendingInviteCountForUser(currentUser.id)
    : 0;
  const hasPendingInvites = pendingInviteCount > 0;
  const memberNavItems: NavItem[] = currentUser
    ? [
        { href: "/quick-match", label: "快速比赛", icon: "clock" },
        { href: "/team-invites", label: "组队信息", icon: "mail" },
      ]
    : [];
  const adminNavItems: NavItem[] = adminViewEnabled
    ? [
        { href: "/matchs/create", label: "发布比赛", icon: "plus" },
        { href: "/admin", label: "管理员控制台", icon: "settings" },
      ]
    : [];
  const avatarFallback = (
    currentUser?.nickname?.trim()?.[0] ?? "?"
  ).toUpperCase();
  const avatarUrl = normalizeAvatarUrl(currentUser?.avatarUrl);

  return (
    <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col xl:w-72">
      <div className="flex h-screen w-full flex-col overflow-y-auto border-r border-white/[0.06] bg-[#080B14]/92 px-4 py-5 backdrop-blur-xl xl:px-5 xl:py-6">
        <section className="border-b border-white/[0.06] pb-5">
          <Link href="/" className="flex items-center gap-3 px-1">
            <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-white/[0.035] text-orange-300 ring-1 ring-white/[0.08]">
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-orange-400" />
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[0.08em] text-slate-50">
                USTC TTA
              </p>
              <p className="text-[11px] text-slate-500">校园赛事操作台</p>
            </div>
          </Link>
        </section>

        <section className="mt-5">
          {currentUser ? (
            <Link
              href="/profile"
              className="group flex items-center gap-3 rounded-xl p-2 transition hover:bg-white/[0.035]"
              aria-label="查看个人中心"
            >
              <div className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-orange-400/[0.08] text-sm font-semibold text-orange-100 ring-1 ring-white/[0.08]">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt={currentUser.nickname}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span aria-hidden="true">{avatarFallback}</span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-50">
                  {currentUser.nickname}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">我的竞技档案</p>
              </div>

              <ChevronRight className="h-4 w-4 text-slate-600 transition group-hover:text-orange-300" />
            </Link>
          ) : (
            <div className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.025] p-3">
              <p className="text-sm font-semibold text-slate-100">
                当前状态：待登录
              </p>
              <p className="mt-1 text-xs text-slate-400">
                登录后可报名、发布比赛和编辑个人资料。
              </p>
              <Link
                href="/auth"
                className="btn-secondary mt-3 inline-block rounded-xl px-3 py-1.5 text-xs"
              >
                去登录 / 注册
              </Link>
            </div>
          )}

          {currentUser && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-[#101520]/70 px-3 py-2">
                <p className="text-[11px] text-slate-400">ELO</p>
                <p className="mt-1 text-base font-black tabular-nums text-sky-200">
                  {currentUser.eloRating}
                </p>
              </div>
              <div className="rounded-xl bg-[#101520]/70 px-3 py-2">
                <p className="text-[11px] text-slate-400">积分</p>
                <p className="mt-1 text-base font-black tabular-nums text-slate-100">
                  {currentUser.points}
                </p>
              </div>
            </div>
          )}

          {currentUser?.role === "admin" ? (
            <AdminModeToggle initialMode={adminMode} />
          ) : null}
        </section>

        <nav className="mt-6 space-y-1">
          {navItems.map(({ href, label, icon }) => (
            <SidebarNavLink
              key={href}
              href={href}
              label={label}
              icon={icon}
            />
          ))}
        </nav>

        {memberNavItems.length > 0 ? (
          <nav className="mt-5 border-t border-white/[0.06] pt-5">
            <p className="mb-2 px-3 text-[11px] font-semibold text-slate-600">
              我的赛事
            </p>
            <div className="space-y-1">
              {memberNavItems.map(({ href, label, icon }) => (
                <SidebarNavLink
                  key={href}
                  href={href}
                  label={label}
                  icon={icon}
                  hasAlert={label === "组队信息" && hasPendingInvites}
                />
              ))}
            </div>
          </nav>
        ) : null}

        {adminNavItems.length > 0 ? (
          <nav className="mt-auto border-t border-white/[0.06] pt-5">
            <p className="mb-2 px-3 text-[11px] font-semibold text-slate-600">
              管理
            </p>
            <div className="space-y-1">
              {adminNavItems.map(({ href, label, icon }) => (
                <SidebarNavLink
                  key={href}
                  href={href}
                  label={label}
                  icon={icon}
                />
              ))}
            </div>
          </nav>
        ) : null}
      </div>
    </aside>
  );
}
