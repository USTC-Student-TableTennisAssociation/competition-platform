import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'
import {
  createSessionAuthStamp,
  safeEqualHex,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from '@/lib/session'

export async function getCurrentUser() {
  const cookieStore = await cookies()
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value

  if (!rawSession) {
    return null
  }

  let session = null
  try {
    session = verifySessionToken(rawSession)
  } catch (error) {
    console.error('getCurrentUser failed to verify session token', error)
    return null
  }

  if (!session) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      nickname: true,
      bio: true,
      avatarUrl: true,
      points: true,
      eloRating: true,
      wins: true,
      losses: true,
      matchesPlayed: true,
      role: true,
      emailVerifiedAt: true,
      isBanned: true,
      hashedPassword: true,
    },
  })

  if (!user?.emailVerifiedAt || user.isBanned) {
    return null
  }

  const expectedAuthStamp = createSessionAuthStamp(user.id, user.hashedPassword)
  if (!expectedAuthStamp || !safeEqualHex(session.authStamp, expectedAuthStamp)) {
    return null
  }

  // Keep sensitive account state out of component props and action callers.
  const { hashedPassword, isBanned, ...safeUser } = user
  void hashedPassword
  void isBanned
  return safeUser
}
