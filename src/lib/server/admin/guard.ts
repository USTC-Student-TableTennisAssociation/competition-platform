import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { shouldUseSecureCookies } from '@/lib/session'

export const ADMIN_REAUTH_COOKIE = 'ustc_tta_admin_reauth'
export const ADMIN_TRUSTED_DEVICE_COOKIE = 'ustc_tta_admin_trusted_device'
export const ADMIN_REAUTH_TTL_SECONDS = 60 * 30

function getReauthSecret() {
  const secret = process.env.ADMIN_REAUTH_SECRET ?? process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('缺少 ADMIN_REAUTH_SECRET 或 AUTH_SECRET，无法进行管理员二次验证。')
  }
  return secret
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function signReauthValue(userId: string, expiresAtMs: number) {
  const payload = `${userId}.${expiresAtMs}`
  const sig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifyReauthValue(rawValue: string, userId: string) {
  const [cookieUserId, expiresAtRaw, sig] = rawValue.split('.')
  if (!cookieUserId || !expiresAtRaw || !sig) return false
  if (cookieUserId !== userId) return false

  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false

  const payload = `${cookieUserId}.${expiresAt}`
  const expectedSig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  const sigBuffer = Buffer.from(sig, 'hex')
  const expectedBuffer = Buffer.from(expectedSig, 'hex')

  if (sigBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(sigBuffer, expectedBuffer)
}

/**
 * Resolves the acting admin from the session, never from client input. Returns
 * a discriminated result so callers can surface the reason without throwing.
 */
export async function getAdminIdentity() {
  const currentUser = await getCurrentUser()
  if (!currentUser || currentUser.role !== 'admin') {
    return { ok: false as const, error: '仅管理员可执行该操作。' }
  }
  return { ok: true as const, userId: currentUser.id }
}

/**
 * The same email-challenge reauth used by the main admin console. The cookie is
 * scoped to /admin, so unlocking there also unlocks every admin sub-page.
 */
export async function isAdminReauthed(userId: string) {
  const cookieStore = await cookies()
  const raw = cookieStore.get(ADMIN_REAUTH_COOKIE)?.value
  if (raw && verifyReauthValue(raw, userId)) return true

  const rawTrustedToken = cookieStore.get(ADMIN_TRUSTED_DEVICE_COOKIE)?.value
  if (!rawTrustedToken) return false
  if (!/^[0-9a-f]{64}$/i.test(rawTrustedToken)) return false

  const now = new Date()
  const tokenHash = hashToken(rawTrustedToken.toLowerCase())
  const record = await prisma.adminTrustedDevice.findFirst({
    where: {
      userId,
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  })

  if (!record) return false

  // Record the use, but never let it fail or delay the auth decision.
  prisma.adminTrustedDevice
    .update({
      where: { id: record.id },
      data: { lastUsedAt: now },
    })
    .catch(() => {})

  return true
}

export async function issueAdminReauth(userId: string) {
  const cookieStore = await cookies()
  const expiresAt = Date.now() + ADMIN_REAUTH_TTL_SECONDS * 1000
  cookieStore.set(ADMIN_REAUTH_COOKIE, signReauthValue(userId, expiresAt), {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/admin',
    maxAge: ADMIN_REAUTH_TTL_SECONDS,
  })
}
