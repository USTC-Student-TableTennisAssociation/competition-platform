import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isPublicRoute, isRouteWithin } from './lib/route-access'
import { SESSION_COOKIE_NAME, verifySessionToken } from './lib/session'
import { isLocalSupermarketDatabase } from './lib/server/supermarket/image-policy'
import { prisma } from './lib/prisma'

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (isPublicRoute(pathname)) return NextResponse.next()

  // The review-only catalog must never become a deployed endpoint.
  if (isRouteWithin(pathname, '/supermarket/preview') &&
      (process.env.NODE_ENV !== 'development' || !isLocalSupermarketDatabase())) {
    return new NextResponse(null, { status: 404 })
  }

  const rawSession = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!rawSession || !verifySessionToken(rawSession)) {
    if (isRouteWithin(pathname, '/api')) {
      return NextResponse.json({ error: '请先登录。' }, { status: 401 })
    }
    const loginUrl = new URL('/auth', request.url)
    loginUrl.searchParams.set('from', `${pathname}${search}`)
    return NextResponse.redirect(loginUrl)
  }

  // Admin pages retain their own role/reauth checks and remain accessible
  // during maintenance so an authenticated administrator can reopen the site.
  if (!isRouteWithin(pathname, '/admin')) {
    try {
      // Forwarded HTTPS describes the public connection, while the standalone
      // server listens on HTTP. Read directly rather than making a TLS self-call.
      const setting = await prisma.siteSetting.findUnique({
        where: { id: 1 }, select: { isClosed: true },
      })
      if (setting?.isClosed) return NextResponse.redirect(new URL('/closed', request.url))
    } catch (error) {
      console.error('Site maintenance status check failed', error)
      return new NextResponse('站点状态暂时无法确认，请稍后重试。', { status: 503 })
    }
  }

  // Signature verification is an entry filter. Data readers and actions must
  // still check the live user, including bans, verification and revocation.
  return NextResponse.next()
}

export const config = { matcher: ['/(.*)'] }
