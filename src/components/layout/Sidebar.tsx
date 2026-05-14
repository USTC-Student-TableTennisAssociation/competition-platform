import Link from "next/link";
import { cookies } from "next/headers";
import {
  ShieldCheck,
  CalendarRange,
  ChevronRight,
  Clock3,
  Home,
  Mail,
  Medal,
  PlusSquare,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getPendingInviteCountForUser } from "@/lib/doubles";
import AdminModeToggle from "@/components/layout/AdminModeToggle";
import { normalizeAvatarUrl } from "@/lib/utils";

const ADMIN_MODE_COOKIE = "ustc_tta_admin_mode";

function resolveAdminMode(raw: string | undefined) {
  return raw === "user" ? "user" : "admin";
}

const navItems = [
  { href: "/", label: "首页", icon: Home },
  { href: "/matchs", label: "比赛大厅", icon: CalendarRange },
  { href: "/rankings", label: "排行榜", icon: Medal },
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
  const resolvedNavItems = adminViewEnabled
    ? [
        ...navItems,
        { href: "/quick-match", label: "快速比赛", icon: Clock3 },
        { href: "/team-invites", label: "组队信息", icon: Mail },
        { href: "/matchs/create", label: "发布比赛", icon: PlusSquare },
        { href: "/admin", label: "管理员控制台", icon: ShieldCheck },
      ]
    : currentUser
      ? [
          ...navItems,
          { href: "/quick-match", label: "快速比赛", icon: Clock3 },
          { href: "/team-invites", label: "组队信息", icon: Mail },
        ]
      : navItems;
  const avatarFallback = (
    currentUser?.nickname?.trim()?.[0] ?? "?"
  ).toUpperCase();
  const avatarUrl = normalizeAvatarUrl(currentUser?.avatarUrl);

  return (
    <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-72 md:flex-col">
      <div className="h-screen w-full overflow-y-auto border-r border-slate-700/70 bg-slate-900/90 px-5 py-6 backdrop-blur-xl">
        <section className="rounded-2xl border border-slate-700/70 bg-slate-950/20 p-4">
          {currentUser ? (
            <Link
              href="/profile"
              className="group flex items-center gap-3 rounded-xl border border-transparent p-2 transition hover:border-cyan-400/30 hover:bg-slate-800/40"
              aria-label="查看个人中心"
            >
              <div className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-100 ring-1 ring-cyan-400/25">
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
                <p className="mt-0.5 text-xs text-slate-400">我的主页</p>
              </div>

              <ChevronRight className="h-4 w-4 text-slate-500 transition group-hover:text-slate-200" />
            </Link>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-600 bg-slate-800/40 p-3">
              <p className="text-sm font-semibold text-slate-100">
                当前状态：待登录
              </p>
              <p className="mt-1 text-xs text-slate-400">
                登录后可报名、发布比赛和编辑个人资料。
              </p>
              <Link
                href="/auth"
                className="mt-3 inline-block rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/30"
              >
                去登录 / 注册
              </Link>
            </div>
          )}

          {currentUser && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-700/60 bg-slate-950/30 px-3 py-2">
                <p className="text-[11px] text-slate-400">ELO</p>
                <p className="mt-1 text-base font-bold tabular-nums text-slate-100">
                  {currentUser.eloRating}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/60 bg-slate-950/30 px-3 py-2">
                <p className="text-[11px] text-slate-400">积分</p>
                <p className="mt-1 text-base font-bold tabular-nums text-slate-100">
                  {currentUser.points}
                </p>
              </div>
            </div>
          )}

          {currentUser?.role === "admin" ? (
            <AdminModeToggle initialMode={adminMode} />
          ) : null}
        </section>

        <nav className="mt-6 space-y-2">
          {resolvedNavItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-slate-200 transition hover:border-cyan-400/40 hover:bg-slate-800/70 hover:text-white"
            >
              <Icon className="h-4 w-4 text-cyan-300 transition group-hover:scale-105" />
              <span className="text-sm font-medium">{label}</span>
              {label === "组队信息" && hasPendingInvites ? (
                <span
                  className="ml-auto inline-flex h-2.5 w-2.5 rounded-full bg-rose-400"
                  aria-label="有新的组队邀请"
                />
              ) : null}
            </Link>
          ))}
        </nav>
      </div>
    </aside>
  );
}
