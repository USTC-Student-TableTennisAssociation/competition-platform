import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'ustc_tta_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

type SessionPayload = {
  userId: string
  sessionVersion: number
  expiresAtMs: number
  authStamp: string
}

function getSessionSecret() {
  return process.env.AUTH_SECRET ?? null
}

function signPayload(payload: string) {
  const secret = getSessionSecret()
  if (!secret) return null
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function createSessionAuthStamp(userId: string, hashedPassword: string | null | undefined) {
  const secret = getSessionSecret()
  if (!secret || !hashedPassword) return null
  return createHmac('sha256', secret)
    .update(`${userId}.${hashedPassword}`)
    .digest('hex')
}

export function shouldUseSecureCookies() {
  return process.env.NODE_ENV === 'production'
}

export function createSessionToken(
  userId: string,
  hashedPassword: string | null | undefined,
  sessionVersion: number,
) {
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1000
  const nonce = randomBytes(16).toString('hex')
  const authStamp = createSessionAuthStamp(userId, hashedPassword)
  if (!authStamp) return null
  const payload = `${userId}.${sessionVersion}.${expiresAtMs}.${nonce}.${authStamp}`
  const signature = signPayload(payload)
  if (!signature) return null
  return `${payload}.${signature}`
}

export function verifySessionToken(rawValue: string): SessionPayload | null {
  if (!getSessionSecret()) return null

  const parts = rawValue.split('.')
  const isLegacyToken = parts.length === 5
  if (!isLegacyToken && parts.length !== 6) return null

  const [userId, sessionVersionRaw, expiresAtRaw, nonce, authStamp, signature] =
    isLegacyToken
      ? [parts[0], '0', parts[1], parts[2], parts[3], parts[4]]
      : parts
  if (!userId || !sessionVersionRaw || !expiresAtRaw || !nonce || !authStamp || !signature) return null
  if (!/^[0-9a-f]{64}$/i.test(authStamp)) return null

  const sessionVersion = Number(sessionVersionRaw)
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null

  const expiresAtMs = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null

  const payload = isLegacyToken
    ? `${userId}.${expiresAtMs}.${nonce}.${authStamp}`
    : `${userId}.${sessionVersion}.${expiresAtMs}.${nonce}.${authStamp}`
  const expectedSignature = signPayload(payload)
  if (!expectedSignature) return null
  const actualBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expectedSignature, 'hex')

  if (actualBuffer.length !== expectedBuffer.length) return null
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null

  return {
    userId,
    sessionVersion,
    expiresAtMs,
    authStamp,
  }
}

export function safeEqualHex(left: string, right: string) {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}
