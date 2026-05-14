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
    <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col xl:w-72">
      <div className="h-screen w-full overflow-y-auto border-r border-white/8 bg-slate-950/72 px-4 py-5 backdrop-blur-2xl xl:px-5 xl:py-6">
        <section className="surface-card rounded-3xl p-3.5 xl:p-4">
          <Link href="/" className="mb-4 flex items-center gap-3 px-2">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-teal-400/12 text-teal-100 ring-1 ring-teal-300/16">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[0.18em] text-slate-50">
                USTC TTA
              </p>
              <p className="text-[11px] text-slate-500">竞技积分平台</p>
            </div>
          </Link>

          {currentUser ? (
            <Link
              href="/profile"
              className="group flex items-center gap-3 rounded-2xl p-2 transition hover:bg-white/5"
              aria-label="查看个人中心"
            >
              <div className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-teal-400/12 text-sm font-semibold text-teal-100 ring-1 ring-white/10">
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

              <ChevronRight className="h-4 w-4 text-slate-600 transition group-hover:text-teal-200" />
            </Link>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/12 bg-white/[0.03] p-3">
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
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
                <p className="text-[11px] text-slate-400">ELO</p>
                <p className="mt-1 text-base font-black tabular-nums text-teal-100">
                  {currentUser.eloRating}
                </p>
              </div>
              <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
                <p className="text-[11px] text-slate-400">积分</p>
                <p className="mt-1 text-base font-black tabular-nums text-sky-100">
                  {currentUser.points}
                </p>
              </div>
            </div>
          )}

          {currentUser?.role === "admin" ? (
            <AdminModeToggle initialMode={adminMode} />
          ) : null}
        </section>

        <nav className="mt-6 space-y-1.5">
          {resolvedNavItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-slate-300 transition hover:bg-white/[0.055] hover:text-white"
            >
              <Icon className="h-4 w-4 text-slate-500 transition group-hover:text-teal-200" />
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
