import type { Metadata, Viewport } from "next";
import "./globals.css";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import Sidebar from "@/components/layout/Sidebar";
import CsrfFormInjector from "@/components/security/CsrfFormInjector";
import { getCurrentUser } from "@/lib/auth";
import { cookies } from "next/headers";

const ADMIN_MODE_COOKIE = "ustc_tta_admin_mode";

export const metadata: Metadata = {
  title: "USTC TTA",
  description:
    "科大校学生乒乓球协会平台，用于科大校内比赛的乒乓球竞技平台，记录每一次精彩对决，见证你的成长",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: "/SVG/乒协徽章.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const currentUser = await getCurrentUser();
  const cookieStore = await cookies();
  const adminMode = cookieStore.get(ADMIN_MODE_COOKIE)?.value;
  const resolvedAdminMode = adminMode === "user" ? "user" : "admin";
  const adminViewEnabled = resolvedAdminMode !== "user";

  return (
    <html lang="zh-CN" className="overflow-x-hidden">
      <body className="min-h-screen overflow-x-hidden bg-slate-950 text-slate-100">
        <CsrfFormInjector />
        <div className="min-h-screen min-w-0">
          <Sidebar />
          <div className="flex min-h-screen min-w-0 flex-col md:pl-64 xl:pl-72">
            <Header
              isLoggedIn={Boolean(currentUser)}
              adminViewEnabled={adminViewEnabled}
              adminMode={resolvedAdminMode}
              currentUser={
                currentUser
                  ? {
                      nickname: currentUser.nickname,
                      avatarUrl: currentUser.avatarUrl,
                      eloRating: currentUser.eloRating,
                      role: currentUser.role,
                    }
                  : null
              }
            />
            <main className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-3 py-4 sm:px-5 sm:py-6 md:px-7 md:py-8 xl:px-10">
              {children}
            </main>
            <Footer />
          </div>
        </div>
      </body>
    </html>
  );
}
