import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "ustc_tta_session";
const SITE_STATUS_PATH = "/api/site-status";
const SITE_CLOSED_PATH = "/closed";
const PUBLIC_PATH_PREFIXES = [
  "/auth",
  "/api/csrf-token",
  SITE_STATUS_PATH,
  SITE_CLOSED_PATH,
  "/admin",
];
const PUBLIC_FILE = /\.(.*)$/; // Allows static assets (e.g. images, fonts)

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Skip Next.js internals and static assets early.
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico" || PUBLIC_FILE.test(pathname)) {
    return NextResponse.next();
  }

  // Allow auth and CSRF endpoints for unauthenticated visitors.
  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  let siteClosed = false;
  try {
    const statusUrl = new URL(SITE_STATUS_PATH, request.nextUrl.origin);
    const response = await fetch(statusUrl, { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { isClosed?: boolean };
      siteClosed = Boolean(data?.isClosed);
    }
  } catch (error) {
    console.error("Site status check failed", error);
  }

  if (siteClosed) {
    const closedUrl = request.nextUrl.clone();
    closedUrl.pathname = SITE_CLOSED_PATH;
    closedUrl.search = "";
    return NextResponse.redirect(closedUrl);
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (!hasSession) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/auth";
    loginUrl.searchParams.set("from", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

// Apply middleware to all routes except Next internals and static files.
export const config = {
  matcher: ["/(.*)"],
};